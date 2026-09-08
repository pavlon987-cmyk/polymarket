import type { Settings } from "@/db/schema";
import type { MarketInfo, WhaleTrade } from "./types";

/**
 * Клиент публичных API Polymarket. Проверено 05.09.2026:
 *   gamma-api.polymarket.com/markets?condition_ids=…  → conditionId, question, outcomes, outcomePrices,
 *        clobTokenIds, closed, active, acceptingOrders, umaResolutionStatus, endDate, closedTime, bestBid, bestAsk
 *   clob.polymarket.com/midpoint | /price | /book | /prices-history | /spread | /time
 *   data-api.polymarket.com/trades?user= | /activity?user= | /positions?user= | /holders?market=
 * (эндпоинт /leaderboard в data-api отдаёт 404 — не используем)
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://polymarket.com",
  Referer: "https://polymarket.com/",
};

export type HttpOptions = {
  settings: Pick<Settings, "httpProxyUrl" | "extraHeadersJson" | "requestDelayMs" | "dataApiUrl" | "gammaApiUrl" | "clobApiUrl">;
  log?: (msg: string) => void;
};

export type OrderBook = { tokenId: string; bids: { price: number; size: number }[]; asks: { price: number; size: number }[]; bestBid: number; bestAsk: number; spread: number; depthUsd: number };
export type PricePoint = { t: number; p: number };
export type UserPosition = { conditionId: string; asset: string; title: string; outcome: string; size: number; avgPrice: number; curPrice: number; cashPnl: number; percentPnl: number; redeemable: boolean };
export type Holder = { proxyWallet: string; name: string; amount: number; outcomeIndex: number };

type Dispatcher = unknown;
const dispatcherCache = new Map<string, Dispatcher>();
async function getDispatcher(proxyUrl: string): Promise<Dispatcher | undefined> {
  if (!proxyUrl) return undefined;
  if (dispatcherCache.has(proxyUrl)) return dispatcherCache.get(proxyUrl);
  try {
    const undici = await import("undici");
    const agent = new undici.ProxyAgent(proxyUrl);
    dispatcherCache.set(proxyUrl, agent);
    return agent;
  } catch {
    return undefined;
  }
}
function extraHeaders(json: string): Record<string, string> {
  if (!json.trim()) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const p = JSON.parse(value);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function normalizeMarket(m: Record<string, unknown>): MarketInfo {
  return {
    conditionId: String(m.conditionId ?? ""),
    question: String(m.question ?? "Unknown Market"),
    slug: String(m.slug ?? ""),
    outcomes: parseJsonArray(m.outcomes).map(String),
    outcomePrices: parseJsonArray(m.outcomePrices).map(Number),
    clobTokenIds: parseJsonArray(m.clobTokenIds).map(String),
    volumeUsd: Number(m.volumeNum ?? m.volume ?? 0),
    liquidityUsd: Number(m.liquidityNum ?? m.liquidity ?? 0),
    closed: Boolean(m.closed),
    active: m.active === undefined ? true : Boolean(m.active),
    acceptingOrders: m.acceptingOrders === undefined ? !Boolean(m.closed) : Boolean(m.acceptingOrders),
    umaResolutionStatus: m.umaResolutionStatus ? String(m.umaResolutionStatus) : null,
    endDate: (m.endDate as string | undefined) ?? null,
    closedTime: (m.closedTime as string | undefined) ?? null,
    bestBid: m.bestBid !== undefined ? Number(m.bestBid) : null,
    bestAsk: m.bestAsk !== undefined ? Number(m.bestAsk) : null,
    eventSlug: Array.isArray(m.events) && m.events[0] ? String((m.events[0] as { slug?: string }).slug ?? "") : "",
  };
}

export function normalizeClobMarket(m: Record<string, unknown>): MarketInfo {
  const rawTokens = Array.isArray(m.tokens) ? (m.tokens as Record<string, unknown>[]) : [];
  const tokens = rawTokens.map((t) => ({
    tokenId: String(t.token_id ?? ""),
    outcome: String(t.outcome ?? ""),
    price: Number(t.price ?? 0),
    winner: t.winner !== undefined ? Boolean(t.winner) : undefined,
  }));
  const outcomes = tokens.map((t) => t.outcome);
  const outcomePrices = tokens.map((t) => t.price);
  const clobTokenIds = tokens.map((t) => t.tokenId);
  const hasWinner = tokens.some((t) => t.winner === true);
  return {
    conditionId: String(m.condition_id ?? ""),
    question: String(m.question ?? "Unknown Market"),
    slug: String(m.market_slug ?? ""),
    outcomes,
    outcomePrices,
    clobTokenIds,
    volumeUsd: 0,
    liquidityUsd: 0,
    closed: Boolean(m.closed),
    active: Boolean(m.active),
    acceptingOrders: Boolean(m.accepting_orders),
    umaResolutionStatus: hasWinner ? "resolved" : null,
    endDate: (m.end_date_iso as string | undefined) ?? null,
    closedTime: null,
    bestBid: null,
    bestAsk: null,
    eventSlug: "",
    tokens,
  };
}

export function normalizeTrade(t: unknown): WhaleTrade {
  const x = t as Record<string, unknown>;
  const idx = Number(x.outcomeIndex);
  return {
    proxyWallet: x.proxyWallet ? String(x.proxyWallet).toLowerCase() : undefined,
    side: String(x.side ?? "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY",
    asset: String(x.asset ?? x.tokenId ?? ""),
    conditionId: String(x.conditionId ?? ""),
    price: Number(x.price ?? 0),
    size: Number(x.size ?? 0),
    timestamp: Number(x.timestamp ?? 0),
    title: String(x.title ?? x.question ?? ""),
    outcome: String(x.outcome ?? ""),
    // data-api иногда отдаёт outcomeIndex = 999 → считаем неизвестным
    outcomeIndex: Number.isFinite(idx) && idx >= 0 && idx < 50 ? idx : undefined,
    transactionHash: x.transactionHash ? String(x.transactionHash) : undefined,
    name: x.name ? String(x.name) : undefined,
    pseudonym: x.pseudonym ? String(x.pseudonym) : undefined,
  };
}

export class PolymarketClient {
  private readonly log: (msg: string) => void;
  private lastRequestAt = 0;
  public blockedCount = 0;
  private marketCache = new Map<string, { at: number; m: MarketInfo | null }>();

  constructor(private readonly opts: HttpOptions) {
    this.log = opts.log ?? (() => {});
  }
  get dataApi() { return this.opts.settings.dataApiUrl.replace(/\/$/, ""); }
  get gammaApi() { return this.opts.settings.gammaApiUrl.replace(/\/$/, ""); }
  get clobApi() { return this.opts.settings.clobApiUrl.replace(/\/$/, ""); }

  async fetchJson<T = unknown>(url: string, { retries = 2, timeoutMs = 12_000 } = {}): Promise<T | null> {
    const headers = { ...BROWSER_HEADERS, ...extraHeaders(this.opts.settings.extraHeadersJson) };
    const dispatcher = await getDispatcher(this.opts.settings.httpProxyUrl);
    for (let attempt = 0; attempt <= retries; attempt++) {
      const wait = this.opts.settings.requestDelayMs - (Date.now() - this.lastRequestAt);
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const init: RequestInit & { dispatcher?: Dispatcher } = { headers, signal: controller.signal, cache: "no-store" };
        if (dispatcher) init.dispatcher = dispatcher;
        const res = await fetch(url, init);
        if (res.status === 429 || res.status === 425) { await sleep(3_000 * (attempt + 1)); continue; }
        if (res.status === 401 || res.status === 403) {
          this.blockedCount++;
          if (attempt < retries) { await sleep(2_000 * (attempt + 1)); continue; }
          this.log(`🚫 HTTP ${res.status} от ${new URL(url).host} — гео/IP-блок. Укажи прокси в Настройках → Сеть.`);
          return null;
        }
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as T;
      } catch (err) {
        const last = attempt === retries;
        if (last) {
          this.log(`⚠️ Ошибка ${url.split("?")[0]}: ${(err as Error).message}`);
          return null;
        }
        await sleep(1_000 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  // ── Сделки / активность ──
  async fetchWhaleTrades(address: string, limit = 50): Promise<WhaleTrade[]> {
    const primary = await this.fetchJson<unknown[]>(`${this.dataApi}/trades?user=${address}&limit=${limit}`, { retries: 1 });
    if (Array.isArray(primary)) return dedupeTrades(primary.map(normalizeTrade));
    if (primary === null) {
      const fallback = await this.fetchJson<unknown[]>(`${this.dataApi}/activity?user=${address}&limit=${limit}&type=TRADE`, { retries: 1 });
      if (Array.isArray(fallback)) return dedupeTrades(fallback.map(normalizeTrade).filter((t) => t.conditionId));
    }
    return [];
  }
  async fetchRecentTrades(limit = 500): Promise<WhaleTrade[]> {
    const data = await this.fetchJson<unknown[]>(`${this.dataApi}/trades?limit=${limit}`);
    return Array.isArray(data) ? data.map(normalizeTrade) : [];
  }
  /** Реальные позиции кошелька (то, что кит держит СЕЙЧАС, а не только последние сделки) */
  async fetchUserPositions(address: string, limit = 100): Promise<UserPosition[]> {
    const data = await this.fetchJson<Record<string, unknown>[]>(`${this.dataApi}/positions?user=${address}&limit=${limit}&sortBy=CURRENT&sortDirection=DESC`);
    return Array.isArray(data)
      ? data.map((p) => ({
          conditionId: String(p.conditionId ?? ""), asset: String(p.asset ?? ""), title: String(p.title ?? ""), outcome: String(p.outcome ?? ""),
          size: Number(p.size ?? 0), avgPrice: Number(p.avgPrice ?? 0), curPrice: Number(p.curPrice ?? 0), cashPnl: Number(p.cashPnl ?? 0), percentPnl: Number(p.percentPnl ?? 0), redeemable: Boolean(p.redeemable),
        }))
      : [];
  }
  /** Крупнейшие держатели исходов рынка */
  async fetchHolders(conditionId: string, limit = 20): Promise<Holder[]> {
    const data = await this.fetchJson<{ token: string; holders: Record<string, unknown>[] }[]>(`${this.dataApi}/holders?market=${conditionId}&limit=${limit}`);
    if (!Array.isArray(data)) return [];
    return data.flatMap((g) => (g.holders ?? []).map((h) => ({ proxyWallet: String(h.proxyWallet ?? ""), name: String(h.name ?? h.pseudonym ?? ""), amount: Number(h.amount ?? 0), outcomeIndex: Number(h.outcomeIndex ?? 0) })));
  }

  // ── Рынки ──
  async fetchMarket(conditionId: string, maxAgeMs = 20_000): Promise<MarketInfo | null> {
    const c = this.marketCache.get(conditionId);
    if (c && Date.now() - c.at < maxAgeMs) return c.m;
    const data = await this.fetchJson<Record<string, unknown>[]>(`${this.gammaApi}/markets?condition_ids=${conditionId}`);
    const raw = Array.isArray(data) ? data[0] : null;
    let m = raw && String(raw.conditionId ?? "").toLowerCase() === conditionId.toLowerCase() ? normalizeMarket(raw) : null;
    if (!m) {
      // Фолбэк на CLOB API: архивные и короткие 5-15m рынки исчезают из gamma, но есть в CLOB
      const clobRaw = await this.fetchJson<Record<string, unknown>>(`${this.clobApi}/markets/${conditionId}`);
      if (clobRaw && String(clobRaw.condition_id ?? "").toLowerCase() === conditionId.toLowerCase()) {
        m = normalizeClobMarket(clobRaw);
      }
    }
    this.marketCache.set(conditionId, { at: Date.now(), m });
    return m;
  }
  async fetchMarketBySlug(slug: string): Promise<MarketInfo | null> {
    const data = await this.fetchJson<Record<string, unknown>[]>(`${this.gammaApi}/markets?slug=${encodeURIComponent(slug)}`);
    return Array.isArray(data) && data[0] ? normalizeMarket(data[0]) : null;
  }
  /** Поиск рынков по тексту (public-search) с фолбэком на фильтрацию активных */
  async searchMarkets(query: string, limit = 20): Promise<MarketInfo[]> {
    const data = await this.fetchJson<{ events?: { markets?: Record<string, unknown>[] }[] }>(`${this.gammaApi}/public-search?q=${encodeURIComponent(query)}&limit_per_type=${limit}`);
    const fromSearch = (data?.events ?? []).flatMap((e) => e.markets ?? []).map(normalizeMarket).filter((m) => !m.closed);
    if (fromSearch.length) return fromSearch.slice(0, limit);
    const all = await this.fetchActiveMarkets(200, 0, 365);
    const q = query.toLowerCase();
    return all.filter((m) => m.question.toLowerCase().includes(q)).slice(0, limit);
  }
  async fetchActiveMarkets(limit = 100, minVolume = 10000, maxDaysToEnd = 30): Promise<MarketInfo[]> {
    const now = new Date().toISOString();
    const maxDate = new Date(Date.now() + maxDaysToEnd * 86400_000).toISOString();
    const data = await this.fetchJson<Record<string, unknown>[]>(`${this.gammaApi}/markets?closed=false&active=true&end_date_min=${now}&end_date_max=${maxDate}&limit=${limit}&order=volumeNum&ascending=false`);
    if (!Array.isArray(data)) return [];
    const maxTs = Date.now() + maxDaysToEnd * 86400_000;
    return data.map(normalizeMarket).filter((m) => {
      if (m.closed || !m.acceptingOrders || m.outcomePrices.length < 2 || m.volumeUsd < minVolume) return false;
      if (m.endDate) { const e = new Date(m.endDate).getTime(); if (e > maxTs || e < Date.now()) return false; }
      return true;
    });
  }
  async fetchMarketsForArb(minVolumeUsd: number): Promise<MarketInfo[]> {
    const data = await this.fetchJson<Record<string, unknown>[]>(`${this.gammaApi}/markets?closed=false&active=true&limit=100&order=volumeNum&ascending=false`);
    if (!Array.isArray(data)) return [];
    return data.map(normalizeMarket).filter((m) => !m.closed && m.acceptingOrders && m.outcomes.length === 2 && m.clobTokenIds.length === 2 && m.volumeUsd >= minVolumeUsd);
  }

  // ── CLOB: цены ──
  async fetchMidPrice(tokenId: string): Promise<number | null> {
    const midResp = await this.fetchJson<{ mid_price?: string; mid?: string }>(
      `${this.clobApi}/midpoint?token_id=${tokenId}`,
      { retries: 1 }
    );
    const midStr = midResp?.mid_price ?? midResp?.mid;
    const midNum = midStr ? parseFloat(String(midStr)) : NaN;
    if (Number.isFinite(midNum) && midNum > 0) return midNum;

    const book = await this.fetchOrderBook(tokenId);
    if (book && Number.isFinite(book.bestBid) && Number.isFinite(book.bestAsk) && book.bestBid > 0 && book.bestAsk > 0) {
      const mid = (book.bestBid + book.bestAsk) / 2;
      if (Number.isFinite(mid) && mid > 0) return mid;
    }

    const px = await this.fetchJson<{ price?: string }>(`${this.clobApi}/price?token_id=${tokenId}&side=SELL`, { retries: 1 });
    const pxNum = px ? parseFloat(String(px.price)) : NaN;
    return Number.isFinite(pxNum) && pxNum > 0 ? pxNum : null;
  }
  /** Стакан: нужен для честного paper-исполнения (проскальзывание) и для оценки ликвидности */
  async fetchOrderBook(tokenId: string): Promise<OrderBook | null> {
    const b = await this.fetchJson<{ bids?: { price: string; size: string }[]; asks?: { price: string; size: string }[] }>(`${this.clobApi}/book?token_id=${tokenId}`, { retries: 1 });
    if (!b) return null;
    const bids = (b.bids ?? []).map((x) => ({ price: Number(x.price), size: Number(x.size) })).sort((a, c) => c.price - a.price);
    const asks = (b.asks ?? []).map((x) => ({ price: Number(x.price), size: Number(x.size) })).sort((a, c) => a.price - c.price);
    const bestBid = bids[0]?.price ?? 0, bestAsk = asks[0]?.price ?? 1;
    const depthUsd = asks.slice(0, 5).reduce((s, a) => s + a.price * a.size, 0);
    return { tokenId, bids, asks, bestBid, bestAsk, spread: bestAsk - bestBid, depthUsd };
  }
  /** Средняя цена исполнения маркет-ордера на $usd по стакану (walk the book) */
  async estimateFill(tokenId: string, side: "BUY" | "SELL", usdOrShares: number): Promise<{ avgPrice: number; filled: number; slippage: number } | null> {
    const book = await this.fetchOrderBook(tokenId);
    if (!book) return null;
    const levels = side === "BUY" ? book.asks : book.bids;
    const ref = side === "BUY" ? book.bestAsk : book.bestBid;
    let remaining = usdOrShares, cost = 0, shares = 0;
    for (const l of levels) {
      if (remaining <= 0) break;
      if (side === "BUY") {
        const take = Math.min(remaining, l.price * l.size);
        shares += take / l.price; cost += take; remaining -= take;
      } else {
        const take = Math.min(remaining, l.size);
        shares += take; cost += take * l.price; remaining -= take;
      }
    }
    if (shares <= 0) return null;
    const avg = cost / shares;
    return { avgPrice: avg, filled: side === "BUY" ? cost : shares, slippage: Math.abs(avg - ref) };
  }
  async fetchPriceHistory(tokenId: string, interval: "1h" | "6h" | "1d" | "1w" | "max" = "1d", fidelity = 5): Promise<PricePoint[]> {
    const d = await this.fetchJson<{ history?: { t: number; p: number }[] }>(`${this.clobApi}/prices-history?market=${tokenId}&interval=${interval}&fidelity=${fidelity}`, { retries: 1 });
    return d?.history ?? [];
  }
  async ping(): Promise<{ dataApi: boolean; gammaApi: boolean; clobApi: boolean }> {
    const [a, b, c] = await Promise.all([
      this.fetchJson(`${this.dataApi}/trades?limit=1`, { retries: 0 }),
      this.fetchJson(`${this.gammaApi}/markets?limit=1`, { retries: 0 }),
      this.fetchJson(`${this.clobApi}/time`, { retries: 0 }),
    ]);
    return { dataApi: a !== null, gammaApi: b !== null, clobApi: c !== null };
  }
}

