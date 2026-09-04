import { loadConfigs, runSingleStrategy, STRATEGIES } from "@/lib/bot/strategies";
import { getSettings, sourceStats, upsertStrategyConfig } from "@/lib/bot/store";
import type { TradingMode } from "@/lib/bot/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request) {
  const s = await getSettings();
  const q = new URL(req.url).searchParams.get("mode");
  const mode: TradingMode = q === "live" || q === "paper" ? q : (s.tradingMode as TradingMode);
  const [cfgs, stats] = await Promise.all([loadConfigs(), sourceStats(mode)]);
  return Response.json({
    mode,
    aiEnabled: s.aiEnabled,
    strategies: STRATEGIES.map((d) => ({
      id: d.id,
      name: d.name,
      emoji: d.emoji,
      description: d.description,
      needsAi: d.needsAi,
      manualRun: Boolean(d.run),
      defaults: d.defaults,
      paramLabels: d.paramLabels,
      config: cfgs.get(d.id),
      stats: stats[d.id] ?? null,
    })),
  });
}

export async function PUT(req: Request) {
  const b = (await req.json()) as {
    id: string;
    enabled?: boolean;
    maxBetUsd?: number;
    maxPositions?: number;
    params?: Record<string, number | string | boolean>;
  };
  if (!STRATEGIES.some((d) => d.id === b.id)) return Response.json({ error: "unknown strategy" }, { status: 400 });
  const patch: Record<string, unknown> = {};
  if (b.enabled !== undefined) patch.enabled = Boolean(b.enabled);
  if (b.maxBetUsd !== undefined) patch.maxBetUsd = Number(b.maxBetUsd);
  if (b.maxPositions !== undefined) patch.maxPositions = Number(b.maxPositions);
  if (b.params) patch.params = b.params;
  return Response.json({ config: await upsertStrategyConfig(b.id, patch) });
}

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { id?: string; runAllEnabled?: boolean };
  try {
    if (b.runAllEnabled) {
      const cfgs = await loadConfigs();
      const results: Record<string, unknown> = {};
      for (const def of STRATEGIES) {
        const cfg = cfgs.get(def.id);
        if (!def.run || !cfg?.enabled) continue;
        try {
          results[def.id] = await runSingleStrategy(def.id);
        } catch (e) {
          results[def.id] = { scanned: 0, opened: 0, skipped: 0, notes: [(e as Error).message], notesLog: [(e as Error).message] };
        }
      }
      return Response.json({ ok: true, results });
    }
    return Response.json({ ok: true, result: await runSingleStrategy(String(b.id)) });
  } catch (err) {
    return Response.json({ ok: false, error: (err as Error).message }, { status: 400 });
  }
}
