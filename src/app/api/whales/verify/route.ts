import { getSettings, listVerifiedWallets, upsertVerifiedWallet } from "@/lib/bot/store";
import { PolymarketClient } from "@/lib/bot/polymarket";
import { verifyWallet } from "@/lib/bot/walletverifier";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json({ wallets: await listVerifiedWallets() });
}

export async function POST(req: Request) {
  const { address } = await req.json();
  const settings = await getSettings();
  const api = new PolymarketClient({ settings: { ...settings, requestDelayMs: 0 } });
  const score = await verifyWallet(api, address, settings);
  await upsertVerifiedWallet({
    address: score.address,
    name: score.name,
    score: score.score,
    totalTrades: score.totalTrades,
    winRate: score.winRate,
    totalVolumeUsd: score.totalVolumeUsd,
    avgTradeSizeUsd: score.avgTradeSizeUsd,
    avgPrice: score.avgPrice,
    profitableDays: score.profitableDays,
    totalDays: score.totalDays,
    maxDrawdownPct: score.maxDrawdownPct,
    verified: score.verified,
    category: score.category,
    notes: score.notes.join("; "),
  });
  return Response.json({ score });
}