/** data-api иногда возвращает одну и ту же сделку дважды (разные страницы/дубль индексатора) */
function dedupeTrades(ts: WhaleTrade[]): WhaleTrade[] {
  const seen = new Set<string>();
  return ts.filter((t) => {
    const k = t.transactionHash ? `${t.transactionHash}:${t.asset}:${t.side}` : `${t.asset}:${t.side}:${t.timestamp}:${t.size}:${t.price}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export type WhaleCandidate = {
  address: string;
  wallet: string;
  name: string;
  trades: number;
  volumeUsd: number;
  lastTrade: number;
  markets: string[];
  buyRatio: number;
  avgPrice: number;
};

export function aggregateWhales(trades: WhaleTrade[], minTrades = 3): WhaleCandidate[] {
  const map = new Map<
    string,
    {
      address: string;
      wallet: string;
      name: string;
      trades: number;
      buyTrades: number;
      volumeUsd: number;
      totalShares: number;
      lastTrade: number;
      marketsSet: Set<string>;
    }
  >();

  for (const t of trades) {
    const addr = t.proxyWallet;
    if (!addr) continue;
    const cur = map.get(addr) ?? {
      address: addr,
      wallet: addr,
      name: t.name || t.pseudonym || (addr.slice(0, 8) + "…"),
      trades: 0,
      buyTrades: 0,
      volumeUsd: 0,
      totalShares: 0,
      lastTrade: 0,
      marketsSet: new Set<string>(),
    };
    cur.trades++;
    if (t.side === "BUY") cur.buyTrades++;
    const cost = (t.size || 0) * (t.price || 0);
    cur.volumeUsd += cost;
    cur.totalShares += t.size || 0;
    cur.lastTrade = Math.max(cur.lastTrade, t.timestamp || 0);
    if (t.title) cur.marketsSet.add(t.title);
    map.set(addr, cur);
  }

  return [...map.values()]
    .filter((w) => w.trades >= minTrades)
    .map((w) => ({
      address: w.address,
      wallet: w.wallet,
      name: w.name,
      trades: w.trades,
      volumeUsd: w.volumeUsd,
      lastTrade: w.lastTrade,
      markets: [...w.marketsSet].slice(0, 5),
      buyRatio: w.trades ? w.buyTrades / w.trades : 0,
      avgPrice: w.totalShares ? w.volumeUsd / w.totalShares : 0,
    }))
    .sort((a, b) => b.volumeUsd - a.volumeUsd);
}
