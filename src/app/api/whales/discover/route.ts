import { aggregateWhales, PolymarketClient } from "@/lib/bot/polymarket";
import { getSettings } from "@/lib/bot/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const settings = await getSettings();
  const limit = Math.min(1000, Number(new URL(req.url).searchParams.get("limit") ?? 500) || 500);
  const messages: string[] = [];
  const api = new PolymarketClient({ settings: { ...settings, requestDelayMs: 0 }, log: (m) => messages.push(m) });
  const trades = await api.fetchRecentTrades(limit);
  return Response.json({ candidates: aggregateWhales(trades, 25), sampled: trades.length, messages });
}
