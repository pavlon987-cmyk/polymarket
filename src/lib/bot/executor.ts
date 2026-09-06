import type { Settings } from "@/db/schema";
import { PolymarketClient } from "./polymarket";
import type { TradingMode } from "./types";

export type BuyResult = {
  ok: boolean;
  shares: number;
  avgPrice: number;
  costUsd: number;
  orderId?: string;
  error?: string;
};

export type SellResult = {
  ok: boolean;
  proceedsUsd: number;
  avgPrice: number;
  orderId?: string;
  error?: string;
};

export interface Executor {
  readonly mode: TradingMode;
  buy(args: { tokenId: string; price: number; usd: number; market: string }): Promise<BuyResult>;
  sell(args: { tokenId: string; shares: number; price: number; market: string }): Promise<SellResult>;
  balanceUsd(): Promise<number | null>;
}

/**
 * Нормализация чисел из CLOB:
 * - иногда приходят строки
 * - иногда base units (микро, 1e6)
 * - иногда уже decimal
 */
function parseClobAmount(v: unknown): number {
  if (v === null || v === undefined) return 0;

  if (typeof v === "number") return Number.isFinite(v) ? v : 0;

  const s = String(v).trim();
  if (!s) return 0;

  if (s.includes(".")) {
    const f = Number.parseFloat(s);
    return Number.isFinite(f) ? f : 0;
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return 0;

  // эвристика: если похоже на микро-единицы
  if (n >= 1_000_000) return n / 1e6;

  return n;
}

function r2(n: number) {
  return Math.floor(n * 100) / 100;
}

export class PaperExecutor implements Executor {
  readonly mode: TradingMode = "paper";

  constructor(private readonly api: PolymarketClient, private readonly feeBps = 0) {}

  async buy({ tokenId, price, usd }: { tokenId: string; price: number; usd: number; market: string }): Promise<BuyResult> {
    const est = await this.api.estimateFill(tokenId, "BUY", usd);
    const avg = est?.avgPrice ?? price;

    // как и было: требуем ≥90% ликвидности
    if (est && est.filled < usd * 0.9) {
      return { ok: false, shares: 0, avgPrice: avg, costUsd: 0, error: `в стакане только $${est.filled.toFixed(2)} ликвидности` };
    }

    if (avg - price > 0.05) {
      return { ok: false, shares: 0, avgPrice: avg, costUsd: 0, error: `проскальзывание ${((avg - price) * 100).toFixed(1)}¢ > 5¢` };
    }

    const fee = usd * (this.feeBps / 10_000);
    const shares = (usd - fee) / avg;

    return { ok: true, shares, avgPrice: usd / shares, costUsd: usd };
  }

  async sell({ tokenId, shares, price }: { tokenId: string; shares: number; price: number; market: string }): Promise<SellResult> {
    const est = await this.api.estimateFill(tokenId, "SELL", shares);
    const avg = est?.avgPrice ?? price;

    // ФИКС: продаём только если в стакане можно исполнить почти всё (≥90%),
    // иначе engine закроет позицию “целиком”, хотя по оценке продалось бы частично.
    if (est && est.filled < shares * 0.9) {
      return {
        ok: false,
        proceedsUsd: 0,
        avgPrice: avg,
        error: `в стакане на покупку ликвидности мало (${est.filled.toFixed(2)} из ${shares.toFixed(2)} шт.)`,
      };
    }

    const feeFactor = 1 - this.feeBps / 10_000;
    const proceeds = shares * avg * feeFactor;

    return { ok: true, proceedsUsd: proceeds, avgPrice: avg };
  }

  async balanceUsd() {
    return null;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export class LiveExecutor implements Executor {
  readonly mode: TradingMode = "live";

  private client: any | null = null;
  private mod: any | null = null;

  public creds: { key: string; secret: string; passphrase: string } | null = null;

  constructor(private readonly settings: Settings, private readonly log: (m: string) => void) {}

  private async getClient(): Promise<any> {
    if (this.client) return this.client;

    const readiness = liveReadiness(this.settings);
    if (!readiness.ready) throw new Error(`Live-режим не готов: ${readiness.reasons.join("; ")}`);

    const mod: any = await import("@polymarket/clob-client");
    const ethers: any = await import("ethers");
    this.mod = mod;

    const host = this.settings.clobApiUrl || "https://clob.polymarket.com";
    const chainId = Number(process.env.POLYMARKET_CHAIN_ID ?? 137);

    const signer = new ethers.Wallet(process.env.POLYMARKET_PRIVATE_KEY as string);
    const signatureType = Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? 2);
    const funder = process.env.POLYMARKET_FUNDER_ADDRESS as string;

    const tmp = new mod.ClobClient(host, chainId, signer);
    const creds = await tmp.createOrDeriveApiKey();

    this.client = new mod.ClobClient(host, chainId, signer, creds, signatureType, funder);
    this.creds = creds;

    this.log(`🔐 CLOB-клиент готов (signer ${signer.address.slice(0, 10)}…, funder ${funder.slice(0, 10)}…)`);
    return this.client;
  }

  async balanceUsd(): Promise<number | null> {
    try {
      const client = await this.getClient();
      const res = await client.getBalanceAllowance({ asset_type: this.mod.AssetType.COLLATERAL });

      // ФИКС: нормализуем (может быть string/base units)
      const bal = parseClobAmount(res?.balance ?? 0);
      return Number.isFinite(bal) ? bal : null;
    } catch (err) {
      this.log(`⚠️ Баланс USDC недоступен: ${(err as Error).message}`);
      return null;
    }
  }

  async buy({ tokenId, price, usd, market }: { tokenId: string; price: number; usd: number; market: string }): Promise<BuyResult> {
    try {
      const client = await this.getClient();

      const amountUsd = r2(usd);
      if (amountUsd < 1) return { ok: false, shares: 0, avgPrice: price, costUsd: 0, error: "Минимальный ордер $1" };

      // небольшой буфер к цене, чтобы FOK чаще проходил
      const limitPx = Math.min(0.99, r2(price + 0.02));

      // BUY: amount = USDC
      const order = await client.createMarketOrder({
        side: this.mod.Side.BUY,
        tokenID: tokenId,
        amount: amountUsd,
        price: limitPx,
      });

      const resp = await client.postOrder(order, this.mod.OrderType.FOK);
      if (!resp?.success) return { ok: false, shares: 0, avgPrice: price, costUsd: 0, error: resp?.errorMsg || JSON.stringify(resp) };

      const costUsd = parseClobAmount(resp.makingAmount) || amountUsd;
      const shares = parseClobAmount(resp.takingAmount) || (limitPx > 0 ? costUsd / limitPx : 0);

      if (!(shares > 0)) return { ok: false, shares: 0, avgPrice: price, costUsd: 0, error: `BUY success, но takingAmount=0 (order ${resp.orderID})` };

      this.log(`💸 LIVE BUY ${market.slice(0, 40)} — ${shares.toFixed(2)} шт. за $${costUsd.toFixed(2)} (order ${resp.orderID})`);
      return { ok: true, shares, avgPrice: costUsd / shares, costUsd, orderId: String(resp.orderID ?? "") };
    } catch (err) {
      return { ok: false, shares: 0, avgPrice: price, costUsd: 0, error: (err as Error).message };
    }
  }

  async sell({ tokenId, shares, price, market }: { tokenId: string; shares: number; price: number; market: string }): Promise<SellResult> {
    try {
      const client = await this.getClient();

      const size = r2(shares); // SELL: amount = shares
      if (size < 1) return { ok: false, proceedsUsd: 0, avgPrice: price, error: "Меньше 1 акции — нечего продавать (дождись резолва и redeem)" };

      const limitPx = Math.max(0.01, r2(price - 0.02));

      // SELL: amount = shares
      const order = await client.createMarketOrder({
        side: this.mod.Side.SELL,
        tokenID: tokenId,
        amount: size,
        price: limitPx,
      });

      // ФИКС: убран GTC fallback — сейчас у проекта нет учёта pending/partial fills в positions,
      // поэтому GTC делает рассинхрон (ордер стоит, позиция OPEN, дальше повторные sell и т.п.).
      const resp = await client.postOrder(order, this.mod.OrderType.FOK);
      if (!resp?.success) return { ok: false, proceedsUsd: 0, avgPrice: price, error: resp?.errorMsg || JSON.stringify(resp) };

      const proceedsUsd = parseClobAmount(resp.takingAmount) || size * limitPx;
      const avgPrice = proceedsUsd / size;

      this.log(`📤 LIVE SELL ${market.slice(0, 40)} — ${size} шт. за $${proceedsUsd.toFixed(2)} (order ${resp.orderID})`);
      return { ok: true, proceedsUsd, avgPrice, orderId: String(resp.orderID ?? "") };
    } catch (err) {
      return { ok: false, proceedsUsd: 0, avgPrice: price, error: (err as Error).message };
    }
  }
}

export type LiveReadiness = {
  ready: boolean;
  reasons: string[];
  envPresent: { privateKey: boolean; funder: boolean; enabledFlag: boolean };
};

export function liveReadiness(s: Settings): LiveReadiness {
  const envPresent = {
    privateKey: Boolean(process.env.POLYMARKET_PRIVATE_KEY),
    funder: Boolean(process.env.POLYMARKET_FUNDER_ADDRESS),
    enabledFlag: process.env.LIVE_TRADING_ENABLED === "true",
  };

  const reasons: string[] = [];
  if (s.tradingMode !== "live") reasons.push("Режим в настройках = paper");
  if (!s.liveArmed) reasons.push("Не включён тумблер «Разрешить реальные сделки»");
  if (!envPresent.enabledFlag) reasons.push("Нет LIVE_TRADING_ENABLED=true");
  if (!envPresent.privateKey) reasons.push("Нет POLYMARKET_PRIVATE_KEY");
  if (!envPresent.funder) reasons.push("Нет POLYMARKET_FUNDER_ADDRESS");

  return { ready: reasons.length === 0, reasons, envPresent };
}

export function createExecutor(settings: Settings, log: (m: string) => void): { executor: Executor; mode: TradingMode; note?: string } {
  const api = new PolymarketClient({ settings, log });

  if (settings.tradingMode === "live") {
    const r = liveReadiness(settings);
    if (r.ready) return { executor: new LiveExecutor(settings, log), mode: "live" };
    return { executor: new PaperExecutor(api, settings.paperFeeBps ?? 0), mode: "paper", note: `Live не активирован (${r.reasons.join("; ")}) — работаю как paper` };
  }

  return { executor: new PaperExecutor(api, settings.paperFeeBps ?? 0), mode: "paper" };
}
