import type { PortfolioRow, PositionRow, Settings, Whale } from "@/db/schema";
import { askAi, chatCompletion, type TradeContext } from "./ai";
import { createExecutor, type Executor } from "./executor";
import { addCashAdjustment, alreadyHeld, creditCash, reconcilePortfolio, reserveCash, type LedgerSummary } from "./ledger";
import { withCycleLock } from "./lock";
import { buildMemoryBlock, consolidateMemory, observeWhaleTrades, reflectOnClosedPosition } from "./memory";
import { sendTelegram } from "./notify";
import { PolymarketClient } from "./polymarket";
import { realtime } from "./realtime";
import {
  addLog,
  closedPositions,
  effectiveStrategy,
  getPortfolio,
  getSettings,
  insertPosition,
  listWhales,
  loadSeenHashes,
  markSeen,
  openPositions,
  pruneLogs,
  recordAiDecision,
  saveMarketSnapshot,
  savePortfolioMeta,
  selectStrategyConfigs,
  updatePosition,
  whaleStats,
} from "./store";
import { makeMarketsLoader, runStrategies } from "./strategies";
import type { CycleResult, MarketInfo, Strategy, TradingMode, WhaleTrade } from "./types";

const usd = (n: number) => `$${Math.abs(n).toFixed(2)}`;
const cents = (p: number) => `${(p * 100).toFixed(0)}¢`;
const short = (s: string, n = 50) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const HOUR = 3_600_000;

export type Ctx = {
  settings: Settings;
  mode: TradingMode;
  portfolio: PortfolioRow;
  ledger: LedgerSummary;
  api: PolymarketClient;
  executor: Executor;
  open: PositionRow[];
  closed: PositionRow[];
  notes: string[];
  whaleTrades: Map<string, WhaleTrade[]>;
  log: (level: "info" | "warn" | "error" | "trade", message: string, meta?: unknown) => Promise<void>;
};

const emptyResult = (trigger: string, startedAt: string, error?: string): CycleResult => ({
  ok: false,
  mode: "paper",
  trigger,
  startedAt,
  finishedAt: new Date().toISOString(),
  closed: 0,
  opened: 0,
  sold: 0,
  halted: false,
  error,
  notes: [],
});

let _localCycleRunning = false;
export function isCycleRunning(): boolean {
  return _localCycleRunning;
}

export async function runCycle(trigger = "manual"): Promise<CycleResult> {
  const startedAt = new Date().toISOString();
  const owner = `${process.pid}:${trigger}`;
  _localCycleRunning = true;
  try {
    const res = await withCycleLock(owner, () => runCycleLocked(trigger, startedAt));
    if (!res.acquired) {
      await addLog("warn", `⏭ Цикл (${trigger}) пропущен: другой цикл уже выполняется (advisory lock)`);
      return emptyResult(trigger, startedAt, "Цикл уже выполняется");
    }
    return res.result;
  } finally {
    _localCycleRunning = false;
  }
}

