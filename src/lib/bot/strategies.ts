import type { PortfolioRow, PositionRow, Settings, StrategyConfigRow, Whale } from "@/db/schema";
import { chatCompletion } from "./ai";
import { detectCryptoMarket, getCryptoPrice } from "./crypto";
import { openGuarded } from "./engine";
import { createExecutor, type Executor } from "./executor";
import { alreadyHeld } from "./ledger";
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
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

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

export async function canOpen(ctx: StrategyContext, conditionId?: string): Promise<string | null> {
  if (ctx.portfolio.halted) return "портфель остановлен стоп-лоссом";
  if (ctx.open.length >= ctx.settings.maxOpenPositions) return `общий лимит позиций ${ctx.settings.maxOpenPositions}`;
  if (mineOpen(ctx) >= ctx.cfg.maxPositions) return `лимит стратегии ${ctx.cfg.maxPositions}`;
  if (ctx.portfolio.cashUsd < 1) return "нет кэша";
  if (conditionId && (await alreadyHeld(ctx.mode, conditionId))) return "рынок уже в портфеле (БД)";
  return null;
}

export async function openPosition(
  ctx: StrategyContext,
  a: { market: MarketInfo; outcomeIndex: number; price: number; usd: number; reason: string; confidence?: number; label?: string }
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
        const gate = await canOpen(ctx, m.conditionId);
        if (gate) {
          r.notes.push(gate);
          break;
        }
        const bet = Math.min(ctx.cfg.maxBetUsd, ctx.portfolio.cashUsd / 2);
        if (bet < 1) break;
        ctx.log(`   🎯 ${short(m.question)}: ${cents(y)} + ${cents(n)} → спред ${spread.toFixed(2)}%`);
        const a = await openPosition(ctx, {
          market: m,
          outcomeIndex: 0,
          price: y,
          usd: bet,
          reason: `арбитраж, спред ${spread.toFixed(2)}%`,
          confidence: 0.95,
        });
        if (!a) {
          r.skipped++;
          continue;
        }
        const b = await openPosition(ctx, {
          market: m,
          outcomeIndex: 1,
          price: n,
          usd: bet,
          reason: `арбитраж (вторая нога), спред ${spread.toFixed(2)}%`,
          confidence: 0.95,
        });
        if (!b) {
          const back = await ctx.executor.sell({ tokenId: a.tokenId, shares: a.shares, price: y, market: m.question });
          ctx.log(`   ↩️ вторая нога не исполнена — откат первой (${back.ok ? "ок" : back.error})`);
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
        .filter((c: any) => !known.has(c.wallet.toLowerCase()))
        .slice(0, ctx.p("maxCheck", 5));
      r.scanned = cands.length;
      const scores = await batchVerify(ctx.api, cands.map((c: any) => c.wallet), ctx.settings, ctx.log);
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
  return { ...base, cfg, p: (k, d) => num(cfg.params[k], num(def.defaults.params[k], d)) };
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
}
