import { runCycle } from "@/lib/bot/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST() {
  const result = await runCycle("manual");
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