async function runCycleLocked(trigger: string, startedAt: string): Promise<CycleResult> {
  const notes: string[] = [];
  const log = async (level: "info" | "warn" | "error" | "trade", message: string, meta?: unknown) => {
    notes.push(message);
    await addLog(level, message, meta);
  };

  try {
    const settings = await getSettings();
    const { executor, mode, note: execNote } = createExecutor(settings, (m) => void log("info", m));
    if (execNote) await log("warn", `⚠️  ${execNote}`);

    const api = new PolymarketClient({ settings, log: (m) => void log("info", m) });
    const portfolio = await getPortfolio(mode, settings);

    // ── 0. Сверка леджера ДО цикла: кэш = стартовый банк − вложения + выплаты ──
    let ledger = await reconcilePortfolio(mode);
    portfolio.cashUsd = ledger.cashUsd;
    portfolio.realizedPnlUsd = ledger.realizedPnlUsd;

    const ctx: Ctx = {
      settings,
      mode,
      portfolio,
      ledger,
      api,
      executor,
      open: await openPositions(mode),
      closed: await closedPositions(mode, 50),
      notes,
      whaleTrades: new Map(),
      log,
    };

    // Live: реальный баланс USDC — источник правды вместо paper-леджера
    if (mode === "live") {
      const bal = await executor.balanceUsd();
      // Защита: обновляем кэш только если баланс успешно получен (не null)
      // и не сбрасываем кэш в 0 без открытых сделок (защита от ложного сброса при сбое RPC)
      if (bal !== null && (bal > 0 || ctx.open.length > 0) && Math.abs(bal - ledger.cashUsd) > 0.5) {
        await log("warn", `💳 LIVE: баланс USDC $${bal.toFixed(2)} ≠ леджер $${ledger.cashUsd.toFixed(2)} — вношу корректировку`);
        await addCashAdjustment("live", bal - ledger.cashUsd, "sync with on-chain USDC balance");
        ledger = await reconcilePortfolio(mode, { log: false });
        ctx.ledger = ledger;
        portfolio.cashUsd = ledger.cashUsd;
      }
    }

    const pct = ((ledger.equityUsd - ledger.startingBankUsd) / ledger.startingBankUsd) * 100;
    await log(
      "info",
      `▶ Цикл [${mode.toUpperCase()} · ${trigger}] | Кэш: ${ledger.cashUsd < 0 ? "-" : ""}${usd(ledger.cashUsd)} | В позициях: ${usd(ledger.marketValueUsd)} (${ledger.openCount}) | Эквити: ${usd(ledger.equityUsd)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%) | W/L ${ledger.wins}/${ledger.losses}`
    );
    if (ledger.overdraft) {
      await log("error", `⛔ ОВЕРДРАФТ: расчётный кэш ${usd(ledger.cashUsd)} < 0. Позиции были открыты на несуществующие деньги. Новые входы заблокированы, пока кэш не станет ≥ 0.`);
    }

    // ── Аварийный стоп-лосс по ЭКВИТИ (а не по кэшу) ──
    const maxDrawdown = ledger.startingBankUsd * settings.stopLossPercent;
    // Автоматическое снятие ложной блокировки: если открытых позиций нет и эквити в норме (нет убытка)
    if (ledger.openCount === 0 && ledger.equityUsd >= ledger.startingBankUsd * 0.95 && portfolio.halted) {
      portfolio.halted = false;
      await savePortfolioMeta(portfolio);
      await log("info", `🟢 Стоп-лосс портфеля снят: открытых позиций нет, эквити ($${ledger.equityUsd.toFixed(2)}) в норме.`);
    } else if (ledger.equityUsd <= ledger.startingBankUsd - maxDrawdown && !portfolio.halted) {
      portfolio.halted = true;
      await savePortfolioMeta(portfolio);
      await log("error", `🚨 АВАРИЙНАЯ ОСТАНОВКА: просадка эквити превысила ${Math.round(settings.stopLossPercent * 100)}% банка!`);
      await sendTelegram(settings, `🚨 АВАРИЙНАЯ ОСТАНОВКА [${mode.toUpperCase()}]! Эквити: ${usd(ledger.equityUsd)}`);
    }

    // 1. Резолвы / стопы / тейки
    const { closed, sold } = await checkAndClosePositions(ctx);

    // 2. Хедж-адвизор (может исполнять CUT, если разрешено в настройках)
    if (settings.aiEnabled && ctx.open.length >= 1) await runHedgeAdvisor(ctx);

    // 3. Киты
    let opened = 0;
    const whales = (await listWhales()).filter((w) => w.enabled);
    const canEnter = !portfolio.halted && !ctx.ledger.overdraft;
    if (canEnter) {
      opened += (await scanWhales(ctx, whales)).opened;
    } else {
      await log("warn", `⏸️  Новые сделки заблокированы: ${portfolio.halted ? "портфель остановлен" : "овердрафт кэша"}`);
    }

    // 4. Стратегии
    if (canEnter) {
      await log("info", "🧩 Стратегии…");
      const r = await runStrategies({
        settings,
        mode,
        portfolio,
        api,
        executor,
        open: ctx.open,
        whales,
        whaleTrades: ctx.whaleTrades,
        markets: makeMarketsLoader(api, settings),
        log: (m) => void log("info", m),
      });
      opened += Object.values(r).reduce((s, x) => s + x.opened, 0);
    }

    portfolio.cyclesRun++;
    portfolio.lastCycleAt = new Date();
    await savePortfolioMeta(portfolio);

    // 5. Память
    await consolidateMemory(settings, (m) => void log("info", m));
    await pruneLogs();

    // 6. Сверка ПОСЛЕ цикла — любое расхождение = баг, и мы его увидим в журнале сразу
    const after = await reconcilePortfolio(mode);
    realtime.publish("cycle", { mode, ledger: after, closed, opened, sold });

    await log("info", `⏹ Цикл завершён: закрыто ${closed}, открыто ${opened}, продано ${sold} · эквити ${usd(after.equityUsd)}`);
    return { ok: true, mode, trigger, startedAt, finishedAt: new Date().toISOString(), closed, opened, sold, halted: portfolio.halted, notes };
  } catch (err) {
    const message = (err as Error).message;
    await log("error", `❌ Ошибка цикла: ${message}`);
    return { ...emptyResult(trigger, startedAt, message), notes };
  }
}

// ── 1. Резолвы, стопы, тейки ─────────────────────────────────────────────────

/**
 * Определяем итог рынка надёжно:
 *  a) gamma: closed=true / umaResolutionStatus='resolved' → цены 1/0
 *  b) рынок истёк (endDate + 10 мин) и стакан пуст → берём gamma outcomePrices, если они крайние
 *  c) рынок истёк > 6 ч назад и ничего не известно → считаем по последней цене (SOLD по lastPrice), чтобы не висел вечно
 */
