import { askAi, chatCompletion } from "@/lib/bot/ai";
import { getSettings } from "@/lib/bot/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** Тест подключения к ИИ + пробное решение на синтетической сделке */
export async function POST(req: Request) {
  const s = await getSettings();
  const body = (await req.json().catch(() => ({}))) as { aiApiUrl?: string; aiModel?: string; aiApiKey?: string; aiSystemPrompt?: string };
  const ai = {
    ...s,
    aiApiUrl: body.aiApiUrl || s.aiApiUrl,
    aiModel: body.aiModel || s.aiModel,
    aiApiKey: body.aiApiKey && !body.aiApiKey.includes("…") ? body.aiApiKey : s.aiApiKey,
    aiSystemPrompt: body.aiSystemPrompt || s.aiSystemPrompt,
  };
  const t0 = Date.now();
  try {
    const ping = await chatCompletion(ai, [{ role: "user", content: "Ответь одним словом: OK" }]);
    const decision = await askAi(ai, {
      whale: { name: "🎾 Tennis Pro", category: "Tennis", notes: "", strategy: s.defaultStrategy },
      whaleStats: { copied: 12, wins: 8, losses: 4, pnlUsd: 14.2 },
      trade: { title: "Will Sinner win?", outcome: "Yes", price: 0.42, whaleUsd: 630, ageMin: 12 },
      market: { question: "Will Sinner win the US Open 2026 final?", outcomes: ["Yes", "No"], outcomePrices: [0.42, 0.58], volumeUsd: 250000, liquidityUsd: 40000, endDate: new Date(Date.now() + 86400000 * 2).toISOString(), hoursToEnd: 48 },
      portfolio: { cashUsd: 80, equityUsd: 95, openCount: 3, categoryExposureUsd: 10, categoryBudgetUsd: 30, proposedBetUsd: 4, overdraft: false },
      memory: "",
    });
    return Response.json({ ok: true, ms: Date.now() - t0, ping: ping.content.slice(0, 200), decision });
  } catch (err) {
    return Response.json({ ok: false, ms: Date.now() - t0, error: (err as Error).message }, { status: 502 });
  }
}
