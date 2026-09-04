import { PolymarketClient } from "@/lib/bot/polymarket";
import { getSettings } from "@/lib/bot/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Диагностика доступа к Polymarket API (401/403 = гео-блок → нужен прокси) */
export async function GET() {
  const settings = await getSettings();
  const messages: string[] = [];
  const api = new PolymarketClient({ settings: { ...settings, requestDelayMs: 0 }, log: (m) => messages.push(m) });
  const result = await api.ping();
  return Response.json({ ...result, blockedCount: api.blockedCount, messages, proxy: Boolean(settings.httpProxyUrl) });
}
