import { createWhale, listWhales } from "@/lib/bot/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json({ whales: await listWhales() });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const address = String(body.address ?? "").trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return Response.json({ error: "Неверный адрес (ожидается 0x + 40 hex)" }, { status: 400 });
    }
    const whale = await createWhale({
      address,
      name: String(body.name ?? ""),
      category: body.category,
      strategy: body.strategy ?? {},
      notes: body.notes ?? "",
      enabled: body.enabled ?? true,
    });
    return Response.json({ whale }, { status: 201 });
  } catch (err) {
    const msg = (err as Error).message;
    const status = /unique|duplicate/i.test(msg) ? 409 : 500;
    return Response.json({ error: status === 409 ? "Такой адрес уже добавлен" : msg }, { status });
  }
}