export function resolutionOf(market: MarketInfo, pos: PositionRow, now = Date.now()): { status: "WON" | "LOST"; reason: string } | null {
  // 1. Точный результат через токены CLOB (если есть флаг winner)
  if (market.tokens?.length) {
    const ourToken = market.tokens.find(
      (t) => t.tokenId === pos.tokenId || t.outcome?.toLowerCase() === pos.outcome?.toLowerCase()
    );
    if (ourToken && ourToken.winner !== undefined) {
      if (ourToken.winner === true) return { status: "WON", reason: "Рынок закрыт (CLOB winner=true)" };
      if (ourToken.winner === false && market.closed) return { status: "LOST", reason: "Рынок закрыт (CLOB winner=false)" };
    }
  }

  const px = market.outcomePrices[pos.outcomeIndex];
  const ended = market.endDate ? new Date(market.endDate).getTime() + 10 * 60_000 < now : false;

  // 2. Официальный резолв UMA (только при явной цене 1 / 0 или экстремальных значениях)
  if (market.umaResolutionStatus === "resolved" && Number.isFinite(px)) {
    if (px >= 0.95) return { status: "WON", reason: "Рынок завершён UMA (исход подтверждён)" };
    if (px <= 0.05) return { status: "LOST", reason: "Рынок завершён UMA (исход 0)" };
  }

  // 3. Рынок закрыт или истёк — только при подтверждённых крайних ценах (≥98¢ / ≤2¢), но НЕ по 0.5
  if ((market.closed || ended) && Number.isFinite(px)) {
    if (px >= 0.98) return { status: "WON", reason: "Рынок завершён, цена ≥ 98¢" };
    if (px <= 0.02) return { status: "LOST", reason: "Рынок завершён, цена ≤ 2¢" };
  }

  return null;
}

async function checkAndClosePositions(ctx: Ctx): Promise<{ closed: number; sold: number }> {
  let closed = 0;
  let sold = 0;
  const strat = new Map((await selectStrategyConfigs()).map((c) => [c.id, c]));
  const whales = await listWhales();
  const now = Date.now();

  for (const pos of [...ctx.open]) {
    const market = await ctx.api.fetchMarket(pos.conditionId);
    if (!market) {
      await ctx.log("warn", `⚠️ #${pos.id} рынок ${short(pos.market, 30)} не найден в gamma — пропуск`);
      continue;
    }
    if (!pos.marketEndAt && market.endDate) await updatePosition(pos.id, { marketEndAt: new Date(market.endDate) });

    // a/b) Резолв
    const resolution = resolutionOf(market, pos, now);
    if (resolution) {
      const payoutUsd = resolution.status === "WON" ? pos.shares : 0;
      await finalizePosition(ctx, pos, resolution.status, payoutUsd, payoutUsd - pos.costUsd, resolution.reason);
      closed++;
      continue;
    }

    // Текущая цена: CLOB midpoint → gamma outcomePrice (НЕ оставляем цену входа навсегда)
    let mid = await ctx.api.fetchMidPrice(pos.tokenId);
    const gammaPx = market.outcomePrices[pos.outcomeIndex];
    if (mid === null && Number.isFinite(gammaPx)) mid = gammaPx;
    if (mid !== null && Number.isFinite(mid)) {
      pos.lastPrice = mid;
      await updatePosition(pos.id, { lastPrice: mid });
      await saveMarketSnapshot(pos.tokenId, pos.conditionId, pos.market, pos.outcome, mid);
      realtime.publish("price", { positionId: pos.id, tokenId: pos.tokenId, price: mid });
    }

    // c) Истёк давно, а резолва нет → закрываем по последней цене, чтобы не искажать эквити
    const endedMs = market.endDate ? new Date(market.endDate).getTime() : null;
    if (endedMs && now - endedMs > 6 * HOUR && mid !== null) {
      if (await sellPosition(ctx, pos, mid, `Рынок истёк ${Math.round((now - endedMs) / HOUR)}ч назад без резолва — фиксация по последней цене`)) sold++;
      continue;
    }
    if (mid === null) continue;

    // Экстремальные цены (де-факто решён)
    if (mid >= 0.99) {
      if (await sellPosition(ctx, pos, mid, "Цена ≥ 99¢ (фактически выиграл)")) sold++;
      continue;
    }
    if (mid <= 0.01) {
      // Продаём за копейки, а не списываем в 0 — в live это реальные деньги, в paper — честная оценка
      if (await sellPosition(ctx, pos, mid, "Цена ≤ 1¢ (фактически проиграл)")) sold++;
      continue;
    }

    // Стратегии: свои SL/TP (в %, от цены входа)
    if (pos.source !== "copy") {
      const c = strat.get(pos.source);
      const tp = Number(c?.params.takeProfitPct ?? 0);
      const sl = Number(c?.params.stopLossPct ?? 0);
      if (tp > 0 && mid >= pos.price * (1 + tp)) {
        if (await sellPosition(ctx, pos, mid, `take_profit +${Math.round(tp * 100)}%`)) sold++;
        continue;
      }
      if (sl > 0 && mid <= pos.price * (1 - sl)) {
        if (await sellPosition(ctx, pos, mid, `stop_loss -${Math.round(sl * 100)}%`)) sold++;
        continue;
      }
      continue;
    }

    // Копирование: персональные стопы/тейки кита (по абсолютной цене)
    const whale = whales.find((w) => w.id === pos.whaleId);
    const strategy = effectiveStrategy(ctx.settings.defaultStrategy, whale?.strategy);
    if (strategy.takeProfitPrice && mid >= strategy.takeProfitPrice) {
      if (await sellPosition(ctx, pos, mid, `Take-Profit: ${cents(mid)} ≥ ${cents(strategy.takeProfitPrice)}`)) sold++;
      continue;
    }
    if (strategy.stopLossPrice && mid <= strategy.stopLossPrice) {
      if (await sellPosition(ctx, pos, mid, `Stop-Loss: ${cents(mid)} ≤ ${cents(strategy.stopLossPrice)}`)) sold++;
      continue;
    }
  }
  return { closed, sold };
}

