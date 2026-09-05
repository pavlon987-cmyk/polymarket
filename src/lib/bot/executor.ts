/**
 * ПАТЧ executor.ts
 *
 *  • PaperExecutor исполнял по «средней» цене без проскальзывания и комиссии → paper-результат
 *    систематически завышен (особенно «Фаворит на финише» с доходом 3%: реальный ask на 1–2¢ хуже).
 *    Теперь paper ходит по СТАКАНУ (walk the book) + учитывает taker-fee, если рынок его имеет.
 *  • LiveExecutor.sell: FOK-маркет на продажу требует amount в ШТУКАХ, а не в USD; добавлен
 *    фолбэк GTC-лимит по best bid, если FOK отклонён; проверка минимального размера.
 *  • createExecutor принимает переопределение режима (нужно чату).
 */
import type { Settings } from "@/db/schema";
import { PolymarketClient } from "./polymarket";
import type { TradingMode } from "./types";

export type BuyResult = { ok: boolean; shares: number; avgPrice: number; costUsd: number; orderId?: string; error?: string };
export type SellResult = { ok: boolean; proceedsUsd: number; avgPrice: number; orderId?: string; error?: string };
export interface Executor {
  readonly mode: TradingMode;
  buy(args: { tokenId: string; price: number; usd: number; market: string }): Promise<BuyResult>;
  sell(args: { tokenId: string; shares: number; price: number; market: string }): Promise<SellResult>;
  balanceUsd(): Promise<number | null>;
}

export class PaperExecutor implements Executor {
  readonly mode: TradingMode = "paper";
  constructor(private readonly api: PolymarketClient, private readonly feeBps = 0) {}

