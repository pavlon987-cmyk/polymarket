
export type KellyRiskConfig = {
  perTradeCap: number;
  maxDailyLoss: number;
  bankroll: number;
  kellyFraction: number;
  killSwitch: boolean;
};


export function quarterKellySize(params: {
  estimatedProbability: number;
  price: number;
  risk: KellyRiskConfig;
}): number {
  const { estimatedProbability, price, risk } = params;

  if (price <= 0 || price >= 1 || estimatedProbability <= 0 || estimatedProbability >= 1) {
    return 0;
  }

  const b = (1 - price) / price;
  const q = 1 - estimatedProbability;
  const kelly = (b * estimatedProbability - q) / b;
  const fraction = Math.max(0, kelly) * risk.kellyFraction;

  if (!Number.isFinite(fraction) || fraction <= 0) {
    return 0;
  }

  return Math.min(risk.perTradeCap, risk.bankroll * fraction);
}

export function canTradeByRisk(params: {
  dailyPnlUsd: number;
  risk: KellyRiskConfig;
}): { allowed: boolean; reason?: string } {
  if (params.risk.killSwitch) {
    return { allowed: false, reason: "Kill-switch активен" };
  }

  if (Math.abs(Math.min(0, params.dailyPnlUsd)) >= params.risk.maxDailyLoss) {
    return { allowed: false, reason: "Достигнут лимит maxDailyLoss" };
  }

  return { allowed: true };
}
