/**
 * ИНСТРУМЕНТЫ ВАСИ — всё, что может сделать пользователь в интерфейсе, Вася может сделать из чата.
 * Формат — OpenAI function calling (работает с OpenAI, OpenRouter, DeepSeek, Groq, Ollama ≥0.3).
 *
 * Безопасность: инструменты, меняющие деньги (buy/sell/adjust/set_mode) в LIVE-режиме требуют
 * confirm=true — Вася сначала описывает действие и просит подтверждение, потом вызывает с confirm.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { positions, type PositionRow } from "@/db/schema";
import { createExecutor } from "./executor";
import { openGuarded, runCycle, sellPosition, type Ctx } from "./engine";
import { addCashAdjustment, computeLedger, reconcilePortfolio } from "./ledger";
import { buildMemoryBlock, memoryStats, rememberFact } from "./memory";
import { PolymarketClient } from "./polymarket";
import { realtime } from "./realtime";
import { getRunnerState, startLoop, stopLoop } from "./runner";
import {
  addLog, closedPositions, createWhale, getPortfolio, getSettings, listWhales, openPositions, recentAiDecisions, getLogs,
  saveStrategyConfig, selectStrategyConfigs, sourceStats, updateSettings, updateWhale, whaleStats,
} from "./store";
import { runSingleStrategy, STRATEGIES } from "./strategies";
import { getSpotAggregator } from "./spot-feeds";
import { getRecentNews } from "./news";
import type { TradingMode } from "./types";

export type ToolDef = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };
type Handler = (args: Record<string, unknown>, mode: TradingMode) => Promise<unknown>;

const num = (v: unknown, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v: unknown, d = "") => (v === undefined || v === null ? d : String(v));
const posView = (p: PositionRow) => ({
  id: p.id, source: p.source, label: p.whaleName, market: p.market, outcome: p.outcome, entry: p.price, now: p.lastPrice ?? p.price,
  costUsd: p.costUsd, shares: p.shares, pnlUsd: Math.round((p.shares * (p.lastPrice ?? p.price) - p.costUsd) * 100) / 100,
  pnlPct: Math.round((((p.lastPrice ?? p.price) - p.price) / p.price) * 1000) / 10, status: p.status, opened: p.openedAt, closed: p.closedAt, reason: p.closeReason,
  endsAt: p.marketEndAt, conditionId: p.conditionId, tokenId: p.tokenId,
});

async function makeCtx(mode: TradingMode): Promise<Ctx> {
  const settings = await getSettings();
  const { executor } = createExecutor({ ...settings, tradingMode: mode }, (m) => void addLog("info", m));
  if (mode === "live" && executor.mode !== "live") {
    throw new Error("Live-режим не готов: проверьте приватный ключ, RPC и настройки LIVE в интерфейсе.");
  }
  const api = new PolymarketClient({ settings, log: (m) => void addLog("info", m) });
  const ledger = await reconcilePortfolio(mode, { log: false });
  const portfolio = await getPortfolio(mode, settings);
  return { settings, mode, portfolio, ledger, api, executor, open: await openPositions(mode), closed: [], notes: [], whaleTrades: new Map(), log: (l, m, meta) => addLog(l, `[Вася] ${m}`, meta) };
}

const registry: { def: ToolDef; run: Handler; dangerous?: boolean }[] = [];
function tool(name: string, description: string, properties: Record<string, unknown>, run: Handler, opts: { required?: string[]; dangerous?: boolean } = {}) {
  registry.push({ def: { type: "function", function: { name, description, parameters: { type: "object", properties, required: opts.required ?? [] } } }, run, dangerous: opts.dangerous });
}

// ── Чтение ──
tool("get_portfolio", "Полный леджер: кэш, эквити, P&L, дрейф, овердрафт, W/L. Всегда вызывай перед советами о деньгах.", {}, async (_a, mode) => computeLedger(mode));
tool("list_positions", "Открытые позиции (по умолчанию) или закрытые (status=closed).", { status: { type: "string", enum: ["open", "closed"] }, limit: { type: "number" } }, async (a, mode) =>
  (str(a.status, "open") === "closed" ? await closedPositions(mode, num(a.limit, 30)) : await openPositions(mode)).map(posView)
);
tool("get_position", "Одна позиция по id + свежая цена, стакан и история цены за сутки.", { id: { type: "number" } }, async (a, mode) => {
  const [p] = await db.select().from(positions).where(eq(positions.id, num(a.id)));
  if (!p || p.mode !== mode) return { error: "позиция не найдена" };
  const api = new PolymarketClient({ settings: await getSettings() });
  const [mid, book, hist, market] = await Promise.all([api.fetchMidPrice(p.tokenId), api.fetchOrderBook(p.tokenId), api.fetchPriceHistory(p.tokenId, "1d", 15), api.fetchMarket(p.conditionId)]);
  return { ...posView(p), mid, book: book && { bestBid: book.bestBid, bestAsk: book.bestAsk, spread: book.spread, depthUsd: book.depthUsd }, history: hist.slice(-40), market };
}, { required: ["id"] });
tool("whale_stats", "Статистика по китам (копии, W/L, P&L) и по стратегиям.", {}, async (_a, mode) => ({ whales: await whaleStats(mode), strategies: await sourceStats(mode) }));
tool("list_whales", "Список отслеживаемых кошельков с настройками.", {}, async () => listWhales());
tool("whale_activity", "Последние сделки и текущие позиции кошелька (адрес или имя кита из списка).", { addressOrName: { type: "string" }, limit: { type: "number" } }, async (a) => {
  const q = str(a.addressOrName).toLowerCase();
  const w = (await listWhales()).find((x) => x.address.toLowerCase() === q || x.name.toLowerCase() === q);
  const address = w?.address ?? q;
  const api = new PolymarketClient({ settings: await getSettings() });
  const [trades, pos] = await Promise.all([api.fetchWhaleTrades(address, num(a.limit, 30)), api.fetchUserPositions(address, 30)]);
  return { address, name: w?.name, trades: trades.slice(0, num(a.limit, 30)), positions: pos };
}, { required: ["addressOrName"] });
tool("search_markets", "Поиск рынков Polymarket по тексту. Возвращает цены, объём, дату окончания, tokenIds.", { query: { type: "string" }, limit: { type: "number" } }, async (a) =>
  new PolymarketClient({ settings: await getSettings() }).searchMarkets(str(a.query), num(a.limit, 10)), { required: ["query"] });
tool("market_info", "Детали рынка по conditionId или slug: цены, резолв, стакан обоих исходов, крупнейшие держатели.", { conditionIdOrSlug: { type: "string" } }, async (a) => {
  const api = new PolymarketClient({ settings: await getSettings() });
  const id = str(a.conditionIdOrSlug);
  const m = id.startsWith("0x") ? await api.fetchMarket(id) : await api.fetchMarketBySlug(id);
  if (!m) return { error: "рынок не найден" };
  const books = await Promise.all(m.clobTokenIds.map((t) => api.fetchOrderBook(t)));
  const holders = await api.fetchHolders(m.conditionId, 10);
  return { market: m, books: books.map((b) => b && { bestBid: b.bestBid, bestAsk: b.bestAsk, spread: b.spread, depthUsd: b.depthUsd }), holders };
}, { required: ["conditionIdOrSlug"] });
tool("price_history", "История цены токена (interval: 1h|6h|1d|1w|max).", { tokenId: { type: "string" }, interval: { type: "string" } }, async (a) =>
  new PolymarketClient({ settings: await getSettings() }).fetchPriceHistory(str(a.tokenId), (str(a.interval, "1d") as "1d")), { required: ["tokenId"] });
tool("get_logs", "Последние строки журнала бота.", { limit: { type: "number" }, level: { type: "string" } }, async (a) => (await getLogs(num(a.limit, 60))).filter((l) => !a.level || l.level === a.level));
tool("recent_ai_decisions", "Последние решения ИИ по копированию.", { limit: { type: "number" } }, async (a, mode) => recentAiDecisions(mode, num(a.limit, 20)));
tool("get_settings", "Текущие настройки бота (без секретов).", {}, async () => {
  const s = await getSettings();
  return {
    ...s,
    aiApiKey: s.aiApiKey ? "***" : "",
    telegramBotToken: s.telegramBotToken ? "***" : "",
  };
});
tool("list_strategies", "Стратегии библиотеки, их параметры и статус.", {}, async () => ({ defs: STRATEGIES.map((d) => ({ id: d.id, name: d.name, description: d.description, needsAi: d.needsAi })), configs: await selectStrategyConfigs() }));
tool("get_runner", "Состояние авто-цикла: запущен ли, когда следующий, последний результат.", {}, async () => getRunnerState());
tool("recall_memory", "Долговременная память Васи по теме (кит/категория/стратегия).", { topic: { type: "string" } }, async (a) => ({ block: await buildMemoryBlock({ whaleName: str(a.topic) || undefined }, 3000), stats: await memoryStats() }));

// ── Действия ──
tool("run_cycle", "Запустить один цикл бота прямо сейчас.", {}, async () => runCycle("chat"));
tool("start_autorun", "Включить авто-цикл.", {}, async () => startLoop(true, 0));
tool("stop_autorun", "Выключить авто-цикл.", {}, async () => stopLoop(true));
tool("reconcile", "Пересчитать кэш/эквити из позиций (сверка леджера) и исправить расхождение.", {}, async (_a, mode) => reconcilePortfolio(mode));
tool("run_strategy", "Запустить одну стратегию вручную (id из list_strategies).", { id: { type: "string" } }, async (a) => runSingleStrategy(str(a.id)), { required: ["id"] });
tool("set_strategy", "Включить/выключить стратегию или изменить её параметры/лимиты.", {
  id: { type: "string" }, enabled: { type: "boolean" }, maxBetUsd: { type: "number" }, maxPositions: { type: "number" }, params: { type: "object" },
}, async (a) => saveStrategyConfig(str(a.id), { enabled: a.enabled as boolean | undefined, maxBetUsd: a.maxBetUsd as number | undefined, maxPositions: a.maxPositions as number | undefined, params: a.params as Record<string, unknown> | undefined }), { required: ["id"] });
tool("update_settings", "Изменить настройки бота: maxOpenPositions, minHoursToEnd, maxDaysToEnd, stopLossPercent, checkIntervalSec, aiMinConfidence, aiAutoCut, aiAutoHedge, defaultStrategy{...} и др.", { patch: { type: "object" } }, async (a) => {
  const patch = (a.patch ?? {}) as Record<string, unknown>;
  delete patch.aiApiKey;
  delete patch.telegramBotToken;
  delete patch.tradingMode;
  delete patch.liveArmed; // режим и ключи — только руками в UI
  return updateSettings(patch);
}, { required: ["patch"] });
tool("add_whale", "Добавить кошелёк в отслеживание.", { address: { type: "string" }, name: { type: "string" }, category: { type: "string" }, notes: { type: "string" } }, async (a) =>
  createWhale({ address: str(a.address), name: str(a.name), category: str(a.category, "Other"), notes: str(a.notes) }), { required: ["address", "name"] });
tool("update_whale", "Изменить кита: enabled, name, category, notes, strategy{...}.", { id: { type: "number" }, patch: { type: "object" } }, async (a) => updateWhale(num(a.id), a.patch as Record<string, unknown>), { required: ["id", "patch"] });
tool("remember", "Записать правило/факт в долговременную память.", { text: { type: "string" }, topic: { type: "string" } }, async (a) => rememberFact(str(a.text), str(a.topic)), { required: ["text"] });

tool("buy", "Открыть позицию: рынок (conditionId), исход (outcome — текст или индекс), сумма USD. Проходит все защиты (дубли, лимиты, кэш). В LIVE нужен confirm=true.", {
  conditionId: { type: "string" }, outcome: { type: "string" }, usd: { type: "number" }, reason: { type: "string" }, confirm: { type: "boolean" },
}, async (a, mode) => {
  if (mode === "live" && a.confirm !== true) return { needsConfirm: true, message: "LIVE: подтверди покупку (confirm=true)" };
  const ctx = await makeCtx(mode);
  const market = await ctx.api.fetchMarket(str(a.conditionId));
  if (!market) return { error: "рынок не найден" };
  const o = str(a.outcome);
  let idx = market.outcomes.findIndex((x) => x.toLowerCase() === o.toLowerCase());
  if (idx < 0 && Number.isFinite(Number(o))) idx = Number(o);
  if (idx < 0 || idx >= market.outcomes.length) return { error: `исход не найден; доступны: ${market.outcomes.join(", ")}` };
  const price = (await ctx.api.fetchMidPrice(market.clobTokenIds[idx])) ?? market.outcomePrices[idx];
  const row = await openGuarded(ctx, { market, outcomeIndex: idx, price, usd: num(a.usd), source: "manual", category: "Manual", label: "🧑‍💻 Вася (чат)", reason: str(a.reason, "ручной вход из чата") });
  return row ? { ok: true, position: posView(row), ledger: await reconcilePortfolio(mode, { log: false }) } : { ok: false, error: "позиция не открыта — смотри журнал (лимит/дубль/кэш)" };
}, { required: ["conditionId", "outcome", "usd"], dangerous: true });

tool("sell", "Закрыть позицию по id по текущей рыночной цене. В LIVE нужен confirm=true.", { id: { type: "number" }, reason: { type: "string" }, confirm: { type: "boolean" } }, async (a, mode) => {
  if (mode === "live" && a.confirm !== true) return { needsConfirm: true, message: "LIVE: подтверди продажу (confirm=true)" };
  const ctx = await makeCtx(mode);
  const p = ctx.open.find((x) => x.id === num(a.id));
  if (!p) return { error: "открытая позиция не найдена" };
  const mid = (await ctx.api.fetchMidPrice(p.tokenId)) ?? p.lastPrice ?? p.price;
  const ok = await sellPosition(ctx, p, mid, `Вася: ${str(a.reason, "ручное закрытие из чата")}`);
  return { ok, price: mid, ledger: await reconcilePortfolio(mode, { log: false }) };
}, { required: ["id"], dangerous: true });

tool("sell_all", "Закрыть ВСЕ открытые позиции (или только source=…). В LIVE нужен confirm=true.", { source: { type: "string" }, confirm: { type: "boolean" } }, async (a, mode) => {
  if (a.confirm !== true) return { needsConfirm: true, message: "Подтверди массовое закрытие (confirm=true)" };
  const ctx = await makeCtx(mode);
  const list = ctx.open.filter((p) => !a.source || p.source === a.source);
  let n = 0;
  for (const p of list) { const mid = (await ctx.api.fetchMidPrice(p.tokenId)) ?? p.lastPrice ?? p.price; if (await sellPosition(ctx, p, mid, "Вася: массовое закрытие")) n++; }
  return { closed: n, ledger: await reconcilePortfolio(mode, { log: false }) };
}, { dangerous: true });

tool("cash_adjustment", "Пополнение/вывод виртуального банка (paper) с причиной. Только так деньги могут появиться «извне».", { amountUsd: { type: "number" }, reason: { type: "string" } }, async (a, mode) => {
  if (mode === "live") return { error: "в live баланс синхронизируется с USDC автоматически" };
  await addCashAdjustment(mode, num(a.amountUsd), str(a.reason, "chat"));
  return computeLedger(mode);
}, { required: ["amountUsd", "reason"], dangerous: true });

tool("live_readiness", "Проверить готовность LIVE: env-переменные, тумблер, баланс USDC, WS.", {}, async () => {
  const s = await getSettings();
  const { liveReadiness, LiveExecutor } = await import("./executor");
  const liveExec = new LiveExecutor(s, () => {});
  const bal = await liveExec.balanceUsd();
  return { ...liveReadiness(s), balanceUsd: bal, wsUrl: realtime.wsUrl };
});

tool("get_spot_prices", "Живые котировки BTC, ETH, SOL в реальном времени с Binance и Bybit, со спредом (дивергенцией).", { asset: { type: "string", enum: ["BTC", "ETH", "SOL"] } }, async (a) => {
  const asset = str(a.asset, "BTC").toUpperCase();
  const agg = getSpotAggregator(asset);
  const snap = await agg.getSnapshotOrWait(1500);
  return {
    asset,
    ok: snap.ok,
    price: snap.price,
    primaryVenue: snap.primaryVenue,
    divergenceBps: (snap.divergenceBps ?? 0).toFixed(1) + " bps",
    isDivergenceHigh: Boolean(snap.isDivergenceHigh),
    formatted: `$${(snap.price ?? 0).toFixed(2)} (${snap.primaryVenue ?? "none"})`,
  };
});

tool("get_crypto_news", "Последние горячие новости криптовалют из CryptoPanic/NewsAPI с оценкой влияния на рынок (materiality 1-100).", { lookbackSeconds: { type: "number" } }, async (a) => {
  const list = await getRecentNews(num(a.lookbackSeconds, 3600));
  return list.slice(0, 10).map((n) => ({
    title: n.title,
    source: n.source,
    direction: n.direction,
    materiality: n.materiality,
    publishedAt: n.publishedAt,
    url: n.url,
  }));
});

tool("get_kalshi_status", "Проверяет статус интеграции и готовность API биржи Kalshi.", {}, async () => {
  const s = await getSettings();
  return {
    ready: Boolean(s.kalshiApiKeyId && s.kalshiPrivateKey),
    hasApiKeyId: Boolean(s.kalshiApiKeyId),
    hasPrivateKey: Boolean(s.kalshiPrivateKey),
  };
});

export const TOOLS: ToolDef[] = registry.map((r) => r.def);
export async function runTool(name: string, args: Record<string, unknown>, mode: TradingMode): Promise<unknown> {
  const t = registry.find((r) => r.def.function.name === name);
  if (!t) return { error: `неизвестный инструмент ${name}` };
  try {
    const out = await t.run(args ?? {}, mode);
    realtime.publish("chat", { role: "tool", content: JSON.stringify(out).slice(0, 400), tool: name });
    return out;
  } catch (err) {
    return { error: (err as Error).message };
  }
}
