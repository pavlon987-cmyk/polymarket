/**
 * Отслеживание цен крипто-рынков через Binance и Bybit
 * для арбитража между Polymarket и биржами
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type CryptoPrice = {
  symbol: string;
  binance: number | null;
  bybit: number | null;
  spread: number | null; // разница между биржами в %
  binanceTs: number;
  bybitTs: number;
};

// Известные рынки Polymarket связанные с крипто
export const CRYPTO_MARKETS = [
  { keywords: ["bitcoin", "btc"], symbol: "BTCUSDT", name: "Bitcoin" },
  { keywords: ["ethereum", "eth"], symbol: "ETHUSDT", name: "Ethereum" },
  { keywords: ["solana", "sol"], symbol: "SOLUSDT", name: "Solana" },
  { keywords: ["xrp", "ripple"], symbol: "XRPUSDT", name: "XRP" },
  { keywords: ["dogecoin", "doge"], symbol: "DOGEUSDT", name: "Dogecoin" },
  { keywords: ["cardano", "ada"], symbol: "ADAUSDT", name: "Cardano" },
  { keywords: ["polkadot", "dot"], symbol: "DOTUSDT", name: "Polkadot" },
  { keywords: ["avalanche", "avax"], symbol: "AVAXUSDT", name: "Avalanche" },
  { keywords: ["chainlink", "link"], symbol: "LINKUSDT", name: "Chainlink" },
  { keywords: ["matic", "polygon"], symbol: "MATICUSDT", name: "Polygon" },
  { keywords: ["litecoin", "ltc"], symbol: "LTCUSDT", name: "Litecoin" },
  { keywords: ["uniswap", "uni"], symbol: "UNIUSDT", name: "Uniswap" },
  { keywords: ["aptos", "apt"], symbol: "APTUSDT", name: "Aptos" },
  { keywords: ["sui"], symbol: "SUIUSDT", name: "Sui" },
  { keywords: ["near"], symbol: "NEARUSDT", name: "NEAR" },
  { keywords: ["pepe"], symbol: "1000PEPEUSDT", name: "Pepe" },
  { keywords: ["shiba"], symbol: "1000SHIBUSDT", name: "Shiba Inu" },
];

/**
 * Получить текущую цену с Binance (через прокси если нужен)
 */
async function fetchBinancePrice(symbol: string, proxyUrl?: string): Promise<{ price: number; ts: number } | null> {
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
  try {
    let dispatcher: unknown = undefined;
    if (proxyUrl) {
      try {
        const undici = await import("undici");
        dispatcher = new undici.ProxyAgent(proxyUrl);
      } catch {}
    }
    const init: RequestInit & { dispatcher?: unknown } = { signal: AbortSignal.timeout(5000), cache: "no-store" };
    if (dispatcher) init.dispatcher = dispatcher;
    const res = await fetch(url, init);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code) return null; // Binance error
    return { price: parseFloat(data.price), ts: Date.now() };
  } catch {
    return null;
  }
}

/**
 * Получить текущую цену с Bybit
 */
async function fetchBybitPrice(symbol: string, proxyUrl?: string): Promise<{ price: number; ts: number } | null> {
  const url = `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${symbol}`;
  try {
    let dispatcher: unknown = undefined;
    if (proxyUrl) {
      try {
        const undici = await import("undici");
        dispatcher = new undici.ProxyAgent(proxyUrl);
      } catch {}
    }
    const init: RequestInit & { dispatcher?: unknown } = { signal: AbortSignal.timeout(5000), cache: "no-store" };
    if (dispatcher) init.dispatcher = dispatcher;
    const res = await fetch(url, init);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    const ticker = data?.result?.list?.[0];
    if (!ticker) return null;
    return { price: parseFloat(ticker.lastPrice), ts: Date.now() };
  } catch {
    return null;
  }
}

/** Fallback: CoinGecko (бесплатный, без ключа) */
async function fetchCoinGeckoPrice(coinId: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(5000), cache: "no-store" }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data[coinId]?.usd ?? null;
  } catch {
    return null;
  }
}

/**
 * Получить цену крипты с бирж (+ CoinGecko fallback)
 */