  async buy({ tokenId, price, usd }: { tokenId: string; price: number; usd: number; market: string }): Promise<BuyResult> {
    const est = await this.api.estimateFill(tokenId, "BUY", usd);
    const avg = est?.avgPrice ?? price;
    if (est && est.filled < usd * 0.9) return { ok: false, shares: 0, avgPrice: avg, costUsd: 0, error: `в стакане только $${est.filled.toFixed(2)} ликвидности` };
    if (avg - price > 0.05) return { ok: false, shares: 0, avgPrice: avg, costUsd: 0, error: `проскальзывание ${((avg - price) * 100).toFixed(1)}¢ > 5¢` };
    const fee = usd * (this.feeBps / 10_000);
    const shares = (usd - fee) / avg;
    return { ok: true, shares, avgPrice: usd / shares, costUsd: usd };
  }
  async sell({ tokenId, shares, price }: { tokenId: string; shares: number; price: number; market: string }): Promise<SellResult> {
    const est = await this.api.estimateFill(tokenId, "SELL", shares);
    const avg = est?.avgPrice ?? price;
    if (est && est.filled < shares * 0.1) {
      return { ok: false, proceedsUsd: 0, avgPrice: avg, error: `в стакане на покупку нет достаточной ликвидности (${est.filled.toFixed(2)} из ${shares.toFixed(2)})` };
    }
    const filledShares = est ? Math.min(shares, est.filled) : shares;
    const proceeds = filledShares * avg * (1 - this.feeBps / 10_000);
    return { ok: true, proceedsUsd: proceeds, avgPrice: avg };
  }
  async balanceUsd() { return null; }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
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
    const signatureType = Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? 2);
    const funder = process.env.POLYMARKET_FUNDER_ADDRESS as string;
    const tmp = new mod.ClobClient(host, chainId, signer);
    const creds = await tmp.createOrDeriveApiKey();
    this.client = new mod.ClobClient(host, chainId, signer, creds, signatureType, funder);
    this.creds = creds;
    this.log(`🔐 CLOB-клиент готов (signer ${signer.address.slice(0, 10)}…, funder ${funder.slice(0, 10)}…)`);
    return this.client;
  }
  public creds: { key: string; secret: string; passphrase: string } | null = null;

  async balanceUsd(): Promise<number | null> {
    try {
      const client = await this.getClient();
      const res = await client.getBalanceAllowance({ asset_type: this.mod.AssetType.COLLATERAL });
      const bal = Number(res?.balance ?? 0) / 1e6;
      return Number.isFinite(bal) ? bal : null;
    } catch (err) {
      this.log(`⚠️  Баланс USDC недоступен: ${(err as Error).message}`);
      return null;
    }
  }

  async buy({ tokenId, price, usd, market }: { tokenId: string; price: number; usd: number; market: string }): Promise<BuyResult> {
    try {
      const client = await this.getClient();
      const amount = Math.floor(usd * 100) / 100;
      if (amount < 1) return { ok: false, shares: 0, avgPrice: price, costUsd: 0, error: "Минимальный ордер $1" };
      const order = await client.createMarketOrder({ side: this.mod.Side.BUY, tokenID: tokenId, amount, price: Math.min(0.99, Math.round((price + 0.02) * 100) / 100) });
      const resp = await client.postOrder(order, this.mod.OrderType.FOK);
      if (!resp?.success) return { ok: false, shares: 0, avgPrice: price, costUsd: 0, error: resp?.errorMsg || JSON.stringify(resp) };
      const making = Number(resp.makingAmount ?? amount);
      const taking = Number(resp.takingAmount ?? 0);
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
      const size = Math.floor(shares * 100) / 100; // для SELL amount = количество ШТУК
      if (size < 1) return { ok: false, proceedsUsd: 0, avgPrice: price, error: "Меньше 1 акции — нечего продавать (дождись резолва и redeem)" };
      const limitPx = Math.max(0.01, Math.round((price - 0.02) * 100) / 100);
      const order = await client.createMarketOrder({ side: this.mod.Side.SELL, tokenID: tokenId, amount: size, price: limitPx });
      let resp = await client.postOrder(order, this.mod.OrderType.FOK);
      if (!resp?.success) {
        // Фолбэк: GTC-лимит по best bid — ордер встаёт в стакан, ждёт исполнения через WS/fill
        const lim = await client.createOrder({ side: this.mod.Side.SELL, tokenID: tokenId, size, price: limitPx });
        resp = await client.postOrder(lim, this.mod.OrderType.GTC);
        if (!resp?.success) return { ok: false, proceedsUsd: 0, avgPrice: price, error: resp?.errorMsg || JSON.stringify(resp) };
        this.log(`📤 LIVE SELL: FOK отклонён, GTC-лимит ${limitPx} выставлен в стакан для ${market.slice(0, 35)} (order ${resp.orderID})`);
        return { ok: false, proceedsUsd: 0, avgPrice: limitPx, orderId: String(resp.orderID ?? ""), error: "GTC-лимит размещён в стакане, ожидаем исполнения" };
      }
      const proceeds = Number(resp.takingAmount ?? size * price); // при SELL получаем USDC = takingAmount
      const avg = proceeds / size;
      this.log(`📤 LIVE SELL ${market.slice(0, 40)} — ${size} шт. за $${proceeds.toFixed(2)} (order ${resp.orderID})`);
      return { ok: true, proceedsUsd: proceeds, avgPrice: avg, orderId: String(resp.orderID ?? "") };
    } catch (err) {
      return { ok: false, proceedsUsd: 0, avgPrice: price, error: (err as Error).message };
    }
  }
}

export type LiveReadiness = { ready: boolean; reasons: string[]; envPresent: { privateKey: boolean; funder: boolean; enabledFlag: boolean } };
export function liveReadiness(s: Settings): LiveReadiness {
  const envPresent = { privateKey: Boolean(process.env.POLYMARKET_PRIVATE_KEY), funder: Boolean(process.env.POLYMARKET_FUNDER_ADDRESS), enabledFlag: process.env.LIVE_TRADING_ENABLED === "true" };
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
