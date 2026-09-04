import { closedPositions, getPortfolio, getSettings, openPositions, positionsValue } from "@/lib/bot/store";
import type { TradingMode } from "@/lib/bot/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Совместимый с прошлой версией JSON портфеля (для CLI-скрипта) */
export async function GET(req: Request) {
  const settings = await getSettings();
  const requested = new URL(req.url).searchParams.get("mode");
  const mode: TradingMode = requested === "live" || requested === "paper" ? requested : (settings.tradingMode as TradingMode);
  const [p, open, closed] = await Promise.all([getPortfolio(mode, settings), openPositions(mode), closedPositions(mode, 100)]);
  return Response.json({
    exists: true,
    mode,
    portfolio: {
      stream: mode === "live" ? "LIVE_COPYTRADER" : "PAPER_COPYTRADER",
      startingBankUsd: p.startingBankUsd,
      cashUsd: p.cashUsd,
      equityUsd: p.cashUsd + positionsValue(open),
      realizedPnlUsd: p.realizedPnlUsd,
      totalInvestedUsd: p.totalInvestedUsd,
      halted: p.halted,
      openPositions: open,
      closedPositions: closed,
      createdAt: p.createdAt,
      lastUpdated: p.lastUpdated,
    },
  });
}