export async function sellPosition(ctx: Ctx, pos: PositionRow, price: number, reason: string): Promise<boolean> {
  const res = await ctx.executor.sell({ tokenId: pos.tokenId, shares: pos.shares, price, market: pos.market });
  if (!res.ok) {
    await ctx.log("warn", `⚠️  Не удалось продать ${short(pos.market)}: ${res.error}`);
    return false;
  }
  await finalizePosition(ctx, pos, "SOLD", res.proceedsUsd, res.proceedsUsd - pos.costUsd, reason);
  return true;
}

export async function finalizePosition(ctx: Ctx, pos: PositionRow, status: string, payoutUsd: number, profitUsd: number, reason: string) {
  pos.status = status;
  pos.payoutUsd = payoutUsd;
  pos.profitUsd = profitUsd;
  pos.closeReason = reason;
  pos.closedAt = new Date();
  await updatePosition(pos.id, { status, payoutUsd, profitUsd, closeReason: reason, closedAt: pos.closedAt });

  ctx.open = ctx.open.filter((p) => p.id !== pos.id);
  // атомарно в БД, а не «p.cashUsd += x; save(p)»
  await creditCash(ctx.mode, payoutUsd, profitUsd);
  ctx.portfolio.cashUsd += payoutUsd;
  ctx.portfolio.realizedPnlUsd += profitUsd;
  realtime.publish("position", { action: "closed", position: pos });

  const sign = profitUsd >= 0 ? "+" : "-";
  const icon = status === "WON" ? "🏆" : status === "SOLD" ? (profitUsd >= 0 ? "💰" : "🔻") : "❌";
  await ctx.log("trade", `${icon} ЗАКРЫТА #${pos.id}: ${short(pos.market)} [${pos.outcome}] → ${status} (${sign}${usd(profitUsd)}) · ${reason}`, { positionId: pos.id });
  await sendTelegram(ctx.settings, `${icon} ${ctx.mode.toUpperCase()} · ${status}\n${pos.market}\n${pos.outcome}: ${sign}${usd(profitUsd)}\n${reason}`);
  await reflectOnClosedPosition(ctx.settings, pos, status, profitUsd, reason, (m) => void ctx.log("info", m));
}

// ── Единая точка открытия позиции (используется и китами, и стратегиями) ─────

export async function openGuarded(
  ctx: Pick<Ctx, "mode" | "executor" | "open" | "portfolio" | "settings" | "log">,
  a: {
    market: MarketInfo;
    outcomeIndex: number;
    price: number;
    usd: number;
    source: string;
    whale?: Whale | null;
    category: string;
    label: string;
    reason: string;
    confidence?: number;
    whaleTradeHash?: string | null;
    whaleSizeShares?: number | null;
    aiDecision?: PositionRow["aiDecision"];
    allowMultiLeg?: boolean;
  }
): Promise<PositionRow | null> {
  const tokenId = a.market.clobTokenIds[a.outcomeIndex];
  const outcome = a.market.outcomes[a.outcomeIndex];
  if (!tokenId || !outcome || !(a.price > 0 && a.price < 1)) {
    await ctx.log("info", `   ⏭️ некорректный исход/цена (${a.outcomeIndex}, ${a.price})`);
    return null;
  }
  // 1) Дубли: проверка в БД, а не по «снимку» массива в памяти
  const isDuplicate = a.allowMultiLeg
    ? ctx.open.some((p) => p.tokenId === tokenId) || (await alreadyHeld(ctx.mode, a.market.conditionId, tokenId))
    : ctx.open.some((p) => p.conditionId === a.market.conditionId) || (await alreadyHeld(ctx.mode, a.market.conditionId));

  if (isDuplicate) {
    await ctx.log("info", `   ⏭️ рынок/исход уже в портфеле: ${short(a.market.question, 40)}`);
    return null;
  }
  // 2) Общий лимит позиций — из БД
  if (ctx.open.length >= ctx.settings.maxOpenPositions) {
    await ctx.log("info", `   ⏭️ общий лимит позиций ${ctx.settings.maxOpenPositions}`);
    return null;
  }
  const bet = Math.floor(Math.min(a.usd, ctx.portfolio.cashUsd) * 100) / 100;
  if (bet < 1) {
    await ctx.log("info", `   ⏭️ ставка < $1 (${usd(bet)}) — кэш ${usd(ctx.portfolio.cashUsd)}`);
    return null;
  }
  // 3) Атомарное резервирование кэша (SELECT … FOR UPDATE)
  const reserve = await reserveCash(ctx.mode, bet);
  if (!reserve.ok) {
    await ctx.log("warn", `   ⚠️ Недостаточно кэша в БД: ${usd(reserve.cashAfter)} < ${usd(bet)}`);
    return null;
  }
  const fill = await ctx.executor.buy({ tokenId, price: a.price, usd: bet, market: a.market.question });
  if (!fill.ok) {
    await creditCash(ctx.mode, bet, 0); // вернуть резерв
    await ctx.log("warn", `   ⚠️ Ордер не исполнен: ${fill.error}`);
    return null;
  }
  if (Math.abs(fill.costUsd - bet) > 0.005) await creditCash(ctx.mode, bet - fill.costUsd, 0); // частичное исполнение

  try {
    const row = await insertPosition({
      mode: ctx.mode,
      whaleId: a.whale?.id ?? null,
      whaleName: a.label,
      whaleAddress: a.whale?.address ?? "",
      source: a.source,
      category: a.category,
      conditionId: a.market.conditionId,
      tokenId,
      market: a.market.question,
      outcome,
      outcomeIndex: a.outcomeIndex,
      price: fill.avgPrice,
      lastPrice: fill.avgPrice,
      shares: fill.shares,
      costUsd: fill.costUsd,
      marketEndAt: a.market.endDate ? new Date(a.market.endDate) : null,
      whaleTradeHash: a.whaleTradeHash ?? null,
      whaleSizeShares: a.whaleSizeShares ?? null,
      aiDecision: a.aiDecision ?? { decision: "COPY", confidence: a.confidence ?? 0.5, sizeMultiplier: 1, reason: a.reason },
      liveOrderId: fill.orderId ?? null,
    });
    ctx.open.push(row);
    ctx.portfolio.cashUsd -= fill.costUsd;
    ctx.portfolio.totalInvestedUsd += fill.costUsd;
    realtime.publish("position", { action: "opened", position: row });
    realtime.subscribeToken(tokenId);
    await ctx.log(
      "trade",
      `   ✅ НОВАЯ ПОЗИЦИЯ #${row.id} [${ctx.mode}] ${a.label}: ${short(a.market.question)} — ${outcome} @ ${cents(fill.avgPrice)} · ${usd(fill.costUsd)} → ${fill.shares.toFixed(2)} шт. · ${a.reason}`,
      { positionId: row.id }
    );
    await sendTelegram(ctx.settings, `🆕 ${ctx.mode.toUpperCase()} · ${a.label}\n${a.market.question}\n${outcome} @ ${cents(fill.avgPrice)} · ставка ${usd(fill.costUsd)}\n${a.reason}`);
    return row;
  } catch (err) {
    // unique index positions_one_open_per_token сработал → параллельная вставка; в paper возвращаем деньги
    if (ctx.mode === "paper") {
      await creditCash(ctx.mode, fill.costUsd, 0);
    } else {
      await ctx.log("error", `🚨 КРИТИЧНО [LIVE]: Ордер ${fill.orderId ?? "N/A"} исполнен на бирже, но запись в БД сорвалась! Деньги НЕ возвращены: ${(err as Error).message}`);
    }
    await ctx.log("warn", `   ⚠️ Позиция не записана (дубль/ошибка БД): ${(err as Error).message}`);
    return null;
  }
}

