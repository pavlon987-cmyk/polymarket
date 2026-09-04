import { liveReadiness } from "@/lib/bot/executor";
import { getRunnerState } from "@/lib/bot/runner";
import {
  closedPositions,
  getPortfolio,
  getSettings,
  listWhales,
  openPositions,
  positionsValue,
  recentAiDecisions,
  sourceStats,
  whaleStats,
} from "@/lib/bot/store";
import type { TradingMode } from "@/lib/bot/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const settings = await getSettings();
    const url = new URL(req.url);
    const requested = url.searchParams.get("mode");
    const mode: TradingMode = requested === "live" || requested === "paper" ? requested : (settings.tradingMode as TradingMode);

    const [portfolio, open, closed, stats, srcStats, ai, whales] = await Promise.all([
      getPortfolio(mode, settings),
      openPositions(mode),
      closedPositions(mode, 200),
      whaleStats(mode),
      sourceStats(mode),
      recentAiDecisions(mode, 40),
      listWhales(),
    ]);
    const inPositions = positionsValue(open);
    const equity = portfolio.cashUsd + inPositions;
    const readiness = liveReadiness(settings);

    return Response.json({
      mode,
      configuredMode: settings.tradingMode,
      liveReadiness: readiness,
      aiEnabled: settings.aiEnabled,
      runner: getRunnerState(),
      portfolio: { ...portfolio, inPositions, equity },
      open,
      closed,
      whaleStats: stats,
      sourceStats: srcStats,
      aiDecisions: ai,
      whalesCount: whales.length,
      enabledWhales: whales.filter((w) => w.enabled).length,
    });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
