import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { existsSync, readFileSync } from "node:fs";
import { db } from "@/db";
import { computeLedger } from "./ledger";
import {
  aiChatMessages,
  aiDecisions,
  botLogs,
  cashAdjustments,
  marketSnapshots,
  portfolios,
  positions,
  seenTrades,
  settings,
  strategyConfigs,
  verifiedWallets,
  whales,
  type PortfolioRow,
  type PositionRow,
  type Settings,
  type StrategyConfigRow,
  type Whale,
} from "@/db/schema";
import { DEFAULT_STRATEGY, type Strategy, type TradingMode } from "./types";

// ── Дефолтные киты (создаются при первом запуске) ────────────────────────────
const DEFAULT_WHALES = [
  { address: "0x3506e2cefc634ce4c0d0d88d82e7332a81ddca56", name: "🎮 Esports LoL Sniper", category: "LoL" },
  { address: "0x5ab7405670b6477247ddd5feeca3eb5e8d3bd431", name: "🎾 US Open Sharp Tennis", category: "Tennis" },
];

// ── Settings ─────────────────────────────────────────────────────────────────

export async function getSettings(): Promise<Settings> {
  const rows = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);
  if (rows[0]) return rows[0];
  const inserted = await db.insert(settings).values({ id: 1 }).onConflictDoNothing().returning();
  if (inserted[0]) return inserted[0];
  const again = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);
  return again[0];
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  await getSettings();
  const clean = { ...patch } as Record<string, unknown>;
  delete clean.id;
  const rows = await db
    .update(settings)
    .set({ ...(clean as Partial<Settings>), updatedAt: new Date() })
    .where(eq(settings.id, 1))
    .returning();
  return rows[0];
}

// ── Whales ───────────────────────────────────────────────────────────────────

export async function ensureDefaultWhales(): Promise<void> {
  const count = await db.select({ n: sql<number>`count(*)` }).from(whales);
  if (Number(count[0]?.n ?? 0) > 0) return;
  await db.insert(whales).values(DEFAULT_WHALES).onConflictDoNothing();
}

export async function listWhales(): Promise<Whale[]> {
  await ensureDefaultWhales();
  return db.select().from(whales).orderBy(whales.id);
}

export async function createWhale(data: {
  address: string;
  name: string;
  category?: string;
  strategy?: Partial<Strategy>;
  notes?: string;
  enabled?: boolean;
}): Promise<Whale> {
  const rows = await db
    .insert(whales)
    .values({
      address: data.address.trim().toLowerCase(),
      name: data.name.trim() || `Whale ${data.address.slice(0, 8)}`,
      category: data.category?.trim() || "Other",
      strategy: data.strategy ?? {},
      notes: data.notes ?? "",
      enabled: data.enabled ?? true,
    })
    .returning();
  return rows[0];
}