// ── 2. Киты ──────────────────────────────────────────────────────────────────

async function scanWhales(ctx: Ctx, whales: Whale[]): Promise<{ opened: number; sold: number }> {
  let opened = 0;
  let sold = 0;
  const stats = await whaleStats(ctx.mode);

  for (const whale of whales) {
    const strategy = effectiveStrategy(ctx.settings.defaultStrategy, whale.strategy);
    await ctx.log("info", `🔎 Кит: ${whale.name} (${whale.category})…`);

    const trades = await ctx.api.fetchWhaleTrades(whale.address);
    ctx.whaleTrades.set(whale.address, trades);
    if (!trades.length) {
      await ctx.log("info", `   нет публичных сделок`);
      continue;
    }

    const now = Date.now() / 1000;
    const recent = trades.filter((t) => now - t.timestamp <= strategy.maxTradeAgeMin * 60);
    const seen = await loadSeenHashes(recent.map(tradeHash));
    const newTrades = recent.filter((t) => !seen.has(tradeHash(t)));
    await observeWhaleTrades(ctx.settings, whale, newTrades, (m) => void ctx.log("info", `   ${m}`));

    if (!newTrades.length) {
      await ctx.log("info", `   новых сделок нет (${recent.length} свежих уже обработаны)`);
      continue;
    }
    await ctx.log("info", `   новых сделок: ${newTrades.length}`);

    const markDone = async (t: WhaleTrade) => {
      await markSeen([{ hash: tradeHash(t), whaleId: whale.id }]);
    };

    // Копирование продаж
    if (strategy.copySells) {
      for (const t of newTrades.filter((x) => x.side === "SELL")) {
        await markDone(t);
        const match = ctx.open.find((p) => p.whaleAddress.toLowerCase() === whale.address.toLowerCase() && p.conditionId === t.conditionId && p.tokenId === t.asset);
        if (match) {
          const mid = (await ctx.api.fetchMidPrice(match.tokenId)) ?? t.price; // продаём по РЫНКУ, а не по цене кита 30 мин назад
          await ctx.log("info", `   ⚠️ Кит продал исход — закрываем #${match.id} по ${cents(mid)}`);
          if (await sellPosition(ctx, match, mid, `Кит ${whale.name} продал свои акции`)) sold++;
        }
      }
    }

    // Хедж-детектор: кит купил ОБЕ стороны одного рынка за окно → это ММ/арбитраж, копировать нельзя
    const sidesByMarket = new Map<string, Set<string>>();
    for (const t of recent.filter((x) => x.side === "BUY")) {
      const s = sidesByMarket.get(t.conditionId) ?? new Set<string>();
      s.add(t.asset);
      sidesByMarket.set(t.conditionId, s);
    }

    const whalePositions = ctx.open.filter((p) => p.whaleAddress.toLowerCase() === whale.address.toLowerCase());
    if (whalePositions.length >= strategy.maxPositionsPerWhale) {
      await ctx.log("info", `   ⏭️ Лимит позиций на кита: ${whalePositions.length} / ${strategy.maxPositionsPerWhale}`);
      continue;
    }

    let exposure = ctx.open.filter((p) => p.category.toLowerCase() === whale.category.toLowerCase()).reduce((s, p) => s + p.costUsd, 0);
    const budget = ctx.ledger.equityUsd * strategy.maxCategoryExposure;
    if (exposure >= budget) {
      await ctx.log("info", `   ⏭️ Лимит категории ${whale.category}: ${usd(exposure)} / ${usd(budget)}`);
      continue;
    }

    const skipped: Record<string, number> = {};
    const skip = (r: string, t?: WhaleTrade) => {
      skipped[r] = (skipped[r] ?? 0) + 1;
      if (t) void markDone(t);
    };
    let copied = 0;
    const seenThisCycle = new Set<string>(); // одна и та же сделка кита, продублированная в /trades, не копируется дважды

    for (const t of newTrades) {
      if (copied >= strategy.maxCopiesPerCycle) break;
      if (ctx.open.length >= ctx.settings.maxOpenPositions) break;
      if (t.side !== "BUY") { skip("SELL", t); continue; }
      if (seenThisCycle.has(t.conditionId)) { skip("дубль сделки кита", t); continue; }
      if ((sidesByMarket.get(t.conditionId)?.size ?? 0) > 1) { skip("кит купил обе стороны (хедж/ММ)", t); continue; }
      if (ctx.open.some((p) => p.conditionId === t.conditionId)) { skip("рынок уже в портфеле", t); continue; }
      const price = t.price;
      if (price > strategy.maxEntryPrice) { skip(`цена > ${cents(strategy.maxEntryPrice)}`, t); continue; }
      if (price < strategy.minEntryPrice) { skip(`цена < ${cents(strategy.minEntryPrice)}`, t); continue; }
      const whaleUsd = t.size * price;
      if (whaleUsd < strategy.minWhaleTradeUsd) { skip(`сделка кита < ${usd(strategy.minWhaleTradeUsd)}`, t); continue; }
      const kw = keywordsOk(t.title, strategy);
      if (kw) { skip(kw, t); continue; }

      await ctx.log("info", `   🎯 Кандидат: ${short(t.title, 40)} [${t.outcome}] ${cents(price)} (кит: ${usd(whaleUsd)})`);
      const market = await ctx.api.fetchMarket(t.conditionId);
      if (!market || market.closed || !market.acceptingOrders) { await ctx.log("info", `   ⏭️ рынок закрыт / не принимает ордера`); continue; }
      if (market.endDate) {
        const hoursLeft = (new Date(market.endDate).getTime() - Date.now()) / HOUR;
        if (hoursLeft / 24 > ctx.settings.maxDaysToEnd) { await ctx.log("info", `   ⏭️ рынок слишком долгий (${(hoursLeft / 24).toFixed(1)} дн.)`); continue; }
        if (hoursLeft < ctx.settings.minHoursToEnd) { await ctx.log("info", `   ⏭️ до конца ${hoursLeft.toFixed(1)} ч < ${ctx.settings.minHoursToEnd} ч`); continue; }
      }
      if (market.volumeUsd < strategy.minVolumeUsd) { await ctx.log("info", `   ⏭️ объём ${usd(market.volumeUsd)} < ${usd(strategy.minVolumeUsd)}`); continue; }

      // Исход: ТОЛЬКО по tokenId (asset). outcomeIndex из data-api бывает 999 — ему верить нельзя.
      let outcomeIndex = market.clobTokenIds.indexOf(t.asset);
      if (outcomeIndex < 0) outcomeIndex = market.outcomes.indexOf(t.outcome);
      if (outcomeIndex < 0 || outcomeIndex >= market.outcomes.length) { await ctx.log("info", `   ⏭️ не удалось определить исход`); continue; }

      // Цена: текущая рыночная, а не цена кита N минут назад. Если ушла > 3¢ вверх — не гонимся.
      const live = (await ctx.api.fetchMidPrice(market.clobTokenIds[outcomeIndex])) ?? market.outcomePrices[outcomeIndex] ?? price;
      if (live - price > 0.03) { await ctx.log("info", `   ⏭️ цена ушла: кит ${cents(price)} → сейчас ${cents(live)}`); continue; }

      let bet = calcBet(strategy, live, ctx.portfolio.cashUsd, whaleUsd, (m) => void ctx.log("info", `   ${m}`));
      if (bet <= 0) continue;

      let aiDecision: Awaited<ReturnType<typeof askAi>> | null = null;
      if (ctx.settings.aiEnabled && strategy.useAi) {
        const ws = stats.find((s) => s.whaleName === whale.name);
        const tradeCtx = buildTradeContext(ctx, whale, strategy, t, market, whaleUsd, exposure, budget, bet, ws);
        if (ctx.settings.aiMemoryEnabled) tradeCtx.memory = await buildMemoryBlock({ whaleName: whale.name, category: whale.category });
        aiDecision = await askAi(ctx.settings, tradeCtx);
        const pass = aiDecision.decision === "COPY" && aiDecision.confidence >= ctx.settings.aiMinConfidence && !aiDecision.error;
        await recordAiDecision({
          mode: ctx.mode, whaleName: whale.name, market: market.question, outcome: market.outcomes[outcomeIndex], price: live,
          decision: aiDecision.decision, confidence: aiDecision.confidence, sizeMultiplier: aiDecision.sizeMultiplier, reason: aiDecision.reason, applied: pass,
        });
        await ctx.log(pass ? "info" : "warn", `   🤖 ИИ: ${aiDecision.decision} (conf ${(aiDecision.confidence * 100).toFixed(0)}%, ×${aiDecision.sizeMultiplier.toFixed(2)}) — ${aiDecision.reason}`);
        if (!pass) continue;
        const mult = Math.max(0.25, Math.min(2.0, aiDecision.sizeMultiplier || 1));
        bet = Math.min(
          Math.round(bet * mult * 100) / 100,
          strategy.maxBetUsd,
          ctx.portfolio.cashUsd * strategy.maxBetPct,
          ctx.portfolio.cashUsd
        );
      }
      if (exposure + bet > budget) { await ctx.log("info", `   ⏭️ ставка ${usd(bet)} превысит лимит категории`); continue; }

      const row = await openGuarded(ctx, {
        market, outcomeIndex, price: live, usd: bet, source: "copy", whale, category: whale.category, label: whale.name,
        reason: `копия ${whale.name} (${usd(whaleUsd)} @ ${cents(price)})`, whaleTradeHash: tradeHash(t), whaleSizeShares: t.size,
        aiDecision: aiDecision ? { ...aiDecision, raw: undefined } : null,
      });
      if (!row) continue;
      await markDone(t);
      seenThisCycle.add(t.conditionId);
      exposure += row.costUsd;
      copied++;
      opened++;
    }
    const summary = Object.entries(skipped).map(([r, n]) => `${r}: ${n}`).join(", ");
    if (summary) await ctx.log("info", `   📋 Пропущено — ${summary}`);
  }
  return { opened, sold };
}