export async function getCryptoPrice(symbol: string, proxyUrl?: string): Promise<CryptoPrice> {
  const coinGeckoMap: Record<string, string> = {
    BTCUSDT: "bitcoin", ETHUSDT: "ethereum", SOLUSDT: "solana",
    XRPUSDT: "ripple", DOGEUSDT: "dogecoin", ADAUSDT: "cardano",
    DOTUSDT: "polkadot", AVAXUSDT: "avalanche-2", LINKUSDT: "chainlink",
    MATICUSDT: "matic-network", LTCUSDT: "litecoin", UNIUSDT: "uniswap",
    APTUSDT: "aptos", SUIUSDT: "sui", NEARUSDT: "near",
  };

  const [binance, bybit, geckoPrice] = await Promise.all([
    fetchBinancePrice(symbol, proxyUrl),
    fetchBybitPrice(symbol, proxyUrl),
    fetchCoinGeckoPrice(coinGeckoMap[symbol] ?? ""),
  ]);

  const prices = [binance?.price, bybit?.price, geckoPrice].filter((p): p is number => p !== undefined && p !== null && p > 0);
  const avgPrice = prices.length > 0 ? prices.reduce((a: number, b: number) => a + b, 0) / prices.length : null;

  const spread =
    binance && bybit
      ? Math.abs(binance.price - bybit.price) / Math.min(binance.price, bybit.price) * 100
      : null;

  return {
    symbol,
    binance: binance?.price ?? geckoPrice ?? null,
    bybit: bybit?.price ?? null,
    spread,
    binanceTs: binance?.ts ?? Date.now(),
    bybitTs: bybit?.ts ?? Date.now(),
  };
}

/**
 * Массовое получение цен
 */
export async function getMultiplePrices(symbols: string[]): Promise<Map<string, CryptoPrice>> {
  const results = new Map<string, CryptoPrice>();
  // По 5 параллельно чтобы не долбить API
  for (let i = 0; i < symbols.length; i += 5) {
    const batch = symbols.slice(i, i + 5);
    const prices = await Promise.all(batch.map((s) => getCryptoPrice(s)));
    for (const p of prices) results.set(p.symbol, p);
    if (i + 5 < symbols.length) await sleep(200);
  }
  return results;
}

/**
 * Определить крипто-рынок по названию Polymarket
 */
export function detectCryptoMarket(marketTitle: string): typeof CRYPTO_MARKETS[number] | null {
  const lower = marketTitle.toLowerCase();
  for (const cm of CRYPTO_MARKETS) {
    if (cm.keywords.some((k) => lower.includes(k))) return cm;
  }
  return null;
}

/**
 * Арбитраж между Polymarket и биржами
 * Если Polymarket "Bitcoin above $X" торгуется по цене Y,
 * а на бирже BTC = $Z, можно найти расхождение
 */
export type CryptoArbOpportunity = {
  market: string;
  polymarketOutcome: string;
  polymarketPrice: number;
  cryptoSymbol: string;
  cryptoName: string;
  binancePrice: number | null;
  bybitPrice: number | null;
  crossExchangeSpread: number | null;
  estimatedEdge: number;
  reason: string;
};

export async function findCryptoArb(
  marketTitle: string,
  outcomes: string[],
  prices: number[],
  log: (msg: string) => void
): Promise<CryptoArbOpportunity[]> {
  const results: CryptoArbOpportunity[] = [];
  const crypto = detectCryptoMarket(marketTitle);
  if (!crypto) return results;

  const priceData = await getCryptoPrice(crypto.symbol);
  if (!priceData.binance && !priceData.bybit) return results;

  const avgPrice = priceData.binance && priceData.bybit
    ? (priceData.binance + priceData.bybit) / 2
    : priceData.binance ?? priceData.bybit ?? 0;

  log(`   📈 ${crypto.name}: Binance $${priceData.binance?.toFixed(2) ?? "?"} / Bybit $${priceData.bybit?.toFixed(2) ?? "?"} (спред: ${priceData.spread?.toFixed(3) ?? "?"}%)`);

  // Анализ: если "Bitcoin up" торгуется дёшево, а BTC растёт — потенциал
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    const price = prices[i];
    if (price <= 0 || price >= 0.95) continue;

    // Грубая оценка: если ценаBelow 0.4 и спред между биржами > 0.3% — возможен арбитраж
    const edge = priceData.spread ? priceData.spread * 2 : 0;

    if (edge > 0.3 || price < 0.3) {
      results.push({
        market: marketTitle,
        polymarketOutcome: outcome,
        polymarketPrice: price,
        cryptoSymbol: crypto.symbol,
        cryptoName: crypto.name,
        binancePrice: priceData.binance,
        bybitPrice: priceData.bybit,
        crossExchangeSpread: priceData.spread,
        estimatedEdge: Math.max(edge, (1 - price) * 10),
        reason: price < 0.3
          ? `${outcome} торгуется по ${((price) * 100).toFixed(0)}¢ — потенциал роста`
          : `Кросс-биржевой спред ${priceData.spread?.toFixed(2)}% — возможен арбитраж`,
      });
    }
  }

  return results;
}
