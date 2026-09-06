import { unhaltPortfolio } from "@/lib/bot/store";
import type { TradingMode } from "@/lib/bot/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { mode?: string };
  const mode: TradingMode = body.mode === "live" ? "live" : "paper";
  const portfolio = await unhaltPortfolio(mode);
  return Response.json({ ok: true, portfolio });
}
