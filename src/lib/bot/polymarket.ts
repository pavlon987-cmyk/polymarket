import type { Settings } from "@/db/schema";
import type { MarketInfo, WhaleTrade } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://polymarket.com",
  Referer: "https://polymarket.com/",
};

export type HttpOptions = {
  settings: Pick<
    Settings,
    "httpProxyUrl" | "extraHeadersJson" | "requestDelayMs" | "dataApiUrl" | "gammaApiUrl" | "clobApiUrl"
  >;
  log?: (msg: string) => void;
};

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

export class PolymarketClient {
  private readonly log: (msg: string) => void;
  private lastRequestAt = 0;
  public blockedCount = 0;

  constructor(private readonly opts: HttpOptions) {
    this.log = opts.log ?? (() => {});
  }

  get dataApi() {
    return this.opts.settings.dataApiUrl.replace(/\/$/, "");
  }
  get gammaApi() {
    return this.opts.settings.gammaApiUrl.replace(/\/$/, "");
  }
  get clobApi() {
    return this.opts.settings.clobApiUrl.replace(/\/$/, "");
  }

  async fetchJson<T = unknown>(url: string, { retries = 3, timeoutMs = 15_000 } = {}): Promise<T | null> {
    const headers = { ...BROWSER_HEADERS, ...extraHeaders(this.opts.settings.extraHeadersJson) };
    const dispatcher = await getDispatcher(this.opts.settings.httpProxyUrl);

    for (let attempt = 0; attempt <= retries; attempt++) {
      // мягкий rate-limit между запросами
      const wait = this.opts.settings.requestDelayMs - (Date.now() - this.lastRequestAt);
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const init: RequestInit & { dispatcher?: Dispatcher } = {
          headers,
          signal: controller.signal,
          cache: "no-store",
        };
        if (dispatcher) init.dispatcher = dispatcher;
        const res = await fetch(url, init);

        if (res.status === 429 || res.status === 425) {
          const backoff = 5_000 * (attempt + 1);
          this.log(`⏳ ${res.status} rate-limit → ждём ${backoff / 1000}с (${url.split("?")[0]})`);
          await sleep(backoff);
          continue;
        }
        if (res.status === 401 || res.status === 403) {
          this.blockedCount++;
          const backoff = 3_000 * (attempt + 1);
          this.log(
            `🚫 HTTP ${res.status} от ${new URL(url).host} — доступ заблокирован (гео/IP-блок Cloudflare). ` +
              (attempt < retries
                ? `Повтор через ${backoff / 1000}с…`
                : "Укажи HTTP-прокси в Настройках → Сеть или альтернативный base-URL.")
          );
          if (attempt < retries) {
            await sleep(backoff);
            continue;
          }
          return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as T;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const last = attempt === retries;
        this.log(`⚠️  ${last ? "Ошибка" : "Повтор"} ${url.split("?")[0]}: ${message}`);
        if (last) return null;
        await sleep(2_000 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  /** Сделки трейдера: /trades, при неудаче — /activity?type=TRADE */
  async fetchWhaleTrades(address: string, limit = 50): Promise<WhaleTrade[]> {
    const primary = await this.fetchJson<unknown[]>(`${this.dataApi}/trades?user=${address}&limit=${limit}`, {
      retries: 2,
    });
    if (Array.isArray(primary) && primary.length) return primary.map(normalizeTrade);

    const fallback = await this.fetchJson<unknown[]>(
      `${this.dataApi}/activity?user=${address}&limit=${limit}&type=TRADE`,
      { retries: 1 }
    );
    if (Array.isArray(fallback)) return fallback.map(normalizeTrade).filter((t) => t.conditionId);
    return Array.isArray(primary) ? primary.map(normalizeTrade) : [];
  }

  /** Последние сделки по всей бирже (для поиска китов) */
  async fetchRecentTrades(limit = 500): Promise<WhaleTrade[]> {
    const data = await this.fetchJson<unknown[]>(`${this.dataApi}/trades?limit=${limit}`);
    return Array.isArray(data) ? data.map(normalizeTrade) : [];
  }

  async fetchMarket(conditionId: string): Promise<MarketInfo | null> {
    const data = await this.fetchJson<Record<string, unknown>[]>(
      `${this.gammaApi}/markets?condition_ids=${conditionId}`
    );
    const m = Array.isArray(data) ? data[0] : null;
    if (!m || String(m.conditionId ?? "").toLowerCase() !== conditionId.toLowerCase()) return null;
    return {
      conditionId: String(m.conditionId),
      question: String(m.question ?? "Unknown Market"),
      outcomes: parseJsonArray(m.outcomes).map(String),
      outcomePrices: parseJsonArray(m.outcomePrices).map(Number),
      clobTokenIds: parseJsonArray(m.clobTokenIds).map(String),
      volumeUsd: Number(m.volumeNum ?? m.volume ?? 0),
      liquidityUsd: Number(m.liquidityNum ?? m.liquidity ?? 0),
      closed: Boolean(m.closed),
      endDate: (m.endDate as string | undefined) ?? null,
    };
  }

  /** Средняя цена токена: CLOB midpoint → CLOB price → null */
  async fetchMidPrice(tokenId: string): Promise<number | null> {
    const mid = await this.fetchJson<{ mid?: string }>(`${this.clobApi}/midpoint?token_id=${tokenId}`, {
      retries: 1,
    });
    const midNum = mid ? parseFloat(String(mid.mid)) : NaN;
    if (Number.isFinite(midNum) && midNum > 0) return midNum;

    const px = await this.fetchJson<{ price?: string }>(`${this.clobApi}/price?token_id=${tokenId}&side=SELL`, {
      retries: 1,
    });
    const pxNum = px ? parseFloat(String(px.price)) : NaN;
    return Number.isFinite(pxNum) && pxNum > 0 ? pxNum : null;
  }

  /** Поиск рынков с потенциальным арбитражем: Yes + No < 1 */
  async fetchMarketsForArb(minVolumeUsd: number): Promise<MarketInfo[]> {
    // gamma-api: ищем активные рынки с двухисходными исходами
    const data = await this.fetchJson<Record<string, unknown>[]>(
      `${this.gammaApi}/markets?closed=false&limit=100&order=volumeNum&ascending=false`
    );
    if (!Array.isArray(data)) return [];
    return data
      .map((m) => ({
        conditionId: String(m.conditionId ?? ""),
        question: String(m.question ?? "Unknown"),
        outcomes: parseJsonArray(m.outcomes).map(String),
        outcomePrices: parseJsonArray(m.outcomePrices).map(Number),
        clobTokenIds: parseJsonArray(m.clobTokenIds).map(String),
        volumeUsd: Number(m.volumeNum ?? m.volume ?? 0),
        liquidityUsd: Number(m.liquidityNum ?? m.liquidity ?? 0),
        closed: Boolean(m.closed),
        endDate: (m.endDate as string | undefined) ?? null,
      }))
      .filter(
        (m) =>
          !m.closed &&
          m.outcomes.length === 2 &&
          m.outcomePrices.length === 2 &&
          m.volumeUsd >= minVolumeUsd &&
          m.clobTokenIds.length === 2
      );
  }

  /** Получить все активные рынки для свободного плавания (с фильтром по дате) */
  async fetchActiveMarkets(limit = 100, minVolume = 10000, maxDaysToEnd = 30): Promise<MarketInfo[]> {
    const now = new Date().toISOString();
    const maxDate = new Date(Date.now() + maxDaysToEnd * 86400_000).toISOString();
    const data = await this.fetchJson<Record<string, unknown>[]>(
      `${this.gammaApi}/markets?closed=false&end_date_min=${now}&end_date_max=${maxDate}&limit=${limit}&order=volumeNum&ascending=false`
    );
    if (!Array.isArray(data)) return [];
    const maxTs = Date.now() + maxDaysToEnd * 86400_000;
    return data
      .map((m) => ({
        conditionId: String(m.conditionId ?? ""),
        question: String(m.question ?? "Unknown"),
        outcomes: parseJsonArray(m.outcomes).map(String),
        outcomePrices: parseJsonArray(m.outcomePrices).map(Number),
        clobTokenIds: parseJsonArray(m.clobTokenIds).map(String),
        volumeUsd: Number(m.volumeNum ?? m.volume ?? 0),
        liquidityUsd: Number(m.liquidityNum ?? m.liquidity ?? 0),
        closed: Boolean(m.closed),
        endDate: (m.endDate as string | undefined) ?? null,
      }))
      .filter((m) => {
        if (m.closed) return false;
        if (m.outcomePrices.length < 2) return false;
        if (m.volumeUsd < minVolume) return false;
        // Фильтр по времени: пропускаем рынки с датой окончания > maxDaysToEnd дней
        if (m.endDate) {
          const endTs = new Date(m.endDate).getTime();
          if (endTs > maxTs || endTs < Date.now()) return false;
        }
        return true;
      });
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

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeTrade(raw: unknown): WhaleTrade {
  const t = (raw ?? {}) as Record<string, unknown>;
  return {
    proxyWallet: t.proxyWallet ? String(t.proxyWallet) : undefined,
    side: String(t.side ?? "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY",
    asset: String(t.asset ?? ""),
    conditionId: String(t.conditionId ?? ""),
    price: Number(t.price ?? 0),
    size: Number(t.size ?? 0),
    timestamp: Number(t.timestamp ?? 0),
    title: String(t.title ?? ""),
    outcome: String(t.outcome ?? ""),
    outcomeIndex: t.outcomeIndex !== undefined ? Number(t.outcomeIndex) : undefined,
    transactionHash: t.transactionHash ? String(t.transactionHash) : undefined,
    name: t.name ? String(t.name) : undefined,
    pseudonym: t.pseudonym ? String(t.pseudonym) : undefined,
  };
}

export type WhaleCandidate = {
  wallet: string;
  name: string;
  trades: number;
  volumeUsd: number;
  markets: string[];
  buyRatio: number;
  avgPrice: number;
};

export function aggregateWhales(trades: WhaleTrade[], top = 25): WhaleCandidate[] {
  const byWallet = new Map<string, WhaleCandidate & { buys: number; priceSum: number; marketSet: Set<string> }>();
  for (const t of trades) {
    const w = t.proxyWallet;
    if (!w) continue;
    const s =
      byWallet.get(w) ??
      {
        wallet: w,
        name: t.name || t.pseudonym || "",
        trades: 0,
        volumeUsd: 0,
        markets: [],
        buyRatio: 0,
        avgPrice: 0,
        buys: 0,
        priceSum: 0,
        marketSet: new Set<string>(),
      };
    s.trades++;
    s.volumeUsd += t.size * t.price;
    s.priceSum += t.price;
    if (t.side === "BUY") s.buys++;
    if (t.title) s.marketSet.add(t.title);
    byWallet.set(w, s);
  }
  return [...byWallet.values()]
    .map((s) => ({
      wallet: s.wallet,
      name: s.name,
      trades: s.trades,
      volumeUsd: s.volumeUsd,
      markets: [...s.marketSet].slice(0, 3),
      buyRatio: s.trades ? s.buys / s.trades : 0,
      avgPrice: s.trades ? s.priceSum / s.trades : 0,
    }))
    .sort((a, b) => b.volumeUsd - a.volumeUsd)
    .slice(0, top);
}