// ── Хедж-адвизор с исполнением ───────────────────────────────────────────────

async function runHedgeAdvisor(ctx: Ctx) {
  const atRisk = ctx.open.filter((p) => {
    const cur = p.lastPrice ?? p.price;
    return (cur - p.price) / p.price <= -0.15;
  });
  if (!atRisk.length) return;
  const list = atRisk.map((p) => `#${p.id} ${short(p.market, 50)} [${p.outcome}] вход ${cents(p.price)} → ${cents(p.lastPrice ?? p.price)} · ставка ${usd(p.costUsd)} · до конца ${p.marketEndAt ? Math.round((p.marketEndAt.getTime() - Date.now()) / HOUR) + "ч" : "?"}`).join("\n");
  const prompt = `Позиции в просадке ≥15%:\n${list}\n\nДля каждой реши: HOLD (держать), CUT (закрыть по рынку), HEDGE (купить противоположный исход, укажи % от ставки). Ответь строго JSON-массивом: [{"positionId":1,"action":"HOLD|CUT|HEDGE","hedgeSizePct":0,"confidence":0.0,"reason":"..."}]`;
  try {
    const { content } = await chatCompletion(
      { aiApiUrl: ctx.settings.aiApiUrl, aiApiKey: ctx.settings.aiApiKey, aiModel: ctx.settings.aiModel, aiSystemPrompt: "Ты риск-менеджер. Только валидный JSON.", aiTemperature: 0.1, aiTimeoutMs: 25_000 },
      [{ role: "user", content: prompt }]
    );
    const recs = JSON.parse(content.replace(/```(?:json)?/gi, "").trim());
    if (!Array.isArray(recs)) return;
    for (const rec of recs) {
      const p = atRisk.find((x) => x.id === rec.positionId);
      if (!p) continue;
      await ctx.log("warn", `🛡️ Хедж-совет #${p.id} (${short(p.market, 30)}): ${rec.action} — ${rec.reason}`);
      // Раньше совет CUT повторялся каждый цикл и НИЧЕГО не делал. Теперь исполняем, если разрешено.
      if (rec.action === "CUT" && ctx.settings.aiAutoCut && Number(rec.confidence ?? 0.8) >= ctx.settings.aiMinConfidence) {
        const mid = p.lastPrice ?? p.price;
        if (await sellPosition(ctx, p, mid, `ИИ-риск: CUT — ${short(String(rec.reason), 80)}`)) await ctx.log("trade", `✂️ Исполнен CUT #${p.id}`);
      }
      if (rec.action === "HEDGE" && ctx.settings.aiAutoHedge && Number(rec.hedgeSizePct) > 0) {
        const market = await ctx.api.fetchMarket(p.conditionId);
        if (!market || market.outcomes.length !== 2) continue;
        const oppIdx = p.outcomeIndex === 0 ? 1 : 0;
        const oppPrice = (await ctx.api.fetchMidPrice(market.clobTokenIds[oppIdx])) ?? market.outcomePrices[oppIdx];
        const usdHedge = (p.costUsd * Math.min(100, Number(rec.hedgeSizePct))) / 100;
        await openGuardedHedge(ctx, market, oppIdx, oppPrice, usdHedge, p);
      }
    }
  } catch (err) {
    await ctx.log("info", `🛡️ Хедж-адвизор: ${(err as Error).message}`);
  }
}

async function openGuardedHedge(ctx: Ctx, market: MarketInfo, idx: number, price: number, usdAmt: number, parent: PositionRow) {
  // Хедж — единственный случай, когда разрешены две позиции на один рынок; помечаем source=hedge
  const tokenId = market.clobTokenIds[idx];
  if (await alreadyHeld(ctx.mode, market.conditionId, tokenId)) return;
  const bet = Math.floor(Math.min(usdAmt, ctx.portfolio.cashUsd) * 100) / 100;
  if (bet < 1) return;
  const reserve = await reserveCash(ctx.mode, bet);
  if (!reserve.ok) return;
  const fill = await ctx.executor.buy({ tokenId, price, usd: bet, market: market.question });
  if (!fill.ok) { await creditCash(ctx.mode, bet, 0); return; }
  const row = await insertPosition({
    mode: ctx.mode, whaleId: null, whaleName: `🛡️ Хедж #${parent.id}`, whaleAddress: "", source: "hedge", category: parent.category,
    conditionId: market.conditionId, tokenId, market: market.question, outcome: market.outcomes[idx], outcomeIndex: idx,
    price: fill.avgPrice, lastPrice: fill.avgPrice, shares: fill.shares, costUsd: fill.costUsd,
    marketEndAt: market.endDate ? new Date(market.endDate) : null, aiDecision: { decision: "COPY", confidence: 0.7, sizeMultiplier: 1, reason: `хедж позиции #${parent.id}` },
  });
  ctx.open.push(row);
  ctx.portfolio.cashUsd -= fill.costUsd;
  await ctx.log("trade", `🛡️ ХЕДЖ #${row.id} для #${parent.id}: ${market.outcomes[idx]} @ ${cents(fill.avgPrice)} · ${usd(fill.costUsd)}`);
}

// ── Помощники ────────────────────────────────────────────────────────────────

export function tradeHash(t: WhaleTrade): string {
  return t.transactionHash ? `${t.transactionHash}:${t.asset}:${t.side}` : `${t.proxyWallet ?? ""}:${t.asset}:${t.side}:${t.timestamp}:${t.size}:${t.price}`;
}

function keywordsOk(title: string, s: Strategy): string | null {
  const low = title.toLowerCase();
  const blocked = s.blockedKeywords.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (blocked.some((k) => low.includes(k))) return "стоп-слово";
  const allowed = s.allowedKeywords.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.some((k) => low.includes(k))) return "нет в списке разрешённых слов";
  return null;
}

