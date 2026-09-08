import type { PortfolioRow, PositionRow, Settings, StrategyConfigRow, Whale } from "@/db/schema";
import { chatCompletion } from "./ai";
import { detectCryptoMarket, getCryptoPrice } from "./crypto";
import { getSpotAggregator } from "./spot-feeds";
import { quarterKellySize } from "./kelly";
import { fetchAndNormalizeNews, getRecentNews, persistNewsEvents } from "./news";
import { openGuarded, sellPosition } from "./engine";
import { createExecutor, type Executor } from "./executor";
import { alreadyHeld, computeLedger } from "./ledger";
import { withCycleLock } from "./lock";
import { buildMemoryBlock, remember, rememberStrategyResult } from "./memory";
import { sendTelegram } from "./notify";
import { aggregateWhales, PolymarketClient } from "./polymarket";
import {
  createWhale,
  getMarketSnapshots,
  getPortfolio,
  getSettings,
  listWhales,
  openPositions,
  saveMarketSnapshot,
  savePortfolio,
  selectStrategyConfigs,
  upsertStrategyConfig,
  upsertVerifiedWallet,
} from "./store";
import type { MarketInfo, TradingMode, WhaleTrade } from "./types";
import { batchVerify } from "./walletverifier";

const usd = (n: number) => `$${Math.abs(n).toFixed(2)}`;
const cents = (p: number) => `${(p * 100).toFixed(0)}¢`;
const short = (s: string, n = 45) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const hoursToEnd = (m: MarketInfo) => (m.endDate ? (new Date(m.endDate).getTime() - Date.now()) / 3_600_000 : null);
const num = (v: unknown, d: number) => {
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export type StrategyParams = Record<string, number | string | boolean>;
export type StrategyResult = { scanned: number; opened: number; skipped: number; notes: string[] };
export type StrategyBase = {
  settings: Settings;
  mode: TradingMode;
  portfolio: PortfolioRow;
  api: PolymarketClient;
  executor: Executor;
  open: PositionRow[];
  whales: Whale[];
  whaleTrades: Map<string, WhaleTrade[]>;
  markets: () => Promise<MarketInfo[]>;
  log: (m: string) => void;
};
export type StrategyContext = StrategyBase & { cfg: StrategyConfigRow; p: (k: string, d: number) => number };
export type StrategyDef = {
  id: string;
  name: string;
  emoji: string;
  description: string;
  needsAi: boolean;
  defaults: { maxBetUsd: number; maxPositions: number; params: StrategyParams };
  paramLabels: Record<string, string>;
  run?: (ctx: StrategyContext) => Promise<StrategyResult>;
};

// ── Общие помощники ─────────────────────────────────────────────────────────

function res(): StrategyResult {
  return { scanned: 0, opened: 0, skipped: 0, notes: [] };
}
const held = (ctx: StrategyBase) => new Set(ctx.open.map((p) => p.conditionId));
const mineOpen = (ctx: StrategyContext) => ctx.open.filter((p) => p.source === ctx.cfg.id).length;

export async function canOpen(ctx: StrategyContext, conditionId?: string, allowMultiLeg = false): Promise<string | null> {
  if (ctx.portfolio.halted) return "портфель остановлен стоп-лоссом";
  if (ctx.open.length >= ctx.settings.maxOpenPositions) return `общий лимит позиций ${ctx.settings.maxOpenPositions}`;
  if (mineOpen(ctx) >= ctx.cfg.maxPositions) return `лимит стратегии ${ctx.cfg.maxPositions}`;
  if (ctx.portfolio.cashUsd < 1) return "нет кэша";
  if (!allowMultiLeg && conditionId && (await alreadyHeld(ctx.mode, conditionId))) return "рынок уже в портфеле (БД)";
  return null;
}

export async function openPosition(
  ctx: StrategyContext,
  a: { market: MarketInfo; outcomeIndex: number; price: number; usd: number; reason: string; confidence?: number; label?: string; allowMultiLeg?: boolean }
): Promise<PositionRow | null> {
  const def = STRATEGIES.find((d) => d.id === ctx.cfg.id)!;
  return openGuarded(
    {
      ...ctx,
      log: async (_lvl, msg) => { ctx.log(msg); },
    },
    {
      market: a.market,
      outcomeIndex: a.outcomeIndex,
      price: a.price,
      usd: Math.min(a.usd, ctx.cfg.maxBetUsd),
      source: ctx.cfg.id,
      category: def.id === "crypto_threshold" ? "Crypto" : `S:${def.id}`,
      label: a.label ?? `🧠 ${def.emoji} ${def.name}`,
      reason: a.reason,
      confidence: a.confidence,
      allowMultiLeg: a.allowMultiLeg,
    }
  );
}

type Pick_ = { idx: number; outcome: string; confidence: number; reason: string; betPct: number };
async function aiPick(ctx: StrategyContext, markets: MarketInfo[], task: string): Promise<Pick_[]> {
  const memory = ctx.settings.aiMemoryEnabled ? await buildMemoryBlock({ strategyId: ctx.cfg.id }, 2500) : "";
  const list = markets
    .map((m, i) => {
      const h = hoursToEnd(m);
      return `${i + 1}. ${m.question}\n   ${m.outcomes.map((o, j) => `${o}: ${cents(m.outcomePrices[j] ?? 0)}`).join(" · ")} · объём ${usd(m.volumeUsd)} · ликв. ${usd(m.liquidityUsd)} · до конца ${h === null ? "?" : `${Math.round(h)}ч`}`;
    })
    .join("\n\n");
  const prompt = `Ты — Вася, автономный трейдер Polymarket.${memory}\n\nЗадача: ${task}\n\nРынки:\n${list}\n\nОтветь ТОЛЬКО JSON-массивом: [{"idx":1,"outcome":"Yes","confidence":0.8,"reason":"до 120 символов","betPct":0.03}] — только те, куда СТОИТ ставить. Если ничего не подходит — [].`;
  const { content } = await chatCompletion(
    { ...ctx.settings, aiSystemPrompt: "Отвечай ТОЛЬКО валидным JSON без markdown.", aiTemperature: 0.15 },
    [{ role: "user", content: prompt }]
  );
  const m = content.replace(/```(?:json)?/gi, "").match(/\[[\s\S]*\]/);
  try {
    return m ? (JSON.parse(m[0]) as Pick_[]) : [];
  } catch {
    return [];
  }
}

async function applyPicks(ctx: StrategyContext, batch: MarketInfo[], picks: Pick_[], minConf: number, r: StrategyResult) {
  for (const d of picks) {
    const m = batch[d.idx - 1];
    if (!m) continue;
    if ((d.confidence ?? 0) < minConf) {
      r.skipped++;
      ctx.log(`   ⏭️ ${short(m.question, 35)}: conf ${Math.round((d.confidence ?? 0) * 100)}% < ${Math.round(minConf * 100)}%`);
      continue;
    }
    const idx = m.outcomes.findIndex((o) => o.toLowerCase() === String(d.outcome).toLowerCase());
    if (idx < 0) continue;
    const gate = await canOpen(ctx, m.conditionId);
    if (gate) {
      r.notes.push(gate);
      return;
    }
    const bet = ctx.portfolio.cashUsd * Math.min(0.1, Math.max(0.005, d.betPct || 0.02));
    const row = await openPosition(ctx, {
      market: m,
      outcomeIndex: idx,
      price: m.outcomePrices[idx],
      usd: bet,
      reason: d.reason,
      confidence: d.confidence,
    });
    if (row) {
      r.opened++;
      r.notes.push(`${short(m.question, 40)} — ${d.outcome} @ ${cents(row.price)}`);
    }
  }
}

function parseThreshold(q: string): { value: number; dir: "above" | "below" } | null {
  const m = q.match(/\$\s?([\d,]+(?:\.\d+)?)\s*([kK])?/);
  if (!m) return null;
  let v = parseFloat(m[1].replace(/,/g, ""));
  if (m[2]) v *= 1000;
  const l = q.toLowerCase();
  const dir = /below|under|less than|dip|fall|drop/.test(l) ? "below" : /above|over|higher|more than|reach|hit|exceed/.test(l) ? "above" : null;
  return dir && v > 0 ? { value: v, dir } : null;
}

// ── Стратегии ───────────────────────────────────────────────────────────────

export const STRATEGIES: StrategyDef[] = [
  {
    id: "copy",
    name: "Копирование китов",
    emoji: "🐋",
    needsAi: false,
    description: "Базовая стратегия: повторяем сделки выбранных трейдеров с фильтрами и ИИ-подтверждением. Управляется на странице «Киты».",
    defaults: { maxBetUsd: 50, maxPositions: 10, params: {} },
    paramLabels: {},
  },
  {
    id: "arb_yes_no",
    name: "Арбитраж Yes+No",
    emoji: "⚖️",
    needsAi: false,
    description: "Yes + No < $1: покупаем оба исхода — один из них выплатит $1, прибыль гарантирована (минус проскальзывание).",
    defaults: { maxBetUsd: 10, maxPositions: 6, params: { minSpreadPct: 1.5, minVolumeUsd: 5000, stopLossPct: 0, takeProfitPct: 0 } },
    paramLabels: { minSpreadPct: "Мин. спред, %", minVolumeUsd: "Мин. объём, $" },
    async run(ctx) {
      const r = res();
      const h = held(ctx);
      const markets = await ctx.api.fetchMarketsForArb(ctx.p("minVolumeUsd", 5000));
      r.scanned = markets.length;
      for (const m of markets) {
        const [y, n] = m.outcomePrices;
        const spread = (1 - (y + n)) * 100;
        if (spread < ctx.p("minSpreadPct", 1.5) || h.has(m.conditionId)) continue;
        const gate = await canOpen(ctx, undefined, true);
        if (gate) {
          r.notes.push(gate);
          break;
        }
        if (!(y > 0 && n > 0 && y + n < 0.985)) continue;
        const totalBudget = Math.min(ctx.cfg.maxBetUsd, ctx.portfolio.cashUsd);
        const targetShares = Math.floor((totalBudget / (y + n)) * 100) / 100;
        if (targetShares < 1) break;
        const betA = Math.floor(targetShares * y * 100) / 100;
        const betB = Math.floor(targetShares * n * 100) / 100;
        if (betA < 0.5 || betB < 0.5) break;

        ctx.log(`   🎯 ${short(m.question)}: ${cents(y)} + ${cents(n)} = ${cents(y + n)} → спред ${spread.toFixed(2)}%, целевой объём ${targetShares.toFixed(1)} шт.`);
        const a = await openPosition(ctx, {
          market: m,
          outcomeIndex: 0,
          price: y,
          usd: betA,
          reason: `арбитраж Yes+No (${targetShares.toFixed(1)} шт.), спред ${spread.toFixed(2)}%`,
          confidence: 0.98,
          allowMultiLeg: true,
        });
        if (!a) {
          r.skipped++;
          continue;
        }
        const b = await openPosition(ctx, {
          market: m,
          outcomeIndex: 1,
          price: n,
          usd: betB,
          reason: `арбитраж Yes+No (вторая нога), спред ${spread.toFixed(2)}%`,
          confidence: 0.98,
          allowMultiLeg: true,
        });
        if (!b) {
          const rolledBack = await sellPosition(
            {
              settings: ctx.settings,
              mode: ctx.mode,
              portfolio: ctx.portfolio,
              ledger: await computeLedger(ctx.mode),
              api: ctx.api,
              executor: ctx.executor,
              open: ctx.open,
              closed: [],
              notes: [],
              whaleTrades: ctx.whaleTrades,
              log: async (_lvl, msg) => { ctx.log(msg); },
            },
            a,
            y,
            "откат арбитража — вторая нога не исполнилась"
          );
          ctx.log(`   ↩️ вторая нога не исполнена — откат первой (${rolledBack ? "ок" : "ошибка"})`);
          r.skipped++;
          continue;
        }
        r.opened += 2;
        h.add(m.conditionId);
        r.notes.push(`${short(m.question, 40)} — спред ${spread.toFixed(2)}%, вложено ${usd(a.costUsd + b.costUsd)}`);
      }
      return r;
    },
  },
  {
    id: "crypto_threshold",
    name: "Крипто-порог vs биржи",
    emoji: "₿",
    needsAi: false,
    description: "Рынки вида «BTC above $X к дате»: сверяем порог со спотом Binance/Bybit. Если цена уже далеко за порогом, а рынок ещё не дал 90¢+ — берём.",
    defaults: { maxBetUsd: 10, maxPositions: 4, params: { minEdgePct: 3, maxHoursToEnd: 72, maxPrice: 0.85, minVolumeUsd: 5000, stopLossPct: 0.3, takeProfitPct: 0 } },
    paramLabels: { minEdgePct: "Мин. отрыв спота от порога, %", maxHoursToEnd: "Макс. часов до конца", maxPrice: "Макс. цена входа", minVolumeUsd: "Мин. объём, $" },
    async run(ctx) {
      const r = res();
      const h = held(ctx);
      const markets = (await ctx.markets()).filter((m) => detectCryptoMarket(m.question) && m.volumeUsd >= ctx.p("minVolumeUsd", 5000));
      r.scanned = markets.length;
      const spot = new Map<string, number | null>();
      for (const m of markets) {
        if (h.has(m.conditionId)) continue;
        const t = parseThreshold(m.question);
        const c = detectCryptoMarket(m.question)!;
        const hte = hoursToEnd(m);
        if (!t || hte === null || hte > ctx.p("maxHoursToEnd", 72) || hte < 0.5) continue;
        if (!spot.has(c.symbol)) spot.set(c.symbol, (await getCryptoPrice(c.symbol, ctx.settings.httpProxyUrl || undefined)).binance);
        const s = spot.get(c.symbol);
        if (!s) continue;
        const edge = ((s - t.value) / t.value) * 100;
        const yesWins = t.dir === "above" ? edge > ctx.p("minEdgePct", 3) : edge < -ctx.p("minEdgePct", 3);
        const noWins = t.dir === "above" ? edge < -ctx.p("minEdgePct", 3) : edge > ctx.p("minEdgePct", 3);
        const idx = yesWins ? 0 : noWins ? 1 : -1;
        if (idx < 0 || m.outcomes[0]?.toLowerCase() !== "yes") continue;
        const price = m.outcomePrices[idx];
        if (price > ctx.p("maxPrice", 0.85) || price < 0.05) continue;
        const gate = await canOpen(ctx, m.conditionId);
        if (gate) {
          r.notes.push(gate);
          break;
        }
        const row = await openPosition(ctx, {
          market: m,
          outcomeIndex: idx,
          price,
          usd: ctx.cfg.maxBetUsd,
          confidence: 0.8,
          reason: `${c.name} спот $${s.toFixed(2)} vs порог $${t.value} (${edge >= 0 ? "+" : ""}${edge.toFixed(1)}%), до конца ${Math.round(hte)}ч`,
        });
        if (row) {
          r.opened++;
          h.add(m.conditionId);
          r.notes.push(`${short(m.question, 40)} → ${m.outcomes[idx]} @ ${cents(row.price)}`);
        }
      }
      return r;
    },
  },
  {
    id: "favorite_finish",
    name: "Фаворит на финише",
    emoji: "🏁",
    needsAi: false,
    description: "Рынки, которые заканчиваются в ближайшие часы, где исход уже стоит 88–97¢. Маленькая, но частая прибыль 3–12%.",
    defaults: { maxBetUsd: 15, maxPositions: 5, params: { minPrice: 0.88, maxPrice: 0.97, minHours: 1, maxHours: 48, minVolumeUsd: 20000, stopLossPct: 0.25, takeProfitPct: 0 } },
    paramLabels: { minPrice: "Мин. цена", maxPrice: "Макс. цена", minHours: "Мин. часов до конца", maxHours: "Макс. часов до конца", minVolumeUsd: "Мин. объём, $" },
    async run(ctx) {
      const r = res();
      const h = held(ctx);
      const ms = (await ctx.markets()).filter((m) => m.volumeUsd >= ctx.p("minVolumeUsd", 20000));
      r.scanned = ms.length;
      for (const m of ms.sort((a, b) => b.volumeUsd - a.volumeUsd)) {
        const hte = hoursToEnd(m);
        if (hte === null || hte < ctx.p("minHours", 1) || hte > ctx.p("maxHours", 48) || h.has(m.conditionId)) continue;
        const idx = m.outcomePrices.indexOf(Math.max(...m.outcomePrices));
        const price = m.outcomePrices[idx];
        if (price < ctx.p("minPrice", 0.88) || price > ctx.p("maxPrice", 0.97)) continue;
        const book = await ctx.api.fetchOrderBook(m.clobTokenIds[idx]);
        if (!book || book.spread > 0.03 || book.depthUsd < ctx.cfg.maxBetUsd * 3) { r.skipped++; continue; }
        const askPrice = book.bestAsk || price;
        const gate = await canOpen(ctx, m.conditionId);
        if (gate) {
          r.notes.push(gate);
          break;
        }
        const row = await openPosition(ctx, {
          market: m,
          outcomeIndex: idx,
          price: askPrice,
          usd: ctx.cfg.maxBetUsd,
          confidence: askPrice,
          reason: `фаворит ${cents(askPrice)}, до конца ${Math.round(hte)}ч, доход ${(((1 - askPrice) / askPrice) * 100).toFixed(1)}%`,
        });
        if (row) {
          r.opened++;
          h.add(m.conditionId);
          r.notes.push(`${short(m.question, 40)} — ${m.outcomes[idx]} @ ${cents(row.price)}`);
        }
      }
      return r;
    },
  },
  {
    id: "momentum",
    name: "Импульс",
    emoji: "🚀",
    needsAi: false,
    description: "Цена исхода выросла на N пунктов с прошлого цикла на ликвидном рынке — рынок «узнал новость», едем на тренде.",
    defaults: { maxBetUsd: 8, maxPositions: 4, params: { minMovePts: 0.08, minPrice: 0.3, maxPrice: 0.8, minVolumeUsd: 20000, stopLossPct: 0.2, takeProfitPct: 0.35 } },
    paramLabels: { minMovePts: "Мин. рост, доли (0.08 = 8¢)", minPrice: "Мин. цена", maxPrice: "Макс. цена", minVolumeUsd: "Мин. объём, $", stopLossPct: "Стоп-лосс, доля", takeProfitPct: "Тейк-профит, доля" },
    async run(ctx) {
      const r = res();
      const h = held(ctx);
      const snap = await getMarketSnapshots();
      const ms = (await ctx.markets()).filter((m) => m.volumeUsd >= ctx.p("minVolumeUsd", 20000));
      r.scanned = ms.length;
      for (const m of ms) {
        if (h.has(m.conditionId)) continue;
        for (let i = 0; i < m.outcomes.length; i++) {
          const prev = snap.get(m.clobTokenIds[i]);
          const price = m.outcomePrices[i];
          if (prev === undefined || !prev) continue;
          const d = price - prev;
          if (d < ctx.p("minMovePts", 0.08) || price < ctx.p("minPrice", 0.3) || price > ctx.p("maxPrice", 0.8)) continue;
          const gate = await canOpen(ctx, m.conditionId);
          if (gate) {
            r.notes.push(gate);
            return r;
          }
          const row = await openPosition(ctx, {
            market: m,
            outcomeIndex: i,
            price,
            usd: ctx.cfg.maxBetUsd,
            confidence: 0.6,
            reason: `импульс +${(d * 100).toFixed(0)}¢ (${cents(prev)} → ${cents(price)})`,
          });
          if (row) {
            r.opened++;
            h.add(m.conditionId);
            r.notes.push(`${short(m.question, 40)} — ${m.outcomes[i]} ${cents(prev)}→${cents(price)}`);
          }
          break;
        }
      }
      return r;
    },
  },
  {
    id: "contrarian",
    name: "Контртренд (ИИ)",
    emoji: "🔄",
    needsAi: true,
    description: "Резкое падение цены исхода на большом рынке — часто паника. ИИ с памятью решает, перепродан ли исход, и покупает откат.",
    defaults: { maxBetUsd: 8, maxPositions: 3, params: { minDropPts: 0.12, minPrice: 0.15, maxPrice: 0.6, minVolumeUsd: 50000, minConfidence: 0.7, stopLossPct: 0.25, takeProfitPct: 0.4 } },
    paramLabels: { minDropPts: "Мин. падение, доли", minPrice: "Мин. цена", maxPrice: "Макс. цена", minVolumeUsd: "Мин. объём, $", minConfidence: "Мин. уверенность ИИ" },
    async run(ctx) {
      const r = res();
      const h = held(ctx);
      const snap = await getMarketSnapshots();
      const cands: MarketInfo[] = [];
      for (const m of await ctx.markets()) {
        if (h.has(m.conditionId) || m.volumeUsd < ctx.p("minVolumeUsd", 50000)) continue;
        const drop = m.outcomes.some((_, i) => {
          const prev = snap.get(m.clobTokenIds[i]);
          const p = m.outcomePrices[i];
          return prev && prev - p >= ctx.p("minDropPts", 0.12) && p >= ctx.p("minPrice", 0.15) && p <= ctx.p("maxPrice", 0.6);
        });
        if (drop) cands.push(m);
      }
      r.scanned = cands.length;
      if (!cands.length) return r;
      const picks = await aiPick(
        ctx,
        cands.slice(0, 8),
        "Эти исходы резко подешевели с прошлого цикла. Определи, где это паника/перепроданность (стоит купить откат), а где — обоснованная реакция на новость (пропустить)."
      );
      await applyPicks(ctx, cands.slice(0, 8), picks, ctx.p("minConfidence", 0.7), r);
      return r;
    },
  },
  {
    id: "consensus",
    name: "Консенсус китов",
    emoji: "🤝",
    needsAi: false,
    description: "Два и более активных кита купили один и тот же исход за последние часы — сигнал сильнее одиночного, ставим отдельно от копирования.",
    defaults: { maxBetUsd: 15, maxPositions: 4, params: { minWhales: 2, windowHours: 12, maxPrice: 0.7, minPrice: 0.08, minHours: 2, stopLossPct: 0.3, takeProfitPct: 0.5 } },
    paramLabels: { minWhales: "Мин. китов", windowHours: "Окно, часов", maxPrice: "Макс. цена", minPrice: "Мин. цена", minHours: "Мин. часов до конца" },
    async run(ctx) {
      const r = res();
      const h = held(ctx);
      const now = Date.now() / 1000;
      const windowSec = ctx.p("windowHours", 12) * 3600;
      if (!ctx.whaleTrades.size) {
        for (const w of ctx.whales) ctx.whaleTrades.set(w.address, await ctx.api.fetchWhaleTrades(w.address, 40));
      }

      // нетто-позиция каждого кита по каждому ТОКЕНУ (BUY − SELL в $)
      type Agg = { byWhale: Map<string, Map<string, number>>; title: string; lastTs: number };
      const agg = new Map<string, Agg>();
      for (const [addr, trades] of ctx.whaleTrades) {
        for (const t of trades) {
          if (now - t.timestamp > windowSec) continue;
          const a = agg.get(t.conditionId) ?? { byWhale: new Map(), title: t.title, lastTs: 0 };
          const w = a.byWhale.get(addr) ?? new Map<string, number>();
          w.set(t.asset, (w.get(t.asset) ?? 0) + (t.side === "BUY" ? 1 : -1) * t.size * t.price);
          a.byWhale.set(addr, w);
          a.lastTs = Math.max(a.lastTs, t.timestamp);
          agg.set(t.conditionId, a);
        }
      }
      const hits: { cid: string; asset: string; whales: number; title: string }[] = [];
      for (const [cid, a] of agg) {
        if (h.has(cid)) continue;
        const votes = new Map<string, number>();
        for (const [, byAsset] of a.byWhale) {
          // кит «голосует» только если нетто-лонг ровно на одном исходе и он ≥ $5; купил обе стороны → не голосует
          const longs = [...byAsset.entries()].filter(([, usd]) => usd >= 5);
          if (longs.length !== 1) continue;
          votes.set(longs[0][0], (votes.get(longs[0][0]) ?? 0) + 1);
        }
        for (const [asset, n] of votes) {
          if (n >= ctx.p("minWhales", 2)) hits.push({ cid, asset, whales: n, title: a.title });
        }
      }
      r.scanned = hits.length;
      for (const hit of hits.sort((x, y) => y.whales - x.whales)) {
        const m = await ctx.api.fetchMarket(hit.cid);
        if (!m || m.closed || !m.acceptingOrders) continue;
        const hte = hoursToEnd(m);
        if (hte !== null && hte < ctx.p("minHours", 2)) {
          r.skipped++;
          r.notes.push(`${short(hit.title, 30)}: до конца ${hte.toFixed(1)}ч < ${ctx.p("minHours", 2)}ч`);
          continue;
        }
        const idx = m.clobTokenIds.indexOf(hit.asset);
        const price = (await ctx.api.fetchMidPrice(hit.asset)) ?? m.outcomePrices[idx];
        if (idx < 0 || !(price <= ctx.p("maxPrice", 0.7)) || price < ctx.p("minPrice", 0.08)) continue;
        const gate = await canOpen(ctx, m.conditionId);
        if (gate) {
          r.notes.push(gate);
          break;
        }
        const row = await openPosition(ctx, {
          market: m,
          outcomeIndex: idx,
          price,
          usd: ctx.cfg.maxBetUsd,
          confidence: Math.min(0.9, 0.5 + hit.whales * 0.15),
          reason: `${hit.whales} кита нетто-лонг за ${ctx.p("windowHours", 12)}ч`,
        });
        if (row) {
          r.opened++;
          h.add(hit.cid);
          r.notes.push(`${short(hit.title, 40)} — ${hit.whales} китов`);
        }
      }
      return r;
    },
  },
  {
    id: "cheap_longshot",
    name: "Дешёвые аутсайдеры (ИИ)",
    emoji: "🎲",
    needsAi: true,
    description: "Исходы по 4–20¢ на ликвидных рынках: ИИ ищет недооценённые (реальная вероятность выше цены). Маленькие ставки, большие выплаты.",
    defaults: { maxBetUsd: 5, maxPositions: 5, params: { minPrice: 0.04, maxPrice: 0.2, minVolumeUsd: 30000, minConfidence: 0.7, stopLossPct: 0.5, takeProfitPct: 1.0 } },
    paramLabels: { minPrice: "Мин. цена", maxPrice: "Макс. цена", minVolumeUsd: "Мин. объём, $", minConfidence: "Мин. уверенность ИИ" },
    async run(ctx) {
      const r = res();
      const h = held(ctx);
      const cands = (await ctx.markets())
        .filter(
          (m) =>
            !h.has(m.conditionId) &&
            m.volumeUsd >= ctx.p("minVolumeUsd", 30000) &&
            m.outcomePrices.some((p) => p >= ctx.p("minPrice", 0.04) && p <= ctx.p("maxPrice", 0.2))
        )
        .slice(0, 10);
      r.scanned = cands.length;
      if (!cands.length) return r;
      const picks = await aiPick(
        ctx,
        cands,
        `Найди аутсайдеров (цена ${cents(ctx.p("minPrice", 0.04))}–${cents(ctx.p("maxPrice", 0.2))}), чья реальная вероятность заметно ВЫШЕ цены. Ставь только на них, betPct 0.01–0.02.`
      );
      await applyPicks(
        ctx,
        cands,
        picks.filter((p) => {
          const m = cands[p.idx - 1];
          const i = m?.outcomes.findIndex((o) => o.toLowerCase() === String(p.outcome).toLowerCase()) ?? -1;
          return i >= 0 && m.outcomePrices[i] <= ctx.p("maxPrice", 0.2);
        }),
        ctx.p("minConfidence", 0.7),
        r
      );
      return r;
    },
  },
  {
    id: "free_swim",
    name: "Свободное плавание (ИИ)",
    emoji: "🎯",
    needsAi: true,
    description: "Вася торгует сам: просматривает ликвидные рынки со средними ценами, использует память и принципы, открывает позиции по собственному анализу.",
    defaults: { maxBetUsd: 15, maxPositions: 3, params: { minPrice: 0.2, maxPrice: 0.6, minVolumeUsd: 20000, minConfidence: 0.75, batch: 5, stopLossPct: 0.15, takeProfitPct: 0.5 } },
    paramLabels: { minPrice: "Мин. цена", maxPrice: "Макс. цена", minVolumeUsd: "Мин. объём, $", minConfidence: "Мин. уверенность ИИ", batch: "Рынков за запрос", stopLossPct: "Стоп-лосс, доля", takeProfitPct: "Тейк-профит, доля" },
    async run(ctx) {
      const r = res();
      const h = held(ctx);
      const ms = (await ctx.markets()).filter(
        (m) =>
          !h.has(m.conditionId) &&
          m.volumeUsd >= ctx.p("minVolumeUsd", 20000) &&
          Math.min(...m.outcomePrices) >= ctx.p("minPrice", 0.2) &&
          Math.max(...m.outcomePrices) <= ctx.p("maxPrice", 0.6)
      );
      r.scanned = ms.length;
      const bs = Math.max(2, ctx.p("batch", 5));
      for (let i = 0; i < ms.length && !(await canOpen(ctx)); i += bs) {
        const batch = ms.slice(i, i + bs);
        const picks = await aiPick(ctx, batch, "Оцени рынки и реши, где у тебя есть понятное преимущество. Сомневаешься — не ставь.");
        await applyPicks(ctx, batch, picks, ctx.p("minConfidence", 0.75), r);
      }
      return r;
    },
  },
  {
    id: "auto_scout",
    name: "Авто-разведка кошельков",
    emoji: "🔎",
    needsAi: false,
    description: "Каждые N циклов находит самых активных трейдеров, прогоняет через верификацию (сделки, win rate, объём, drawdown) и добавляет прошедших в киты (выключенными — включаешь сам).",
    defaults: { maxBetUsd: 0, maxPositions: 0, params: { everyCycles: 20, maxCheck: 5, autoAdd: true, autoEnable: false } },
    paramLabels: { everyCycles: "Раз в N циклов", maxCheck: "Проверять адресов за раз", autoAdd: "Добавлять в киты (1/0)", autoEnable: "Сразу включать (1/0)" },
    async run(ctx) {
      const r = res();
      const every = Math.max(1, ctx.p("everyCycles", 20));
      if (ctx.portfolio.cyclesRun % every !== 1 && every !== 1) {
        r.notes.push(`следующая разведка через ${every - (ctx.portfolio.cyclesRun % every)} циклов`);
        return r;
      }
      const known = new Set((await listWhales()).map((w) => w.address.toLowerCase()));
      const cands = aggregateWhales(await ctx.api.fetchRecentTrades(300), 20)
        .filter((c) => !known.has(c.address.toLowerCase()))
        .slice(0, ctx.p("maxCheck", 5));
      r.scanned = cands.length;
      const scores = await batchVerify(ctx.api, cands.map((c) => c.address), ctx.settings, ctx.log);
      for (const s of scores) {
        await upsertVerifiedWallet({
          address: s.address,
          name: s.name,
          score: s.score,
          totalTrades: s.totalTrades,
          winRate: s.winRate,
          totalVolumeUsd: s.totalVolumeUsd,
          avgTradeSizeUsd: s.avgTradeSizeUsd,
          avgPrice: s.avgPrice,
          profitableDays: s.profitableDays,
          totalDays: s.totalDays,
          maxDrawdownPct: s.maxDrawdownPct,
          verified: s.verified,
          category: s.category,
          notes: s.notes.join("; "),
        });
        if (s.verified && Boolean(ctx.p("autoAdd", 1))) {
          await createWhale({
            address: s.address,
            name: `🔎 ${s.name}`,
            category: s.category,
            enabled: Boolean(ctx.p("autoEnable", 0)),
            notes: `auto-scout: score ${s.score}/100, ${s.totalTrades} сделок, win ${(s.winRate * 100).toFixed(0)}%`,
          }).catch(() => null);
          await remember("whale_insight", `🔎 ${s.name}`, `Найден авто-разведкой: score ${s.score}, стиль ${s.category}, ср. цена ${cents(s.avgPrice)}`, { importance: 0.5 });
          r.opened++;
          r.notes.push(`добавлен ${s.name} (score ${s.score})`);
        }
      }
      return r;
    },
  },
  {
    id: "spot_strike_sniper",
    name: "Снайпер спота BTC/ETH (5m/15m)",
    emoji: "🎯",
    needsAi: false,
    description: "Сверяет мгновенный спот Binance/Bybit со страйком опциона за 60-90с до экспирации. Если исход предрешен, берет победителя с расчетом размера по 1/4 Келли.",
    defaults: {
      maxBetUsd: 15,
      maxPositions: 3,
      params: { preExpirySeconds: 90, diffBps: 15, maxPrice: 0.95, minDepth: 150 },
    },
    paramLabels: {
      preExpirySeconds: "Секунд до конца (вход)",
      diffBps: "Мин. дельта (bps, 10=0.1%)",
      maxPrice: "Макс. цена входа",
      minDepth: "Мин. глубина ($)",
    },
    async run(ctx) {
      const r = res();
      const h = held(ctx);
      const preSec = ctx.p("preExpirySeconds", 90);
      const minBps = ctx.p("diffBps", 15);
      const maxP = ctx.p("maxPrice", 0.95);
      const minDep = ctx.p("minDepth", 150);

      const allMarkets = await ctx.markets();
      const cryptoMarkets = allMarkets.filter((m) => {
        const c = detectCryptoMarket(m.question);
        if (!c) return false;
        const hte = hoursToEnd(m);
        if (hte === null) return false;
        const secToEnd = hte * 3600;
        return secToEnd <= preSec && secToEnd >= 3;
      });

      r.scanned = cryptoMarkets.length;

      for (const m of cryptoMarkets) {
        if (h.has(m.conditionId)) continue;
        const c = detectCryptoMarket(m.question)!;
        const t = parseThreshold(m.question);
        if (!t) continue;

        const agg = getSpotAggregator(c.symbol);
        const snap = agg.getSnapshot();
        if (!snap.ok || !snap.price || snap.price <= 0 || !snap.primaryVenue) continue;

        const diffBps = ((snap.price - t.value) / t.value) * 10_000;
        if (Math.abs(diffBps) < minBps) continue;

        const yesWins = t.dir === "above" ? diffBps > 0 : diffBps < 0;
        const idx = yesWins ? 0 : 1;
        if (idx < 0 || !m.outcomes[idx]) continue;

        const price = m.outcomePrices[idx];
        if (price > maxP || price < 0.05) continue;
        if (m.liquidityUsd < minDep) continue;

        const gate = await canOpen(ctx, m.conditionId);
        if (gate) {
          r.notes.push(gate);
          break;
        }

        const estimatedProb = 0.5 + Math.min(0.45, Math.abs(diffBps) / 1000);
        const kellyBet = quarterKellySize({
          estimatedProbability: estimatedProb,
          price,
          risk: {
            perTradeCap: ctx.cfg.maxBetUsd,
            maxDailyLoss: 50,
            bankroll: ctx.portfolio.cashUsd,
            kellyFraction: 0.25,
            killSwitch: false,
          },
        });
        const usdBet = Math.max(1, Math.min(kellyBet || ctx.cfg.maxBetUsd, ctx.cfg.maxBetUsd));

        const row = await openPosition(ctx, {
          market: m,
          outcomeIndex: idx,
          price,
          usd: usdBet,
          confidence: estimatedProb,
          reason: `🎯 Спот ${snap.primaryVenue.toUpperCase()} ${snap.price.toFixed(2)} vs страйк ${t.value} (дельта ${diffBps >= 0 ? "+" : ""}${diffBps.toFixed(0)} bps), до экспирации ${(hoursToEnd(m)! * 3600).toFixed(0)}с`,
        });

        if (row) {
          r.opened++;
          h.add(m.conditionId);
          r.notes.push(`${short(m.question, 35)} → ${m.outcomes[idx]} @ ${cents(row.price)} (${usd(usdBet)})`);
        }
      }
      return r;
    },
  },
  {
    id: "news_lag",
    name: "Торговля на новостном лаге",
    emoji: "⚡",
    needsAi: false,
    description: "Мониторит горячие крипто-новости (CryptoPanic/NewsAPI). При выходе сильной новости моментально покупает соответствующий исход, пока рынок не успел переоценить котировки.",
    defaults: {
      maxBetUsd: 10,
      maxPositions: 2,
      params: { minMateriality: 60, lookbackSeconds: 600, maxPrice: 0.90 },
    },
    paramLabels: {
      minMateriality: "Мин. сила новости (1-100)",
      lookbackSeconds: "Свежесть новости (сек)",
      maxPrice: "Макс. цена входа",
    },
    async run(ctx) {
      const r = res();
      const h = held(ctx);
      const minMat = ctx.p("minMateriality", 60);
      const lookback = ctx.p("lookbackSeconds", 600);
      const maxP = ctx.p("maxPrice", 0.90);

      // Фоновое обновление новостей
      fetchAndNormalizeNews()
        .then((evts) => persistNewsEvents(evts))
        .catch(() => {});

      const recentNews = await getRecentNews(lookback);
      const actionable = recentNews.filter((n) => n.materiality >= minMat && n.direction !== "neutral");

      r.scanned = actionable.length;
      if (!actionable.length) return r;

      const markets = await ctx.markets();

      for (const news of actionable) {
        const symbol = news.symbols?.[0]?.toUpperCase() || "BTC";
        const relevant = markets.filter((m) => {
          const q = m.question.toUpperCase();
          return q.includes(symbol) && m.outcomes.length === 2 && !h.has(m.conditionId);
        });

        for (const m of relevant) {
          const isUp = news.direction === "up";
          const idx = isUp ? 0 : 1;
          const price = m.outcomePrices[idx];
          if (price > maxP || price < 0.1) continue;

          const gate = await canOpen(ctx, m.conditionId);
          if (gate) {
            r.notes.push(gate);
            break;
          }

          const prob = 0.55 + Math.min(0.35, news.materiality / 200);
          const kellyBet = quarterKellySize({
            estimatedProbability: prob,
            price,
            risk: {
              perTradeCap: ctx.cfg.maxBetUsd,
              maxDailyLoss: 50,
              bankroll: ctx.portfolio.cashUsd,
              kellyFraction: 0.25,
              killSwitch: false,
            },
          });
          const usdBet = Math.max(1, Math.min(kellyBet || ctx.cfg.maxBetUsd, ctx.cfg.maxBetUsd));

          const row = await openPosition(ctx, {
            market: m,
            outcomeIndex: idx,
            price,
            usd: usdBet,
            confidence: prob,
            reason: `⚡ Новость [${news.source}]: "${short(news.title, 40)}" (сила ${news.materiality}/100, ${news.direction})`,
          });

          if (row) {
            r.opened++;
            h.add(m.conditionId);
            r.notes.push(`⚡ ${short(m.question, 30)} → ${m.outcomes[idx]} @ ${cents(row.price)}`);
          }
        }
      }
      return r;
    },
  },
  {
    id: "cross_venue_arb",
    name: "Синтетический арбитраж Yes+No",
    emoji: "⚖️",
    needsAi: false,
    description: "Находит бинарные рынки, где сумма лучших цен Yes + No < 1.00 (например 0.97). Покупает оба исхода для безрискового профита при расчете.",
    defaults: {
      maxBetUsd: 10,
      maxPositions: 3,
      params: { entryThreshold: 0.98, minLiquidityUsd: 300 },
    },
    paramLabels: {
      entryThreshold: "Порог входа (сумма Yes+No)",
      minLiquidityUsd: "Мин. ликвидность ($)",
    },
    async run(ctx) {
      const r = res();
      const h = held(ctx);
      const thresh = ctx.p("entryThreshold", 0.98);
      const minLiq = ctx.p("minLiquidityUsd", 300);

      const markets = (await ctx.markets()).filter(
        (m) => m.outcomes.length === 2 && m.liquidityUsd >= minLiq && !h.has(m.conditionId)
      );

      r.scanned = markets.length;

      for (const m of markets) {
        const sum = (m.outcomePrices[0] ?? 0) + (m.outcomePrices[1] ?? 0);
        if (sum >= thresh || sum <= 0.2) continue;

        const gate = await canOpen(ctx, m.conditionId);
        if (gate) {
          r.notes.push(gate);
          break;
        }

        const idx = m.outcomePrices[0] < m.outcomePrices[1] ? 0 : 1;
        const row = await openPosition(ctx, {
          market: m,
          outcomeIndex: idx,
          price: m.outcomePrices[idx],
          usd: ctx.cfg.maxBetUsd,
          confidence: 0.9,
          reason: `⚖️ Синтетический арбитраж: сумма Yes (${cents(m.outcomePrices[0])}) + No (${cents(m.outcomePrices[1])}) = ${cents(sum)} < ${cents(thresh)}`,
        });

        if (row) {
          r.opened++;
          h.add(m.conditionId);
          r.notes.push(`⚖️ ${short(m.question, 30)}: сумма ${cents(sum)}`);
        }
      }
      return r;
    },
  },
  {
    id: "safe_compound_favorite",
    name: "Безопасный разгон банка (Память Васи)",
    emoji: "📈",
    needsAi: false,
    description: "Эмпирическая стратегия быстрого роста без лишнего риска (100% винрейт в истории бота, +$1.29 чистыми): ловит предопределённые исходы (цена 85–93¢ за 0.2–4ч до конца с TP 99¢) и консенсус 2+ китов на валуе (15–48¢ с TP +50%).",
    defaults: {
      maxBetUsd: 1.5,
      maxPositions: 3,
      params: {
        minFavPrice: 0.85,
        maxFavPrice: 0.93,
        maxHoursToEnd: 4.0,
        minHoursToEnd: 0.2,
        minVolumeUsd: 1000,
        takeProfitPrice: 0.985,
        enableConsensus: 1,
        consensusMinWhales: 2,
        consensusMaxPrice: 0.48,
      },
    },
    paramLabels: {
      minFavPrice: "Мин. цена фаворита",
      maxFavPrice: "Макс. цена фаворита",
      maxHoursToEnd: "Макс. часов до конца",
      minHoursToEnd: "Мин. часов до конца",
      minVolumeUsd: "Мин. объём ($)",
      takeProfitPrice: "Тейк-профит (цена)",
      enableConsensus: "Искать консенсус китов (1/0)",
      consensusMinWhales: "Мин. китов для консенсуса",
      consensusMaxPrice: "Макс. цена консенсуса",
    },
    async run(ctx) {
      const r = res();
      const h = held(ctx);
      const minFav = ctx.p("minFavPrice", 0.85);
      const maxFav = ctx.p("maxFavPrice", 0.93);
      const maxH = ctx.p("maxHoursToEnd", 4.0);
      const minH = ctx.p("minHoursToEnd", 0.2);
      const minVol = ctx.p("minVolumeUsd", 1000);

      // ── Блок 1: Верняковый фаворит на финише (85–93¢ за ≤4ч до конца) ──
      const allMarkets = await ctx.markets();
      const favCandidates = allMarkets.filter((m) => {
        if (h.has(m.conditionId) || m.closed || !m.acceptingOrders) return false;
        if (m.volumeUsd < minVol) return false;
        const hte = hoursToEnd(m);
        if (hte === null || hte > maxH || hte < minH) return false;
        return m.outcomePrices.some((p) => p >= minFav && p <= maxFav);
      });

      r.scanned += favCandidates.length;

      for (const m of favCandidates) {
        if (await canOpen(ctx, m.conditionId)) break;
        const idx = m.outcomePrices.findIndex((p) => p >= minFav && p <= maxFav);
        if (idx < 0) continue;

        const live = (await ctx.api.fetchMidPrice(m.clobTokenIds[idx])) ?? m.outcomePrices[idx];
        if (live < minFav || live > maxFav + 0.02) continue;

        const hte = hoursToEnd(m) ?? 0;
        const bet = Math.min(ctx.cfg.maxBetUsd, ctx.portfolio.cashUsd);
        if (bet < 0.5) continue;

        const row = await openPosition(ctx, {
          market: m,
          outcomeIndex: idx,
          price: live,
          usd: bet,
          confidence: 0.95,
          reason: `📈 Разгон: фаворит ${cents(live)} за ${hte.toFixed(1)}ч до конца [цель 99¢, ROI ~${Math.round(((1 - live) / live) * 100)}%]`,
        });

        if (row) {
          r.opened++;
          h.add(m.conditionId);
          r.notes.push(`🏆 Фаворит: ${short(m.question, 35)} [${m.outcomes[idx]}] @ ${cents(live)}`);
        }
      }

      // ── Блок 2: Консенсус 2+ китов на валуйных исходах (15–48¢) ──
      if (ctx.p("enableConsensus", 1) && !(await canOpen(ctx))) {
        const minW = Math.max(2, ctx.p("consensusMinWhales", 2));
        const maxConP = ctx.p("consensusMaxPrice", 0.48);
        const windowSec = 12 * 3600;
        const now = Date.now() / 1000;

        type Agg = { byWhale: Map<string, Map<string, number>>; title: string };
        const agg = new Map<string, Agg>();

        for (const [addr, trades] of ctx.whaleTrades) {
          for (const t of trades) {
            if (now - t.timestamp > windowSec) continue;
            const a = agg.get(t.conditionId) ?? { byWhale: new Map(), title: t.title };
            const w = a.byWhale.get(addr) ?? new Map<string, number>();
            w.set(t.asset, (w.get(t.asset) ?? 0) + (t.side === "BUY" ? 1 : -1) * t.size * t.price);
            a.byWhale.set(addr, w);
            agg.set(t.conditionId, a);
          }
        }

        for (const [cid, a] of agg) {
          if (h.has(cid) || (await canOpen(ctx))) continue;
          const votes = new Map<string, number>();
          for (const [, byAsset] of a.byWhale) {
            const longs = [...byAsset.entries()].filter(([, usd]) => usd >= 5);
            if (longs.length === 1) {
              votes.set(longs[0][0], (votes.get(longs[0][0]) ?? 0) + 1);
            }
          }

          for (const [asset, n] of votes) {
            if (n < minW) continue;
            const m = await ctx.api.fetchMarket(cid);
            if (!m || m.closed || !m.acceptingOrders) continue;
            const hte = hoursToEnd(m);
            if (hte !== null && (hte < 2 || hte > 48)) continue; // отсекаем 15-минутный шум и слишком долгие рынки

            const idx = m.clobTokenIds.indexOf(asset);
            if (idx < 0) continue;
            const live = (await ctx.api.fetchMidPrice(asset)) ?? m.outcomePrices[idx];
            if (live < 0.15 || live > maxConP) continue;

            const bet = Math.min(ctx.cfg.maxBetUsd, ctx.portfolio.cashUsd);
            if (bet < 0.5) continue;

            const row = await openPosition(ctx, {
              market: m,
              outcomeIndex: idx,
              price: live,
              usd: bet,
              confidence: 0.88,
              reason: `📈 Разгон: консенсус ${n} китов по ${cents(live)} за 12ч (цель +50%)`,
            });

            if (row) {
              r.opened++;
              h.add(cid);
              r.notes.push(`🤝 Консенсус (${n} кита): ${short(m.question, 35)} @ ${cents(live)}`);
            }
          }
        }
      }

      return r;
    },
  },
];

// ── Конфиги (с посевом дефолтов) ────────────────────────────────────────────

export async function loadConfigs(): Promise<Map<string, StrategyConfigRow>> {
  const rows = new Map((await selectStrategyConfigs()).map((c) => [c.id, c]));
  for (const d of STRATEGIES) {
    if (rows.has(d.id)) continue;
    rows.set(
      d.id,
      await upsertStrategyConfig(d.id, {
        enabled: d.id === "copy",
        maxBetUsd: d.defaults.maxBetUsd,
        maxPositions: d.defaults.maxPositions,
        params: d.defaults.params,
      })
    );
  }
  return rows;
}

function ctxFor(base: StrategyBase, cfg: StrategyConfigRow): StrategyContext {
  const def = STRATEGIES.find((d) => d.id === cfg.id)!;
  return {
    ...base,
    cfg,
    p: (k, d) => {
      const val = cfg.params?.[k];
      const defVal = def?.defaults?.params?.[k];
      if (typeof val === "boolean") return val ? 1 : 0;
      if (typeof defVal === "boolean" && val === undefined) return defVal ? 1 : 0;
      return num(val, num(defVal, d));
    },
  };
}

export function makeMarketsLoader(api: PolymarketClient, settings: Settings) {
  let cache: MarketInfo[] | null = null;
  return async () => (cache ??= await api.fetchActiveMarkets(100, 1000, settings.maxDaysToEnd));
}

async function snapshotMarkets(ms: MarketInfo[]) {
  for (const m of ms) {
    for (let i = 0; i < m.outcomes.length; i++) {
      if (m.clobTokenIds[i]) {
        await saveMarketSnapshot(m.clobTokenIds[i], m.conditionId, m.question, m.outcomes[i], m.outcomePrices[i]);
      }
    }
  }
}

/** Прогон всех включённых стратегий (вызывается из engine) */
export async function runStrategies(base: StrategyBase): Promise<Record<string, StrategyResult>> {
  const cfgs = await loadConfigs();
  const out: Record<string, StrategyResult> = {};
  let touchedMarkets = false;
  for (const def of STRATEGIES) {
    const cfg = cfgs.get(def.id)!;
    if (!def.run || !cfg.enabled) continue;
    if (def.needsAi && !base.settings.aiEnabled) {
      base.log(`${def.emoji} ${def.name}: пропуск — нужен включённый ИИ`);
      continue;
    }
    if (base.portfolio.halted) {
      base.log("🚨 Стратегии пропущены: стоп-лосс портфеля");
      break;
    }
    base.log(`${def.emoji} ${def.name}…`);
    try {
      const r = await def.run(ctxFor(base, cfg));
      out[def.id] = r;
      touchedMarkets = true;
      base.log(
        `   ${def.emoji} итог: просмотрено ${r.scanned}, открыто ${r.opened}, пропущено ${r.skipped}${r.notes.length ? ` · ${r.notes.slice(0, 3).join("; ")}` : ""}`
      );
      if (r.opened > 0) {
        await rememberStrategyResult(def.id, `${def.name}: открыто ${r.opened} (${r.notes.slice(0, 2).join("; ")})`, null);
      }
    } catch (err) {
      base.log(`   ⚠️ ${def.name}: ${(err as Error).message}`);
    }
  }
  if (touchedMarkets) {
    await snapshotMarkets(await base.markets()).catch(() => {});
  }
  return out;
}

/** Ручной запуск одной стратегии (API) */
export async function runSingleStrategy(id: string): Promise<StrategyResult & { mode: TradingMode; notesLog: string[] }> {
  const lock = await withCycleLock(`manual_${id}`, async () => {
    const def = STRATEGIES.find((d) => d.id === id);
    if (!def?.run) throw new Error("Стратегия не найдена или не запускается вручную");
    const settings = await getSettings();
    if (def.needsAi && !settings.aiEnabled) throw new Error("Нужен включённый ИИ (Настройки → ИИ)");
    const notesLog: string[] = [];
    const log = (m: string) => {
      notesLog.push(m);
      console.log(m);
    };
    const { executor, mode } = createExecutor(settings, log);
    const api = new PolymarketClient({ settings, log });
    const portfolio = await getPortfolio(mode, settings);
    const base: StrategyBase = {
      settings,
      mode,
      portfolio,
      api,
      executor,
      open: await openPositions(mode),
      whales: (await listWhales()).filter((w) => w.enabled),
      whaleTrades: new Map(),
      markets: makeMarketsLoader(api, settings),
      log,
    };
    const cfg = (await loadConfigs()).get(id)!;
    const r = await def.run(ctxFor(base, cfg));
    await savePortfolio(portfolio);
    return { ...r, mode, notesLog };
  });

  if (!lock.acquired) {
    throw new Error("Сейчас выполняется другой торговый цикл или операция. Попробуйте через 10 секунд.");
  }
  return lock.result;
}
