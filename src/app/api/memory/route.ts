import { forget, forgetAll, listMemory, memoryStats, remember, type MemoryKind } from "@/lib/bot/memory";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const kind = (u.searchParams.get("kind") || undefined) as MemoryKind | undefined;
  const limit = Math.min(1000, Number(u.searchParams.get("limit") ?? 200) || 200);
  const [items, stats] = await Promise.all([listMemory(limit, kind), memoryStats()]);
  return Response.json({ items, stats });
}

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as {
    content?: string;
    kind?: MemoryKind;
    subject?: string;
    importance?: number;
  };
  if (!b.content?.trim()) return Response.json({ error: "content required" }, { status: 400 });
  await remember(b.kind ?? "user_note", b.subject ?? "", b.content, { importance: b.importance ?? 0.85 });
  return Response.json({ ok: true });
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (id === "all") await forgetAll();
  else if (id) await forget(Number(id));
  else return Response.json({ error: "id required" }, { status: 400 });
  return Response.json({ ok: true });
}
