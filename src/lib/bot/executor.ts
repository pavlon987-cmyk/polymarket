import type { Settings } from "@/db/schema";
import type { TradingMode } from "./types";

export type BuyResult = {
  ok: boolean;
  shares: number;
  avgPrice: number;
  costUsd: number;
  orderId?: string;
  error?: string;
};
export type SellResult = { ok: boolean; proceedsUsd: number; avgPrice: number; orderId?: string; error?: string };

export interface Executor {
  readonly mode: TradingMode;
  buy(args: { tokenId: string; price: number; usd: number; market: string }): Promise<BuyResult>;
  sell(args: { tokenId: string; shares: number; price: number; market: string }): Promise<SellResult>;
  balanceUsd(): Promise<number | null>;
}

/** Бумажный исполнитель — мгновенное исполнение по цене сделки кита / текущей цене */
export class PaperExecutor implements Executor {
  readonly mode: TradingMode = "paper";
  async buy({ price, usd }: { tokenId: string; price: number; usd: number; market: string }): Promise<BuyResult> {
    return { ok: true, shares: usd / price, avgPrice: price, costUsd: usd };
  }
  async sell({ shares, price }: { tokenId: string; shares: number; price: number; market: string }): Promise<SellResult> {
    return { ok: true, proceedsUsd: shares * price, avgPrice: price };
  }
  async balanceUsd() {
    return null;
  }
}

export type LiveReadiness = {
  ready: boolean;
  reasons: string[];
  envPresent: { privateKey: boolean; funder: boolean; enabledFlag: boolean };
};

/** Проверка всех предохранителей реального режима */
export function liveReadiness(s: Settings): LiveReadiness {
  const envPresent = {
    privateKey: Boolean(process.env.POLYMARKET_PRIVATE_KEY),
    funder: Boolean(process.env.POLYMARKET_FUNDER_ADDRESS),
    enabledFlag: process.env.LIVE_TRADING_ENABLED === "true",
  };
  const reasons: string[] = [];
  if (s.tradingMode !== "live") reasons.push("Режим в настройках = paper");
  if (!s.liveArmed) reasons.push("Не включён тумблер «Разрешить реальные сделки»");
  if (!envPresent.enabledFlag) reasons.push("Нет переменной окружения LIVE_TRADING_ENABLED=true");
  if (!envPresent.privateKey) reasons.push("Нет POLYMARKET_PRIVATE_KEY");
  if (!envPresent.funder) reasons.push("Нет POLYMARKET_FUNDER_ADDRESS (адрес proxy-кошелька Polymarket)");
  return { ready: reasons.length === 0, reasons, envPresent };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Реальный исполнитель через @polymarket/clob-client (маркет-ордера FOK) */
export class LiveExecutor implements Executor {
  readonly mode: TradingMode = "live";
  private client: any | null = null;
  private mod: any | null = null;

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
    const signatureType = Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? 2); // 0=EOA, 1=Magic/email, 2=browser proxy
    const funder = process.env.POLYMARKET_FUNDER_ADDRESS as string;

    const tmp = new mod.ClobClient(host, chainId, signer);
    const creds = await tmp.createOrDeriveApiKey();
    this.client = new mod.ClobClient(host, chainId, signer, creds, signatureType, funder);
    this.log(`🔐 CLOB-клиент инициализирован (signer ${signer.address.slice(0, 10)}…, funder ${funder.slice(0, 10)}…)`);
    return this.client;
  }

  async balanceUsd(): Promise<number | null> {
    try {
      const client = await this.getClient();
      const res = await client.getBalanceAllowance({ asset_type: this.mod.AssetType.COLLATERAL });
      const bal = Number(res?.balance ?? 0) / 1e6;
      return Number.isFinite(bal) ? bal : null;
    } catch (err) {
      this.log(`⚠️  Не удалось получить баланс USDC: ${(err as Error).message}`);
      return null;
    }
  }

  async buy({ tokenId, price, usd, market }: { tokenId: string; price: number; usd: number; market: string }): Promise<BuyResult> {
    try {
      const client = await this.getClient();
      const amount = Math.floor(usd * 100) / 100;
      if (amount < 1) return { ok: false, shares: 0, avgPrice: price, costUsd: 0, error: "Минимальный ордер $1" };
      const order = await client.createMarketOrder({
        side: this.mod.Side.BUY,
        tokenID: tokenId,
        amount,
        price: Math.min(0.99, Math.round((price + 0.02) * 100) / 100), // допускаем проскальзывание 2¢
      });
      const resp = await client.postOrder(order, this.mod.OrderType.FOK);
      if (!resp?.success) {
        return { ok: false, shares: 0, avgPrice: price, costUsd: 0, error: resp?.errorMsg || JSON.stringify(resp) };
      }
      const making = Number(resp.makingAmount ?? amount); // USDC потрачено
      const taking = Number(resp.takingAmount ?? 0); // получено акций
      const shares = taking > 0 ? taking : making / price;
      const costUsd = making > 0 ? making : amount;
      this.log(`💸 LIVE BUY ${market.slice(0, 40)} — ${shares.toFixed(2)} шт. за $${costUsd.toFixed(2)} (order ${resp.orderID})`);
      return { ok: true, shares, avgPrice: costUsd / shares, costUsd, orderId: String(resp.orderID ?? "") };
    } catch (err) {
      return { ok: false, shares: 0, avgPrice: price, costUsd: 0, error: (err as Error).message };
    }
  }

  async sell({ tokenId, shares, price, market }: { tokenId: string; shares: number; price: number; market: string }): Promise<SellResult> {
    try {
      const client = await this.getClient();
      const amount = Math.floor(shares * 100) / 100;
      const order = await client.createMarketOrder({
        side: this.mod.Side.SELL,
        tokenID: tokenId,
        amount,
        price: Math.max(0.01, Math.round((price - 0.02) * 100) / 100),
      });
      const resp = await client.postOrder(order, this.mod.OrderType.FOK);
      if (!resp?.success) return { ok: false, proceedsUsd: 0, avgPrice: price, error: resp?.errorMsg || JSON.stringify(resp) };
      const taking = Number(resp.takingAmount ?? 0); // USDC получено
      const proceeds = taking > 0 ? taking : amount * price;
      this.log(`💸 LIVE SELL ${market.slice(0, 40)} — ${amount.toFixed(2)} шт. за $${proceeds.toFixed(2)} (order ${resp.orderID})`);
      return { ok: true, proceedsUsd: proceeds, avgPrice: proceeds / amount, orderId: String(resp.orderID ?? "") };
    } catch (err) {
      return { ok: false, proceedsUsd: 0, avgPrice: price, error: (err as Error).message };
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function createExecutor(s: Settings, log: (m: string) => void): { executor: Executor; mode: TradingMode; note?: string } {
  if (s.tradingMode === "live") {
    const r = liveReadiness(s);
    if (r.ready) return { executor: new LiveExecutor(s, log), mode: "live" };
    return {
      executor: new PaperExecutor(),
      mode: "paper",
      note: `Live-режим выбран, но не активирован (${r.reasons.join("; ")}). Работаю в paper.`,
    };
  }
  return { executor: new PaperExecutor(), mode: "paper" };
}
