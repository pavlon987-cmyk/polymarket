/**
 * SSE /api/stream — дашборд и чат получают события мгновенно:
 *   price | book | position | cycle | fill | log | chat
 * Клиент: const es = new EventSource("/api/stream"); es.onmessage = (e) => JSON.parse(e.data)
 */
import { realtime } from "@/lib/bot/realtime";
import { computeLedger } from "@/lib/bot/ledger";
import { getSettings } from "@/lib/bot/store";
import type { TradingMode } from "@/lib/bot/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const settings = await getSettings();
  const mode = (new URL(req.url).searchParams.get("mode") ?? settings.tradingMode) as TradingMode;
  const enc = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true;
        }
      };
      send({ type: "hello", data: { mode, ledger: await computeLedger(mode).catch(() => null) } });
      const onEvent = (ev: unknown) => send(ev);
      realtime.on("event", onEvent);
      // раз в 15 с — леджер целиком (дешёвый агрегат в SQL), чтобы карточки эквити всегда были честными
      const tick = setInterval(async () => send({ type: "ledger", data: await computeLedger(mode).catch(() => null) }), 15_000);
      const ping = setInterval(() => send({ type: "ping", data: Date.now() }), 25_000);
      req.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(tick);
        clearInterval(ping);
        realtime.off("event", onEvent);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}
