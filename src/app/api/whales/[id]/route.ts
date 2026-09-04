import { deleteWhale, listWhales, updateWhale } from "@/lib/bot/store";
import { PolymarketClient } from "@/lib/bot/polymarket";
import { getSettings } from "@/lib/bot/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const body = await req.json();
  const whale = await updateWhale(Number(id), body);
  if (!whale) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ whale });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  await deleteWhale(Number(id));
  return Response.json({ ok: true });
}

/** Проверка активности кита: последние сделки */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const whale = (await listWhales()).find((w) => w.id === Number(id));
  if (!whale) return Response.json({ error: "not found" }, { status: 404 });
  const settings = await getSettings();
  const messages: string[] = [];
  const api = new PolymarketClient({ settings: { ...settings, requestDelayMs: 0 }, log: (m) => messages.push(m) });
  const trades = await api.fetchWhaleTrades(whale.address, 30);
  const last = trades[0];
  const now = Date.now() / 1000;
  const buys = trades.filter((t) => t.side === "BUY");
  return Response.json({
    whale,
    count: trades.length,
    lastTradeAt: last ? new Date(last.timestamp * 1000).toISOString() : null,
    lastTradeAgeMin: last ? Math.round((now - last.timestamp) / 60) : null,
    volumeUsd: trades.reduce((s, t) => s + t.size * t.price, 0),
    avgBuyPrice: buys.length ? buys.reduce((s, t) => s + t.price, 0) / buys.length : null,
    recent: trades.slice(0, 10).map((t) => ({
      side: t.side, title: t.title, outcome: t.outcome, price: t.price, usd: t.size * t.price,
      at: new Date(t.timestamp * 1000).toISOString(),
    })),
    messages,
  });
}
