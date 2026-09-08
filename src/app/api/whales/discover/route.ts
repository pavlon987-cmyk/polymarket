import { aggregateWhales, PolymarketClient } from "@/lib/bot/polymarket";
import { getSettings } from "@/lib/bot/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const settings = await getSettings();
  const url = new URL(req.url);
  const limit = Math.min(1000, Number(url.searchParams.get("limit") ?? 500) || 500);
  const minTrades = Math.max(1, Number(url.searchParams.get("minTrades") ?? 3) || 3);
  const messages: string[] = [];
  const api = new PolymarketClient({ settings: { ...settings, requestDelayMs: 0 }, log: (m) => messages.push(m) });
  const trades = await api.fetchRecentTrades(limit);
  return Response.json({ candidates: aggregateWhales(trades, minTrades), sampled: trades.length, messages });
}
