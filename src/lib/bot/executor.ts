import type { Settings } from "@/db/schema";
import { PolymarketClient } from "./polymarket";
import type { TradingMode } from "./types";
import { executeClobV2Order, syncBalanceAllowance, type ApiCreds } from "./clob-v2";

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
function parseClobAmount(v: unknown, expected?: number): number {
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

  const micro = n / 1e6;
  const asIs = n;

  if (expected === undefined || !(expected > 0)) {
    return asIs <= 1000 ? asIs : micro;
  }

  const errMicro = Math.abs(micro - expected) / expected;
  const errAsIs = Math.abs(asIs - expected) / expected;

  return errMicro <= errAsIs ? micro : asIs;
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

    // требуем ≥99.9% ликвидности для предотвращения искажения PnL при partial fill
    if (est && est.filled < usd * 0.999) {
      return { ok: false, shares: 0, avgPrice: avg, costUsd: 0, error: `в стакане только $${est.filled.toFixed(2)} из $${usd.toFixed(2)}` };
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

    // требуем ≥99.9% ликвидности на bid
    if (est && est.filled < shares * 0.999) {
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

export async function getOnChainCollateralBalance(address: string): Promise<number | null> {
  if (!address || typeof address !== "string") return null;
  const rpcs = [
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon.gateway.tenderly.co",
    "https://polygon.llamarpc.com",
    "https://1rpc.io/matic",
  ];
  // Polygon tokens: pUSD (Polymarket USD), USDC.e (bridged), USDC (native)
  const tokens = [
    "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB", // pUSD
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC.e
    "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // Native USDC
  ];
  const cleanAddr = address.toLowerCase().replace("0x", "").padStart(64, "0");
  const data = "0x70a08231" + cleanAddr;

  for (const rpc of rpcs) {
    try {
      let total = 0;
      let successTokens = 0;
      for (const token of tokens) {
        const res = await fetch(rpc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data }, "latest"] }),
          signal: AbortSignal.timeout(5000),
        }).then((r) => r.json());
        if (res?.result && res.result !== "0x") {
          total += Number(BigInt(res.result)) / 1e6;
          successTokens++;
        }
      }
      if (successTokens > 0) {
        return total;
      }
    } catch {
      // try next RPC
    }
  }
  return null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export class LiveExecutor implements Executor {
  readonly mode: TradingMode = "live";

  private signer: any | null = null;
  private funder: string = "";
  private host: string = "https://clob.polymarket.com";
  private chainId: number = 137;
  public creds: ApiCreds | null = null;

  constructor(private readonly settings: Settings, private readonly log: (m: string) => void) {}

  private async getCredsAndSigner(): Promise<{ signer: any; funder: string; creds: ApiCreds; host: string; chainId: number }> {
    if (this.signer && this.creds) {
      return { signer: this.signer, funder: this.funder, creds: this.creds, host: this.host, chainId: this.chainId };
    }

    const readiness = liveReadiness(this.settings);
    if (!readiness.ready) throw new Error(`Live-режим не готов: ${readiness.reasons.join("; ")}`);

    const { ClobClient } = await import("@polymarket/clob-client");
    const { ethers } = await import("ethers");

    this.host = this.settings.clobApiUrl || "https://clob.polymarket.com";
    this.chainId = Number(process.env.POLYMARKET_CHAIN_ID ?? 137);

    this.signer = new ethers.Wallet(process.env.POLYMARKET_PRIVATE_KEY as string);
    this.funder = (process.env.POLYMARKET_FUNDER_ADDRESS as string).trim();

    if (process.env.POLYMARKET_API_KEY && process.env.POLYMARKET_API_SECRET && process.env.POLYMARKET_PASSPHRASE) {
      this.creds = {
        key: process.env.POLYMARKET_API_KEY,
        secret: process.env.POLYMARKET_API_SECRET,
        passphrase: process.env.POLYMARKET_PASSPHRASE,
      };
    } else {
      const tmp = new ClobClient(this.host, this.chainId, this.signer);
      try {
        this.creds = await tmp.deriveApiKey();
      } catch {
        this.creds = await tmp.createOrDeriveApiKey();
      }
    }

    if (!this.creds?.secret) {
      throw new Error("Не удалось получить secret для Polymarket CLOB API — проверь POLYMARKET_API_SECRET в .env");
    }

    this.log(`🔐 CLOB V2 клиент готов (signer ${this.signer.address.slice(0, 10)}…, funder ${this.funder.slice(0, 10)}…)`);
    return { signer: this.signer, funder: this.funder, creds: this.creds, host: this.host, chainId: this.chainId };
  }

  async balanceUsd(): Promise<number | null> {
    try {
      const { signer, funder, creds, host, chainId } = await this.getCredsAndSigner();
      await syncBalanceAllowance(host, signer, creds);

      // 1. Быстрый и точный баланс напрямую из Polymarket CLOB API
      try {
        const { ClobClient, AssetType } = await import("@polymarket/clob-client");
        const client = new ClobClient(host, chainId, signer, creds, 3 as any, funder);
        const res = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        if (res?.balance) {
          const bal = parseClobAmount(res.balance);
          if (bal !== null && Number.isFinite(bal) && bal >= 0) return bal;
        }
      } catch {}

      // 2. Ончейн-проверка pUSD / USDC на Polygon как надёжный fallback
      const onChainBal = await getOnChainCollateralBalance(funder);
      if (onChainBal !== null && Number.isFinite(onChainBal)) {
        return onChainBal;
      }
      return null;
    } catch (err) {
      const funder = process.env.POLYMARKET_FUNDER_ADDRESS;
      if (funder) {
        try {
          const onChainBal = await getOnChainCollateralBalance(funder);
          if (onChainBal !== null) return onChainBal;
        } catch {}
      }
      this.log(`⚠️ Баланс USDC недоступен: ${(err as Error).message}`);
      return null;
    }
  }

  async buy({ tokenId, price, usd, market }: { tokenId: string; price: number; usd: number; market: string }): Promise<BuyResult> {
    try {
      const { signer, funder, creds, host, chainId } = await this.getCredsAndSigner();

      const amountUsd = r2(usd);
      if (amountUsd < 1) return { ok: false, shares: 0, avgPrice: price, costUsd: 0, error: "Минимальный ордер $1" };

      // небольшой буфер к цене, чтобы FOK чаще проходил
      const limitPx = Math.min(0.99, r2(price + 0.02));

      const resp = await executeClobV2Order({
        host,
        chainId,
        signer,
        funder,
        creds,
        tokenId,
        side: "BUY",
        amount: amountUsd,
        price: limitPx,
        orderType: "FOK",
      });

      if (!resp.ok) return { ok: false, shares: 0, avgPrice: price, costUsd: 0, error: resp.error };

      const costUsd = parseClobAmount(resp.makingAmount, amountUsd) || amountUsd;
      const expectedShares = limitPx > 0 ? costUsd / limitPx : 0;
      const shares = parseClobAmount(resp.takingAmount, expectedShares) || expectedShares;

      if (!(shares > 0)) return { ok: false, shares: 0, avgPrice: price, costUsd: 0, error: `BUY success, но takingAmount=0 (order ${resp.orderId})` };

      this.log(`💸 LIVE BUY ${market.slice(0, 40)} — ${shares.toFixed(2)} шт. за $${costUsd.toFixed(2)} (order ${resp.orderId})`);
      return { ok: true, shares, avgPrice: costUsd / shares, costUsd, orderId: String(resp.orderId ?? "") };
    } catch (err) {
      return { ok: false, shares: 0, avgPrice: price, costUsd: 0, error: (err as Error).message };
    }
  }

  async sell({ tokenId, shares, price, market }: { tokenId: string; shares: number; price: number; market: string }): Promise<SellResult> {
    try {
      const { signer, funder, creds, host, chainId } = await this.getCredsAndSigner();

      const size = r2(shares); // SELL: amount = shares
      if (size < 1) return { ok: false, proceedsUsd: 0, avgPrice: price, error: "Меньше 1 акции — нечего продавать (дождись резолва и redeem)" };

      const limitPx = Math.max(0.01, r2(price - 0.02));

      const resp = await executeClobV2Order({
        host,
        chainId,
        signer,
        funder,
        creds,
        tokenId,
        side: "SELL",
        amount: size,
        price: limitPx,
        orderType: "FOK",
      });

      if (!resp.ok) return { ok: false, proceedsUsd: 0, avgPrice: price, error: resp.error };

      const expectedProceeds = size * limitPx;
      const proceedsUsd = parseClobAmount(resp.takingAmount, expectedProceeds) || expectedProceeds;
      const avgPrice = proceedsUsd / size;

      this.log(`📤 LIVE SELL ${market.slice(0, 40)} — ${size} шт. за $${proceedsUsd.toFixed(2)} (order ${resp.orderId})`);
      return { ok: true, proceedsUsd, avgPrice, orderId: String(resp.orderId ?? "") };
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