/** Размер ставки. Kelly считается от ЭКВИТИ-кэша и режется процентами; ни при каких условиях не больше кэша. */
export function calcBet(s: Strategy, price: number, cashUsd: number, whaleUsd: number, log: (m: string) => void): number {
  if (cashUsd <= 0) return 0;
  let bet = 0;
  switch (s.sizingMode) {
    case "fixed": bet = s.fixedBetUsd; break;
    case "percent": bet = cashUsd * s.betPct; break;
    case "proportional": bet = whaleUsd * s.proportionalRatio; break;
    default: {
      const p = Math.min(0.99, Math.max(0.01, price + s.assumedEdge));
      const b = (1 - price) / price; // выигрыш на $1 ставки
      const f = (p * b - (1 - p)) / b; // полный Kelly
      if (f <= 0) {
        log(`Kelly ≤ 0 (f=${f.toFixed(3)}) при цене ${cents(price)} и edge ${s.assumedEdge} — отказ от ставки`);
        return 0;
      }
      bet = f * s.kellyMultiplier * cashUsd;
    }
  }
  if (bet <= 0) return 0;
  bet = Math.max(cashUsd * s.minBetPct, Math.min(bet, cashUsd * s.maxBetPct));
  bet = Math.min(bet, s.maxBetUsd, cashUsd);
  return Math.floor(bet * 100) / 100;
}

function buildTradeContext(ctx: Ctx, whale: Whale, strategy: Strategy, t: WhaleTrade, market: MarketInfo, whaleUsd: number, exposure: number, budget: number, bet: number, ws?: Awaited<ReturnType<typeof whaleStats>>[number]): TradeContext {
  return {
    whale: { name: whale.name, category: whale.category, notes: whale.notes ?? "", strategy },
    trade: { title: t.title, outcome: t.outcome, price: t.price, whaleUsd, ageMin: Math.round((Date.now() / 1000 - t.timestamp) / 60) },
    market: { question: market.question, volumeUsd: market.volumeUsd, liquidityUsd: market.liquidityUsd, endDate: market.endDate, outcomes: market.outcomes, outcomePrices: market.outcomePrices, hoursToEnd: market.endDate ? (new Date(market.endDate).getTime() - Date.now()) / HOUR : null },
    portfolio: { cashUsd: ctx.portfolio.cashUsd, equityUsd: ctx.ledger.equityUsd, openCount: ctx.open.length, categoryExposureUsd: exposure, categoryBudgetUsd: budget, proposedBetUsd: bet, overdraft: ctx.ledger.overdraft },
    whaleStats: ws ?? null,
    memory: "",
  };
}
