import { getRunnerState, startLoop, stopLoop } from "@/lib/bot/runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json(getRunnerState());
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action === "start") return Response.json(await startLoop(true, 500));
  if (body.action === "stop") return Response.json(await stopLoop(true));
  return Response.json({ error: "action must be start|stop" }, { status: 400 });
}
