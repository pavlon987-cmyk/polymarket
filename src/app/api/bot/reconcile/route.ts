/**
 * GET  /api/bot/reconcile?mode=paper  — показать леджер и расхождение (ничего не меняет)
 * POST /api/bot/reconcile             — пересчитать cash/realized из positions и записать
 * POST /api/bot/reconcile { "dedupe": true } — закрыть дубликаты открытых позиций (оставляет самую раннюю,
 *      остальные помечает SOLD по текущей цене с причиной "дубль")
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { positions } from "@/db/schema";
import { computeLedger, creditCash, reconcilePortfolio } from "@/lib/bot/ledger";
import { PolymarketClient } from "@/lib/bot/polymarket";
import { addLog, getSettings } from "@/lib/bot/store";
import type { TradingMode } from "@/lib/bot/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const settings = await getSettings();
  const mode = (new URL(req.url).searchParams.get("mode") ?? settings.tradingMode) as TradingMode;
  return Response.json(await computeLedger(mode));
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { mode?: string; dedupe?: boolean };
  const settings = await getSettings();
  const mode = (body.mode ?? settings.tradingMode) as TradingMode;
  const before = await computeLedger(mode);
  let deduped = 0;

  if (body.dedupe) {
    const api = new PolymarketClient({ settings });
    const open = await db.select().from(positions).where(and(eq(positions.mode, mode), eq(positions.status, "OPEN"))).orderBy(asc(positions.openedAt));
    const seen = new Set<string>();
    for (const p of open) {
      if (p.source === "hedge") continue;
      if (!seen.has(p.tokenId)) { seen.add(p.tokenId); continue; }
      const mid = (await api.fetchMidPrice(p.tokenId)) ?? p.lastPrice ?? p.price;
      const payout = p.shares * mid;
      await db.update(positions).set({ status: "SOLD", payoutUsd: payout, profitUsd: payout - p.costUsd, closeReason: "дубль позиции (reconcile --dedupe)", closedAt: new Date() }).where(eq(positions.id, p.id));
      await creditCash(mode, payout, payout - p.costUsd);
      deduped++;
      await addLog("warn", `🧹 Дубль #${p.id} ${p.market.slice(0, 40)} закрыт по ${(mid * 100).toFixed(0)}¢`);
    }
  }
  const after = await reconcilePortfolio(mode);
  return Response.json({ before, after, deduped, fixedDriftUsd: before.cashDriftUsd });
}