export async function updateWhale(id: number, patch: Partial<Whale>): Promise<Whale | null> {
  const clean = { ...patch } as Record<string, unknown>;
  delete clean.id;
  delete clean.createdAt;
  if (typeof clean.address === "string") clean.address = clean.address.trim().toLowerCase();
  const rows = await db
    .update(whales)
    .set({ ...(clean as Partial<Whale>), updatedAt: new Date() })
    .where(eq(whales.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function deleteWhale(id: number): Promise<void> {
  await db.delete(whales).where(eq(whales.id, id));
}

export function effectiveStrategy(defaults: Partial<Strategy> | null | undefined, whale?: Partial<Strategy> | null): Strategy {
  const merged: Record<string, unknown> = { ...DEFAULT_STRATEGY, ...(defaults ?? {}) };
  for (const [k, v] of Object.entries(whale ?? {})) {
    if (v !== undefined && v !== null && v !== "") merged[k] = v;
    else if (v === null && (k === "takeProfitPrice" || k === "stopLossPrice")) merged[k] = null;
  }
  return merged as Strategy;
}

// ── Portfolio ────────────────────────────────────────────────────────────────

export async function getPortfolio(mode: TradingMode, s?: Settings): Promise<PortfolioRow> {
  const rows = await db.select().from(portfolios).where(eq(portfolios.mode, mode)).limit(1);
  if (rows[0]) return rows[0];
  const st = s ?? (await getSettings());
  const bank = mode === "paper" ? st.paperStartingBankUsd : st.liveMaxBankUsd;
  const inserted = await db
    .insert(portfolios)
    .values({ mode, startingBankUsd: bank, cashUsd: bank })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) {
    if (mode === "paper") await importLegacyPortfolio(inserted[0]);
    const fresh = await db.select().from(portfolios).where(eq(portfolios.mode, mode)).limit(1);
    return fresh[0];
  }
  const again = await db.select().from(portfolios).where(eq(portfolios.mode, mode)).limit(1);
  return again[0];
}

/** Только метаданные. Деньги — через ledger.ts. */
export async function savePortfolioMeta(p: PortfolioRow): Promise<void> {
  await db
    .update(portfolios)
    .set({
      halted: p.halted,
      cyclesRun: p.cyclesRun,
      lastCycleAt: p.lastCycleAt,
      startingBankUsd: p.startingBankUsd,
      lastUpdated: new Date(),
    })
    .where(eq(portfolios.mode, p.mode));
}

export async function savePortfolio(p: PortfolioRow): Promise<void> {
  await savePortfolioMeta(p);
}

export async function resetPortfolio(mode: TradingMode): Promise<void> {
  await db.delete(positions).where(eq(positions.mode, mode));
  await db.delete(aiDecisions).where(eq(aiDecisions.mode, mode));
  await db.delete(portfolios).where(eq(portfolios.mode, mode));
  await db.delete(cashAdjustments).where(eq(cashAdjustments.mode, mode));
  if (mode === "paper") {
    await db.delete(seenTrades);
  }
  await addLog("warn", `Портфель ${mode} сброшен (позиции, решения, корректировки кэша)`);
}

/** Импорт portfolio_improved.json из старого скрипта (один раз, если файл есть в cwd) */
async function importLegacyPortfolio(p: PortfolioRow): Promise<void> {
  const file = "portfolio_improved.json";
  if (!existsSync(file)) return;
  try {
    const legacy = JSON.parse(readFileSync(file, "utf8"));
    const toRow = (x: Record<string, unknown>, open: boolean): typeof positions.$inferInsert => ({
      mode: "paper",
      source: "copy",
      whaleName: String(x.whale ?? "legacy"),
      whaleAddress: String(x.whaleAddress ?? ""),
      category: String(x.category ?? "Other"),
      conditionId: String(x.conditionId ?? ""),
      tokenId: String(x.tokenId ?? ""),
      market: String(x.market ?? ""),
      outcome: String(x.outcome ?? ""),
      outcomeIndex: Number(x.outcomeIndex ?? 0),
      price: Number(x.price ?? 0),
      lastPrice: x.lastPrice !== undefined ? Number(x.lastPrice) : null,
      shares: Number(x.shares ?? 0),
      costUsd: Number(x.costUsd ?? 0),
      status: open ? "OPEN" : String(x.status ?? "LOST"),
      payoutUsd: x.payoutUsd !== undefined ? Number(x.payoutUsd) : null,
      profitUsd: x.profitUsd !== undefined ? Number(x.profitUsd) : null,
      closeReason: (x.closeReason as string | undefined) ?? null,
      whaleTradeHash: (x.whaleTradeHash as string | undefined) ?? null,
      openedAt: x.openedAt ? new Date(String(x.openedAt)) : new Date(),
      closedAt: x.closedAt ? new Date(String(x.closedAt)) : null,
    });
    const rows = [
      ...((legacy.openPositions ?? []) as Record<string, unknown>[]).map((x) => toRow(x, true)),
      ...((legacy.closedPositions ?? []) as Record<string, unknown>[]).map((x) => toRow(x, false)),
    ];
    if (rows.length) await db.insert(positions).values(rows);
    const hashes: string[] = Array.isArray(legacy.seenTradeHashes) ? legacy.seenTradeHashes.slice(-1000) : [];
    if (hashes.length) await db.insert(seenTrades).values(hashes.map((hash) => ({ hash }))).onConflictDoNothing();
    await db
      .update(portfolios)
      .set({
        startingBankUsd: Number(legacy.startingBankUsd ?? p.startingBankUsd),
        cashUsd: Number(legacy.cashUsd ?? p.cashUsd),
        realizedPnlUsd: Number(legacy.realizedPnlUsd ?? 0),
        totalInvestedUsd: Number(legacy.totalInvestedUsd ?? 0),
        halted: Boolean(legacy.halted),
      })
      .where(eq(portfolios.mode, "paper"));
    await addLog("info", `Импортирован старый портфель из ${file}: позиций ${rows.length}`);
  } catch (err) {
    await addLog("warn", `Не удалось импортировать ${file}: ${(err as Error).message}`);
  }
}

// ── Positions ────────────────────────────────────────────────────────────────

export async function openPositions(mode: TradingMode): Promise<PositionRow[]> {
  return db
    .select()
    .from(positions)
    .where(and(eq(positions.mode, mode), eq(positions.status, "OPEN")))
    .orderBy(desc(positions.openedAt));
}

export async function closedPositions(mode: TradingMode, limit = 200): Promise<PositionRow[]> {
  return db
    .select()
    .from(positions)
    .where(and(eq(positions.mode, mode), sql`${positions.status} <> 'OPEN'`))
    .orderBy(desc(positions.closedAt))
    .limit(limit);
}

export async function insertPosition(row: typeof positions.$inferInsert): Promise<PositionRow> {
  const rows = await db.insert(positions).values(row).returning();
  return rows[0];
}

export async function updatePosition(id: number, patch: Partial<PositionRow>): Promise<void> {
  const clean = { ...patch } as Record<string, unknown>;
  delete clean.id;
  await db
    .update(positions)
    .set({ ...(clean as Partial<PositionRow>), updatedAt: new Date() })
    .where(eq(positions.id, id));
}

export function positionsValue(rows: PositionRow[]): number {
  return rows.reduce((s, x) => s + x.shares * (x.lastPrice ?? x.price), 0);
}

export type WhaleStats = { whaleName: string; copied: number; open: number; wins: number; losses: number; flat: number; sold: number; investedUsd: number; pnlUsd: number; unrealizedUsd: number; winRate: number };

export async function whaleStats(mode: TradingMode): Promise<WhaleStats[]> {
  const rows = await db.select().from(positions).where(and(eq(positions.mode, mode), eq(positions.source, "copy")));
  const map = new Map<string, WhaleStats>();
  for (const r of rows) {
    const s = map.get(r.whaleName) ?? { whaleName: r.whaleName, copied: 0, open: 0, wins: 0, losses: 0, flat: 0, sold: 0, investedUsd: 0, pnlUsd: 0, unrealizedUsd: 0, winRate: 0 };
    s.copied++;
    s.investedUsd += r.costUsd;
    if (r.status === "OPEN") {
      s.open++;
      s.unrealizedUsd += r.shares * (r.lastPrice ?? r.price) - r.costUsd;
    } else {
      const pnl = r.profitUsd ?? 0;
      if (pnl > 0.005) s.wins++;
      else if (pnl < -0.005) s.losses++;
      else s.flat++;
      if (r.status === "SOLD") s.sold++;
      s.pnlUsd += pnl;
    }
    s.winRate = s.wins + s.losses ? s.wins / (s.wins + s.losses) : 0;
    map.set(r.whaleName, s);
  }
  return [...map.values()].sort((a, b) => b.pnlUsd - a.pnlUsd);
}

export type SourceStat = { open: number; closed: number; wins: number; losses: number; flat: number; investedUsd: number; pnlUsd: number; unrealizedUsd: number; winRate: number; avgPnlUsd: number };

/** Статистика по источникам (стратегиям) */
export async function sourceStats(mode: TradingMode): Promise<Record<string, SourceStat>> {
  const rows = await db.select().from(positions).where(eq(positions.mode, mode));
  const map = new Map<string, SourceStat>();
  for (const r of rows) {
    const s = map.get(r.source) ?? { open: 0, closed: 0, wins: 0, losses: 0, flat: 0, investedUsd: 0, pnlUsd: 0, unrealizedUsd: 0, winRate: 0, avgPnlUsd: 0 };
    s.investedUsd += r.costUsd;
    if (r.status === "OPEN") {
      s.open++;
      s.unrealizedUsd += r.shares * (r.lastPrice ?? r.price) - r.costUsd;
    } else {
      s.closed++;
      const pnl = r.profitUsd ?? 0;
      s.pnlUsd += pnl;
      if (pnl > 0.005) s.wins++;
      else if (pnl < -0.005) s.losses++;
      else s.flat++;
    }
    s.winRate = s.wins + s.losses ? s.wins / (s.wins + s.losses) : 0;
    s.avgPnlUsd = s.closed ? s.pnlUsd / s.closed : 0;
    map.set(r.source, s);
  }
  return Object.fromEntries(map);
}

// ── Seen trades ──────────────────────────────────────────────────────────────

export async function loadSeenHashes(hashes: string[]): Promise<Set<string>> {
  if (!hashes.length) return new Set();
  const rows = await db.select({ hash: seenTrades.hash }).from(seenTrades).where(inArray(seenTrades.hash, hashes));
  return new Set(rows.map((r) => r.hash));
}

export async function markSeen(items: { hash: string; whaleId?: number }[]): Promise<void> {
  if (!items.length) return;
  await db.insert(seenTrades).values(items.map((i) => ({ hash: i.hash, whaleId: i.whaleId ?? null }))).onConflictDoNothing();
}

// ── Logs ─────────────────────────────────────────────────────────────────────

export async function addLog(level: "info" | "warn" | "error" | "trade", message: string, meta?: unknown): Promise<void> {
  try {
    await db.insert(botLogs).values({ level, message, meta: meta ?? null });
  } catch {
    // журнал не должен ломать цикл
  }
}

export async function getLogs(limit = 200) {
  return db.select().from(botLogs).orderBy(desc(botLogs.id)).limit(limit);
}

export async function pruneLogs(keep = 3000): Promise<void> {
  await db.execute(sql`delete from bot_logs where id < (select coalesce(max(id),0) from bot_logs) - ${keep}`);
}

// ── AI decisions ─────────────────────────────────────────────────────────────

export async function recordAiDecision(row: typeof aiDecisions.$inferInsert) {
  await db.insert(aiDecisions).values(row);
}

export async function recentAiDecisions(mode: TradingMode, limit = 50) {
  return db.select().from(aiDecisions).where(eq(aiDecisions.mode, mode)).orderBy(desc(aiDecisions.id)).limit(limit);
}

// ── AI Chat ──────────────────────────────────────────────────────────────────

export async function getChatHistory(limit = 60): Promise<{ role: string; content: string }[]> {
  const rows = await db
    .select({ role: aiChatMessages.role, content: aiChatMessages.content })
    .from(aiChatMessages)
    .orderBy(desc(aiChatMessages.id))
    .limit(limit);
  return rows.reverse();
}

export async function addChatMessage(role: "user" | "assistant", content: string, meta?: unknown): Promise<void> {
  await db.insert(aiChatMessages).values({ role, content, meta: meta ?? null });
}

export async function clearChatHistory(): Promise<void> {
  await db.execute(sql`delete from ai_chat_messages`);
}

export async function getFullPortfolioSnapshot(mode: TradingMode): Promise<string> {
  const [led, open, stats, src] = await Promise.all([computeLedger(mode), openPositions(mode), whaleStats(mode), sourceStats(mode)]);
  return JSON.stringify({ mode, ledger: led, openPositions: open.map((x) => ({ id: x.id, source: x.source, market: x.market, outcome: x.outcome, entry: x.price, now: x.lastPrice ?? x.price, cost: x.costUsd, pnl: x.shares * (x.lastPrice ?? x.price) - x.costUsd, whale: x.whaleName, endsAt: x.marketEndAt })), whaleStats: stats, strategyStats: src });
}

export async function saveStrategyConfig(id: string, patch: { enabled?: boolean; maxBetUsd?: number; maxPositions?: number; params?: Record<string, unknown> }): Promise<StrategyConfigRow> {
  const [cur] = await db.select().from(strategyConfigs).where(eq(strategyConfigs.id, id));
  if (!cur) throw new Error(`стратегия ${id} не найдена`);
  const [row] = await db
    .update(strategyConfigs)
    .set({
      enabled: patch.enabled ?? cur.enabled,
      maxBetUsd: patch.maxBetUsd ?? cur.maxBetUsd,
      maxPositions: patch.maxPositions ?? cur.maxPositions,
      params: { ...(cur.params as Record<string, number | string | boolean>), ...((patch.params ?? {}) as Record<string, number | string | boolean>) },
      updatedAt: new Date(),
    })
    .where(eq(strategyConfigs.id, id))
    .returning();
  return row;
}

// ── Market snapshots ─────────────────────────────────────────────────────────

export async function saveMarketSnapshot(tokenId: string, conditionId: string, market: string, outcome: string, price: number) {
  await db
    .insert(marketSnapshots)
    .values({ tokenId, conditionId, market, outcome, lastPrice: price })
    .onConflictDoUpdate({ target: marketSnapshots.tokenId, set: { lastPrice: price, updatedAt: new Date() } });
}

export async function getMarketSnapshots(): Promise<Map<string, number>> {
  const rows = await db.select().from(marketSnapshots);
  return new Map(rows.map((r) => [r.tokenId, r.lastPrice ?? 0]));
}

// ── Strategy configs ─────────────────────────────────────────────────────────

export async function selectStrategyConfigs(): Promise<StrategyConfigRow[]> {
  return db.select().from(strategyConfigs);
}

export async function upsertStrategyConfig(id: string, patch: Partial<Omit<StrategyConfigRow, "id">>): Promise<StrategyConfigRow> {
  const rows = await db
    .insert(strategyConfigs)
    .values({ id, ...patch })
    .onConflictDoUpdate({ target: strategyConfigs.id, set: { ...patch, updatedAt: new Date() } })
    .returning();
  return rows[0];
}

// ── Verified wallets ─────────────────────────────────────────────────────────

export async function upsertVerifiedWallet(row: typeof verifiedWallets.$inferInsert): Promise<void> {
  await db
    .insert(verifiedWallets)
    .values(row)
    .onConflictDoUpdate({ target: verifiedWallets.address, set: { ...row, updatedAt: new Date() } });
}

export async function listVerifiedWallets() {
  return db.select().from(verifiedWallets).orderBy(desc(verifiedWallets.score));
}
