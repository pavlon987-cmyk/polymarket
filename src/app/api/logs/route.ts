import { getLogs } from "@/lib/bot/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const limit = Math.min(1000, Number(new URL(req.url).searchParams.get("limit") ?? 200) || 200);
  return Response.json({ logs: await getLogs(limit) });
}
