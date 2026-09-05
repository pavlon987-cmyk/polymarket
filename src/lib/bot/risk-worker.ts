/**
 * ВЫДЕЛЕННЫЙ РИСК-ВОРКЕР (High-Frequency Exit Loop).
 *
 * Отвечает ТОЛЬКО за контроль рисков и выходы из позиций:
 *  1. Не ждёт медленного 2-минутного общего цикла (runCycle).
 *  2. Не вызывает LLM, не сканирует новые рынки, не запрашивает Telegram.
 *  3. Работает с интервалом 1.5 секунды, в первую очередь обслуживает дедлайны (BTC-5m).
 *  4. Принудительный выход за 25 секунд до окончания рынка (forced exit lead time).
 *  5. Моментальная проверка Stop-Loss / Take-Profit по WebSocket-котировкам.
 *  6. Автономная проверка закрытия/резолва через CLOB-фолбэк.
 */
import { db } from "@/db";
import { positions, type PositionRow } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { createExecutor } from "./executor";
import { PolymarketClient } from "./polymarket";
import { realtime } from "./realtime";
import {
  addLog,
  getPortfolio,
  getSettings,
  listWhales,
  selectStrategyConfigs,
  updatePosition,
  effectiveStrategy,
} from "./store";
import { finalizePosition, resolutionOf, sellPosition, type Ctx } from "./engine";
import { reconcilePortfolio } from "./ledger";
import type { TradingMode } from "./types";

type RiskWorkerState = {
  running: boolean;
  timer: NodeJS.Timeout | null;
  lastTickAt: string | null;
  checksCount: number;
  exitsCount: number;
};

const g = globalThis as typeof globalThis & { __copytraderRiskWorker?: RiskWorkerState };
function state(): RiskWorkerState {
  if (!g.__copytraderRiskWorker) {
    g.__copytraderRiskWorker = {
      running: false,
      timer: null,
      lastTickAt: null,
      checksCount: 0,
      exitsCount: 0,
    };
  }
  return g.__copytraderRiskWorker;
}

export function getRiskWorkerState() {
  const s = state();
  return {
    running: s.running,
    lastTickAt: s.lastTickAt,
    checksCount: s.checksCount,
    exitsCount: s.exitsCount,
  };
}

const closingPositions = new Set<number>();

