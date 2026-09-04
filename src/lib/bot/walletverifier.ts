import type { Settings } from "@/db/schema";
import type { PolymarketClient } from "./polymarket";

const usd = (n: number) => `$${Math.abs(n).toFixed(2)}`;

export type WalletScore = {
  address: string;
  name: string;
  score: number;
  totalTrades: number;
  winRate: number;
  totalVolumeUsd: number;
  avgTradeSizeUsd: number;
  avgPrice: number;
  profitableDays: number;
  totalDays: number;
  maxDrawdownPct: number;
  verified: boolean;
  category: string;
  notes: string[];
};

/**
 * Верификатор кошельков
 *
 * Проверяет трейдеров по критериям:
 * - Минимальное количество сделок
 * - Win rate >= 50%
 * - Достаточный объём
 * - Максимальный drawdown < 30%
 * - Активность (торговал в последние дни)
 * - Средняя цена (не слишком рискованные ставки)
 */

export async function verifyWallet(
  api: PolymarketClient,
  address: string,
  settings: Pick<Settings, "walletMinTrades" | "walletMinWinRate" | "walletMinVolumeUsd" | "walletMaxDrawdownPct" | "walletMinScore">
): Promise<WalletScore> {
  const trades = await api.fetchWhaleTrades(address, 200);

  const score: WalletScore = {
    address: address.toLowerCase(),
    name: "",
    score: 0,
    totalTrades: trades.length,
    winRate: 0,
    totalVolumeUsd: 0,
    avgTradeSizeUsd: 0,
    avgPrice: 0,
    profitableDays: 0,
    totalDays: 0,
    maxDrawdownPct: 0,
    verified: false,
    category: "General",
    notes: [],
  };

  if (trades.length === 0) {
    score.notes.push("Нет сделок — возможно неверный адрес (нужен proxy-кошелёк)");
    return score;
  }

  // Имя
  score.name = trades[0].name || trades[0].pseudonym || `Trader ${address.slice(0, 8)}`;

  // Объём
  const buys = trades.filter((t) => t.side === "BUY");
  const sells = trades.filter((t) => t.side === "SELL");
  score.totalVolumeUsd = trades.reduce((s, t) => s + t.size * t.price, 0);
  score.avgTradeSizeUsd = trades.length ? score.totalVolumeUsd / trades.length : 0;
  score.avgPrice = buys.length ? buys.reduce((s, t) => s + t.price, 0) / buys.length : 0;

  // Win rate (грубая оценка: если купил и продал дороже = win)
  // Упрощённо: считаем сделки с ценой покупки < 0.5 и объёмом > $100 как "умные"
  const smartBuys = buys.filter((t) => t.price < 0.5 && t.size * t.price > 50);
  score.winRate = buys.length ? smartBuys.length / buys.length : 0;

  // Дни активности
  const timestamps = trades.map((t) => t.timestamp).sort((a, b) => a - b);
  const firstDay = Math.floor(timestamps[0] / 86400);
  const lastDay = Math.floor(timestamps[timestamps.length - 1] / 86400);
  score.totalDays = lastDay - firstDay + 1;

  // Дни с прибыльными сделками (цена < 0.45 и объём > $100)
  const profitableDaysSet = new Set<number>();
  for (const t of trades) {
    if (t.side === "BUY" && t.price < 0.45 && t.size * t.price > 100) {
      profitableDaysSet.add(Math.floor(t.timestamp / 86400));
    }
  }
  score.profitableDays = profitableDaysSet.size;

  // Максимальный drawdown (грубая оценка)
  let peak = 0;
  let current = 0;
  let maxDd = 0;
  for (const t of trades.sort((a, b) => a.timestamp - b.timestamp)) {
    if (t.side === "BUY") current += t.size * t.price;
    else current -= t.size * t.price;
    if (current > peak) peak = current;
    if (peak > 0) {
      const dd = (peak - current) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  score.maxDrawdownPct = maxDd;

  // Расчёт score (0-100)
  let pts = 0;

  // Количество сделок (макс 25 pts)
  pts += Math.min(25, (trades.length / 100) * 25);

  // Win rate (макс 25 pts)
  pts += Math.min(25, score.winRate * 25);

  // Объём (макс 20 pts)
  pts += Math.min(20, (score.totalVolumeUsd / 50000) * 20);

  // Дни активности (макс 15 pts)
  pts += Math.min(15, (score.totalDays / 30) * 15);

  // Прибыльные дни (макс 15 pts)
  pts += Math.min(15, (score.profitableDays / Math.max(1, score.totalDays)) * 15);

  // Штраф за drawdown
  if (score.maxDrawdownPct > 0.3) pts -= 20;
  else if (score.maxDrawdownPct > 0.2) pts -= 10;

  score.score = Math.max(0, Math.min(100, Math.round(pts)));

  // Верификация
  score.verified =
    trades.length >= settings.walletMinTrades &&
    score.winRate >= settings.walletMinWinRate &&
    score.totalVolumeUsd >= settings.walletMinVolumeUsd &&
    score.maxDrawdownPct <= settings.walletMaxDrawdownPct &&
    score.score >= settings.walletMinScore;

  // Категория
  if (score.avgPrice < 0.3) score.category = "Contrarian";
  else if (score.avgPrice > 0.7) score.category = "Momentum";
  else score.category = "Mixed";

  // Заметки
  if (score.verified) score.notes.push("✅ Верифицирован по всем критериям");
  if (trades.length < settings.walletMinTrades) score.notes.push(`Мало сделок: ${trades.length} < ${settings.walletMinTrades}`);
  if (score.winRate < settings.walletMinWinRate) score.notes.push(`Низкий win rate: ${(score.winRate * 100).toFixed(0)}%`);
  if (score.totalVolumeUsd < settings.walletMinVolumeUsd) score.notes.push(`Малый объём: ${usd(score.totalVolumeUsd)}`);
  if (score.maxDrawdownPct > settings.walletMaxDrawdownPct) score.notes.push(`Высокий drawdown: ${(score.maxDrawdownPct * 100).toFixed(0)}%`);
  if (score.avgPrice < 0.2) score.notes.push("⚠️ Очень низкие цены — высокий риск");
  if (score.avgPrice > 0.8) score.notes.push("⚠️ Очень высокие цены — низкая маржа");

  return score;
}

/** Пакетная верификация нескольких кошельков */
export async function batchVerify(
  api: PolymarketClient,
  addresses: string[],
  settings: Pick<Settings, "walletMinTrades" | "walletMinWinRate" | "walletMinVolumeUsd" | "walletMaxDrawdownPct" | "walletMinScore">,
  log: (msg: string) => void
): Promise<WalletScore[]> {
  const results: WalletScore[] = [];
  for (const addr of addresses) {
    log(`   🔍 Проверяю ${addr.slice(0, 10)}…`);
    const score = await verifyWallet(api, addr, settings);
    results.push(score);
    log(
      `   ${score.verified ? "✅" : "❌"} ${score.name}: score ${score.score}/100 · ` +
      `сделок ${score.totalTrades} · win ${(score.winRate * 100).toFixed(0)}% · ` +
      `объём ${usd(score.totalVolumeUsd)} · drawdown ${(score.maxDrawdownPct * 100).toFixed(0)}%`
    );
  }
  return results;
}