async function tickRisk() {
  const s = state();
  if (!s.running) return;
  s.lastTickAt = new Date().toISOString();
  s.checksCount++;

  try {
    const settings = await getSettings().catch(() => null);
    if (!settings) return;
    const mode: TradingMode = (settings.tradingMode as TradingMode) === "live" ? "live" : "paper";

    // Берём только открытые позиции текущего режима
    const open = await db
      .select()
      .from(positions)
      .where(and(eq(positions.mode, mode), eq(positions.status, "OPEN")));

    if (!open.length) return;

    // Сортируем: сначала те, у кого дедлайн ближе всего
    const now = Date.now();
    open.sort((a, b) => {
      const aEnd = a.marketEndAt ? new Date(a.marketEndAt).getTime() : Number.MAX_SAFE_INTEGER;
      const bEnd = b.marketEndAt ? new Date(b.marketEndAt).getTime() : Number.MAX_SAFE_INTEGER;
      return aEnd - bEnd;
    });

    let ctxCache: Ctx | null = null;
    const getCtx = async (): Promise<Ctx> => {
      if (ctxCache) return ctxCache;
      const { executor } = createExecutor({ ...settings, tradingMode: mode }, (m) => void addLog("info", m));
      const api = new PolymarketClient({ settings, log: (m) => void addLog("info", m) });
      const ledger = await reconcilePortfolio(mode, { log: false });
      const portfolio = await getPortfolio(mode, settings);
      ctxCache = {
        settings,
        mode,
        portfolio,
        ledger,
        api,
        executor,
        open,
        closed: [],
        notes: [],
        whaleTrades: new Map(),
        log: (level, message, meta) => addLog(level, `[RiskWorker] ${message}`, meta),
      };
      return ctxCache;
    };

    const stratConfigs = new Map((await selectStrategyConfigs()).map((c) => [c.id, c]));
    const whales = await listWhales();

    for (const pos of open) {
      if (closingPositions.has(pos.id)) continue;

      const endMs = pos.marketEndAt ? new Date(pos.marketEndAt).getTime() : null;
      const msLeft = endMs ? endMs - now : null;

      // 1. Проверка резолва для рынков, срок которых уже истёк
      if (msLeft !== null && msLeft <= 0) {
        closingPositions.add(pos.id);
        try {
          const ctx = await getCtx();
          const market = await ctx.api.fetchMarket(pos.conditionId);
          if (market) {
            const res = resolutionOf(market, pos, now);
            if (res) {
              const payout = res.status === "WON" ? pos.shares : 0;
              await finalizePosition(ctx, pos, res.status, payout, payout - pos.costUsd, res.reason);
              s.exitsCount++;
              await addLog("trade", `🏁 [RiskWorker] #${pos.id} ${pos.market} → ${res.status} (${res.reason})`);
              continue;
            }
          }
        } catch (err) {
          await addLog("warn", `⚠️ [RiskWorker] Ошибка проверки резолва #${pos.id}: ${(err as Error).message}`);
        } finally {
          closingPositions.delete(pos.id);
        }
      }

      // Свежая цена из realtime кэша
      const bestBid = realtime.bestBid(pos.tokenId);
      const mid = realtime.price(pos.tokenId) ?? bestBid ?? pos.lastPrice;

      // 2. Дедлайн: принудительный выход за 25 секунд до окончания рынка (для ультракоротких 5-15m)
      const FORCED_EXIT_LEAD_MS = 25_000;
      if (msLeft !== null && msLeft > 0 && msLeft <= FORCED_EXIT_LEAD_MS && mid !== null && mid >= 0.05) {
        closingPositions.add(pos.id);
        try {
          const ctx = await getCtx();
          const ok = await sellPosition(
            ctx,
            pos,
            bestBid ?? mid,
            `⏳ До окончания рынка осталось ${Math.round(msLeft / 1000)}с — экстренный выход до дедлайна`
          );
          if (ok) {
            s.exitsCount++;
            continue;
          }
        } catch (err) {
          await addLog("warn", `⚠️ [RiskWorker] Сбой экстренного выхода #${pos.id}: ${(err as Error).message}`);
        } finally {
          closingPositions.delete(pos.id);
        }
      }

      if (mid === null || !Number.isFinite(mid)) continue;

      // 3. Экстремальные цены (≥ 99¢ — фиксируем победу, ≤ 1¢ — фиксируем поражение)
      if (mid >= 0.99 || mid <= 0.01) {
        closingPositions.add(pos.id);
        try {
          const ctx = await getCtx();
          const reason = mid >= 0.99 ? "Цена ≥ 99¢ (фактически выиграл)" : "Цена ≤ 1¢ (фактически проиграл)";
          const ok = await sellPosition(ctx, pos, bestBid ?? mid, reason);
          if (ok) {
            s.exitsCount++;
            continue;
          }
        } finally {
          closingPositions.delete(pos.id);
        }
      }

      // 4. Стопы и тейки стратегий
      if (pos.source !== "copy") {
        const sc = stratConfigs.get(pos.source);
        const tp = Number(sc?.params?.takeProfitPct ?? 0);
        const sl = Number(sc?.params?.stopLossPct ?? 0);
        if (tp > 0 && mid >= pos.price * (1 + tp)) {
          closingPositions.add(pos.id);
          try {
            const ctx = await getCtx();
            const ok = await sellPosition(ctx, pos, bestBid ?? mid, `TP +${Math.round(tp * 100)}% (${pos.source})`);
            if (ok) {
              s.exitsCount++;
              continue;
            }
          } finally {
            closingPositions.delete(pos.id);
          }
        }
        if (sl > 0 && mid <= pos.price * (1 - sl)) {
          closingPositions.add(pos.id);
          try {
            const ctx = await getCtx();
            const ok = await sellPosition(ctx, pos, bestBid ?? mid, `SL -${Math.round(sl * 100)}% (${pos.source})`);
            if (ok) {
              s.exitsCount++;
              continue;
            }
          } finally {
            closingPositions.delete(pos.id);
          }
        }
      } else {
        // Копирование кита: проверка персональных стопов/тейков
        const whale = whales.find((w) => w.id === pos.whaleId);
        const strategy = effectiveStrategy(settings.defaultStrategy, whale?.strategy);
        if (strategy.takeProfitPrice && mid >= strategy.takeProfitPrice) {
          closingPositions.add(pos.id);
          try {
            const ctx = await getCtx();
            const ok = await sellPosition(ctx, pos, bestBid ?? mid, `Whale Take-Profit @ ${(mid * 100).toFixed(0)}¢`);
            if (ok) {
              s.exitsCount++;
              continue;
            }
          } finally {
            closingPositions.delete(pos.id);
          }
        }
        if (strategy.stopLossPrice && mid <= strategy.stopLossPrice) {
          closingPositions.add(pos.id);
          try {
            const ctx = await getCtx();
            const ok = await sellPosition(ctx, pos, bestBid ?? mid, `Whale Stop-Loss @ ${(mid * 100).toFixed(0)}¢`);
            if (ok) {
              s.exitsCount++;
              continue;
            }
          } finally {
            closingPositions.delete(pos.id);
          }
        }
      }
    }
  } catch (err) {
    /* глобальный сбой тика риск-воркера не должен ронять процесс */
  } finally {
    if (s.running) {
      s.timer = setTimeout(() => void tickRisk(), 1_500);
      s.timer.unref?.();
    }
  }
}

export function startRiskWorker() {
  const s = state();
  if (s.running) return;
  s.running = true;
  s.timer = setTimeout(() => void tickRisk(), 1_000);
  s.timer.unref?.();
  void addLog("info", "🛡️ Высокочастотный Риск-воркер запущен (1.5с интервал выходов)");
}

export function stopRiskWorker() {
  const s = state();
  s.running = false;
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  void addLog("info", "⏹️ Риск-воркер остановлен");
}
