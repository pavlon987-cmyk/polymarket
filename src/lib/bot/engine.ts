import type { PortfolioRow, PositionRow, Settings, Whale } from "@/db/schema";
import { askAi, chatCompletion, type TradeContext } from "./ai";
import { createExecutor, type Executor } from "./executor";
import { buildMemoryBlock, consolidateMemory, observeWhaleTrades, reflectOnClosedPosition } from "./memory";
import { sendTelegram } from "./notify";
import { PolymarketClient } from "./polymarket";
import {
  addLog,
  closedPositions,
  effectiveStrategy,
  getPortfolio,
  getSettings,
  insertPosition,
  listWhales,
  loadSeenHashes,
  markSeen,
  openPositions,
  positionsValue,
  pruneLogs,
  recordAiDecision,
  saveMarketSnapshot,
  savePortfolio,
  selectStrategyConfigs,
  updatePosition,
  whaleStats,
} from "./store";
import { makeMarketsLoader, runStrategies } from "./strategies";
import type { CycleResult, MarketInfo, Strategy, TradingMode, WhaleTrade } from "./types";

const usd = (n: number) => `$${Math.abs(n).toFixed(2)}`;
const cents = (p: number) => `${(p * 100).toFixed(0)}¢`;
const short = (s: string, n = 50) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

let running = false;
export function isCycleRunning() {
  return running;
}

type Ctx = {
  settings: Settings;
  mode: TradingMode;
  portfolio: PortfolioRow;
  api: PolymarketClient;
  executor: Executor;
  open: PositionRow[];
  closed: PositionRow[];
  notes: string[];
  whaleTrades: Map<string, WhaleTrade[]>;
  log: (level: "info" | "warn" | "error" | "trade", message: string, meta?: unknown) => Promise<void>;
};

export async function runCycle(trigger = "manual"): Promise<CycleResult> {
  if (running) {
    return {
      ok: false,
      mode: "paper",
      trigger,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      closed: 0,
      opened: 0,
      sold: 0,
      halted: false,
      error: "Цикл уже выполняется",
      notes: [],
    };
  }
  running = true;
  const startedAt = new Date().toISOString();
  const notes: string[] = [];
  const log = async (level: "info" | "warn" | "error" | "trade", message: string, meta?: unknown) => {
    notes.push(message);
    await addLog(level, message, meta);
  };

  try {
    const settings = await getSettings();
    const { executor, mode, note: execNote } = createExecutor(settings, (m) => void log("info", m));
    if (execNote) await log("warn", `⚠️  ${execNote}`);

    const api = new PolymarketClient({ settings, log: (m) => void log("info", m) });
    const portfolio = await getPortfolio(mode, settings);

    const ctx: Ctx = {
      settings,
      mode,
      portfolio,
      api,
      executor,
      open: await openPositions(mode),
      closed: await closedPositions(mode, 50),
      notes,
      whaleTrades: new Map(),
      log,
    };

    const equity = portfolio.cashUsd + positionsValue(ctx.open);
    const pct = ((equity - portfolio.startingBankUsd) / portfolio.startingBankUsd) * 100;
    await log(
      "info",
      `▶ Цикл [${mode.toUpperCase()} · ${trigger}] | Кэш: ${usd(portfolio.cashUsd)} | В позициях: ${usd(positionsValue(ctx.open))} | Эквити: ${usd(equity)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`
    );

    // ── Проверка аварийного стоп-лосса ──
    const maxDrawdown = portfolio.startingBankUsd * settings.stopLossPercent;
    if (equity <= portfolio.startingBankUsd - maxDrawdown && !portfolio.halted) {
      portfolio.halted = true;
      await savePortfolio(portfolio);
      await log("error", `🚨 АВАРИЙНАЯ ОСТАНОВКА: убыток превысил ${Math.round(settings.stopLossPercent * 100)}% банка!`);
      await sendTelegram(settings, `🚨 АВАРИЙНАЯ ОСТАНОВКА [${mode.toUpperCase()}]! Эквити: ${usd(equity)}`);
    }

    // 1. Проверка резолвов и закрытие позиций
    const { closed, sold } = await checkAndClosePositions(ctx);

    // 2. Хедж-адвизор
    if (settings.aiEnabled && ctx.open.length >= 2) {
      await runHedgeAdvisor(ctx);
    }

    // 3. Сканирование китов (если не остановлен)
    let opened = 0;
    const whales = (await listWhales()).filter((w) => w.enabled);
    if (!portfolio.halted) {
      const copyRes = await scanWhales(ctx, whales);
      opened += copyRes.opened;
    } else {
      await log("warn", "⏸️  Новые сделки заблокированы: портфель остановлен");
    }

    // 4. Библиотека стратегий (арбитраж, крипто, импульс, свободное плавание и т.д.)
    await log("info", "🧩 Стратегии…");
    await runStrategies({
      settings,
      mode,
      portfolio,
      api,
      executor,
      open: ctx.open,
      whales,
      whaleTrades: ctx.whaleTrades,
      markets: makeMarketsLoader(api, settings),
      log: (m) => void log("info", m),
    });
    await savePortfolio(portfolio);

    portfolio.cyclesRun++;
    portfolio.lastCycleAt = new Date();
    await savePortfolio(portfolio);

    // 5. Консолидация памяти (периодическое сжатие уроков в принципы)
    await consolidateMemory(settings, (m) => void log("info", m));

    await pruneLogs();

    const finishedAt = new Date().toISOString();
    await log("info", `⏹ Цикл завершён: закрыто ${closed}, открыто ${opened}, продано ${sold}`);

    return {
      ok: true,
      mode,
      trigger,
      startedAt,
      finishedAt,
      closed,
      opened,
      sold,
      halted: portfolio.halted,
      notes,
    };
  } catch (err) {
    const message = (err as Error).message;
    await log("error", `❌ Ошибка цикла: ${message}`);
    return {
      ok: false,
      mode: "paper",
      trigger,
      startedAt,
      finishedAt: new Date().toISOString(),
      closed: 0,
      opened: 0,
      sold: 0,
      halted: false,
      error: message,
      notes,
    };
  } finally {
    running = false;
  }
}

// ── 1. Проверка резолвов, стопов и тейков ────────────────────────────────────

async function checkAndClosePositions(ctx: Ctx): Promise<{ closed: number; sold: number }> {
  let closed = 0;
  let sold = 0;
  const strat = new Map((await selectStrategyConfigs()).map((c) => [c.id, c]));

  for (const pos of [...ctx.open]) {
    const market = await ctx.api.fetchMarket(pos.conditionId);
    if (!market) continue;

    // Резолв рынка
    if (market.closed) {
      const idx = pos.outcomeIndex;
      const finalPrice = market.outcomePrices[idx] ?? 0;
      const won = finalPrice >= 0.95;
      const status = won ? "WON" : "LOST";
      const payoutUsd = won ? pos.shares * 1.0 : 0;
      const profitUsd = payoutUsd - pos.costUsd;

      await finalizePosition(ctx, pos, status, payoutUsd, profitUsd, "Рынок завершён");
      closed++;
      continue;
    }

    // Обновляем текущую цену
    const mid = await ctx.api.fetchMidPrice(pos.tokenId);
    if (mid !== null && Number.isFinite(mid)) {
      pos.lastPrice = mid;
      await updatePosition(pos.id, { lastPrice: mid });
      await saveMarketSnapshot(pos.tokenId, pos.conditionId, pos.market, pos.outcome, mid);
    }

    // Экстремальные цены (рынок де-факто решён)
    if (mid !== null) {
      if (mid >= 0.99) {
        if (await sellPosition(ctx, pos, mid, "Цена ≥ 99¢ (фактически выиграл)")) {
          sold++;
          continue;
        }
      }
      if (mid <= 0.01) {
        await finalizePosition(ctx, pos, "LOST", 0, -pos.costUsd, "Цена ≤ 1¢ (фактически проиграл)");
        closed++;
        continue;
      }
    }

    // Проверка стратегий отличных от копирования (свои SL/TP)
    if (pos.source !== "copy" && mid !== null) {
      const c = strat.get(pos.source);
      const tp = Number(c?.params.takeProfitPct ?? 0);
      const sl = Number(c?.params.stopLossPct ?? 0);
      if (tp > 0 && mid >= pos.price * (1 + tp)) {
        if (await sellPosition(ctx, pos, mid, `take_profit +${Math.round(tp * 100)}%`)) closed++;
        continue;
      }
      if (sl > 0 && mid <= pos.price * (1 - sl)) {
        if (await sellPosition(ctx, pos, mid, `stop_loss -${Math.round(sl * 100)}%`)) closed++;
        continue;
      }
      continue;
    }

    // Проверка персональных стопов и тейков для копирования
    const whale = (await listWhales()).find((w) => w.id === pos.whaleId);
    const strategy = effectiveStrategy(ctx.settings.defaultStrategy, whale?.strategy);

    if (mid !== null && strategy.takeProfitPrice && mid >= strategy.takeProfitPrice) {
      if (await sellPosition(ctx, pos, mid, `Take-Profit: цена ${cents(mid)} ≥ ${cents(strategy.takeProfitPrice)}`)) {
        sold++;
        continue;
      }
    }
    if (mid !== null && strategy.stopLossPrice && mid <= strategy.stopLossPrice) {
      if (await sellPosition(ctx, pos, mid, `Stop-Loss: цена ${cents(mid)} ≤ ${cents(strategy.stopLossPrice)}`)) {
        sold++;
        continue;
      }
    }
  }

  return { closed, sold };
}

async function sellPosition(ctx: Ctx, pos: PositionRow, price: number, reason: string): Promise<boolean> {
  const res = await ctx.executor.sell({ tokenId: pos.tokenId, shares: pos.shares, price, market: pos.market });
  if (!res.ok) {
    await ctx.log("warn", `⚠️  Не удалось продать ${short(pos.market)}: ${res.error}`);
    return false;
  }
  const proceedsUsd = res.proceedsUsd;
  const profitUsd = proceedsUsd - pos.costUsd;
  await finalizePosition(ctx, pos, "SOLD", proceedsUsd, profitUsd, reason);
  return true;
}

async function finalizePosition(
  ctx: Ctx,
  pos: PositionRow,
  status: string,
  payoutUsd: number,
  profitUsd: number,
  reason: string
) {
  pos.status = status;
  pos.payoutUsd = payoutUsd;
  pos.profitUsd = profitUsd;
  pos.closeReason = reason;
  pos.closedAt = new Date();

  await updatePosition(pos.id, {
    status,
    payoutUsd,
    profitUsd,
    closeReason: reason,
    closedAt: pos.closedAt,
  });

  ctx.open = ctx.open.filter((p) => p.id !== pos.id);
  ctx.portfolio.cashUsd += payoutUsd;
  ctx.portfolio.realizedPnlUsd += profitUsd;
  await savePortfolio(ctx.portfolio);

  const sign = profitUsd >= 0 ? "+" : "-";
  const icon = status === "WON" ? "🏆" : status === "SOLD" ? "💰" : "❌";
  await ctx.log(
    "trade",
    `${icon} ЗАКРЫТА: ${short(pos.market)} [${pos.outcome}] → ${status} (${sign}${usd(profitUsd)}) — ${reason}`,
    { positionId: pos.id, status, profitUsd }
  );

  await sendTelegram(
    ctx.settings,
    `${icon} ПОЗИЦИЯ ЗАКРЫТА [${ctx.mode.toUpperCase()}]
${pos.market}
Исход: ${pos.outcome}
Статус: ${status}
Финансовый итог: ${sign}${usd(profitUsd)}
Причина: ${reason}`
  );

  await reflectOnClosedPosition(ctx.settings, pos, status, profitUsd, reason, (m) => void ctx.log("info", m));
}

// ── 2. Сканирование китов ───────────────────────────────────────────────────

async function scanWhales(ctx: Ctx, whales: Whale[]): Promise<{ opened: number; sold: number }> {
  let opened = 0;
  let sold = 0;
  const stats = await whaleStats(ctx.mode);

  for (const whale of whales) {
    const strategy = effectiveStrategy(ctx.settings.defaultStrategy, whale.strategy);
    await ctx.log("info", `🔎 Кит: ${whale.name} (${whale.category})…`);

    const trades = await ctx.api.fetchWhaleTrades(whale.address);
    ctx.whaleTrades.set(whale.address, trades);
    if (!trades.length) {
      await ctx.log("info", `   нет публичных сделок`);
      continue;
    }

    const now = Date.now() / 1000;
    const maxAgeSec = strategy.maxTradeAgeMin * 60;
    const recent = trades.filter((t) => now - t.timestamp <= maxAgeSec);

    const hashes = recent.map(tradeHash);
    const seen = await loadSeenHashes(hashes);
    const newTrades = recent.filter((t) => !seen.has(tradeHash(t)));

    await markSeen(newTrades.map((t) => ({ hash: tradeHash(t), whaleId: whale.id })));
    await observeWhaleTrades(ctx.settings, whale, newTrades, (m) => void ctx.log("info", `   ${m}`));

    if (!newTrades.length) {
      await ctx.log("info", `   новых сделок нет (${recent.length} свежих уже обработаны)`);
      continue;
    }
    await ctx.log("info", `   новых сделок: ${newTrades.length}`);

    // Копирование продаж
    if (strategy.copySells) {
      for (const t of newTrades.filter((x) => x.side === "SELL")) {
        const match = ctx.open.find(
          (p) => p.whaleAddress.toLowerCase() === whale.address.toLowerCase() && p.conditionId === t.conditionId
        );
        if (match) {
          await ctx.log("info", `   ⚠️ Кит продал исход — закрываем нашу позицию`);
          if (await sellPosition(ctx, match, t.price, `Кит ${whale.name} продал свои акции`)) sold++;
        }
      }
    }

    // Копирование покупок
    const whalePositions = ctx.open.filter((p) => p.whaleAddress.toLowerCase() === whale.address.toLowerCase());
    if (whalePositions.length >= strategy.maxPositionsPerWhale) {
      await ctx.log("info", `   ⏭️ Лимит позиций на кита: ${whalePositions.length} / ${strategy.maxPositionsPerWhale}`);
      continue;
    }

    const heldConditionIds = new Set(ctx.open.map((p) => p.conditionId));
    let exposure = ctx.open
      .filter((p) => p.category.toLowerCase() === whale.category.toLowerCase())
      .reduce((s, p) => s + p.costUsd, 0);
    const totalBank = ctx.portfolio.cashUsd + positionsValue(ctx.open);
    const budget = totalBank * strategy.maxCategoryExposure;
    if (exposure >= budget) {
      await ctx.log("info", `   ⏭️ Лимит категории ${whale.category}: ${usd(exposure)} / ${usd(budget)}`);
      continue;
    }

    const skipped: Record<string, number> = {};
    const skip = (r: string) => (skipped[r] = (skipped[r] ?? 0) + 1);
    let copied = 0;

    for (const t of newTrades) {
      if (copied >= strategy.maxCopiesPerCycle) break;
      if (ctx.open.length >= ctx.settings.maxOpenPositions) break;
      if (t.side !== "BUY") {
        skip("SELL");
        continue;
      }
      if (heldConditionIds.has(t.conditionId)) {
        skip("рынок уже в портфеле");
        continue;
      }
      const price = t.price;
      if (price > strategy.maxEntryPrice) {
        skip(`цена > ${cents(strategy.maxEntryPrice)}`);
        continue;
      }
      if (price < strategy.minEntryPrice) {
        skip(`цена < ${cents(strategy.minEntryPrice)}`);
        continue;
      }
      const whaleUsd = t.size * price;
      if (whaleUsd < strategy.minWhaleTradeUsd) {
        skip(`сделка кита < ${usd(strategy.minWhaleTradeUsd)}`);
        continue;
      }
      const kw = keywordsOk(t.title, strategy);
      if (kw) {
        skip(kw);
        continue;
      }

      const label = `${short(t.title, 40)} [${t.outcome}] ${cents(price)}`;
      await ctx.log("info", `   🎯 Кандидат: ${label} (кит: ${usd(whaleUsd)})`);

      const market = await ctx.api.fetchMarket(t.conditionId);
      if (!market) {
        await ctx.log("info", `   ⏭️ рынок не найден`);
        continue;
      }
      if (market.closed) {
        await ctx.log("info", `   ⏭️ рынок закрыт`);
        continue;
      }
      if (market.endDate) {
        const endMs = new Date(market.endDate).getTime();
        const hoursLeft = (endMs - Date.now()) / 3_600_000;
        const daysLeft = hoursLeft / 24;
        if (daysLeft > ctx.settings.maxDaysToEnd) {
          await ctx.log("info", `   ⏭️ рынок слишком долгий (${daysLeft.toFixed(1)} дн. > ${ctx.settings.maxDaysToEnd} дн.)`);
          continue;
        }
        if (hoursLeft < ctx.settings.minHoursToEnd) {
          await ctx.log("info", `   ⏭️ рынок слишком близко к завершению (${hoursLeft.toFixed(1)} ч. < ${ctx.settings.minHoursToEnd} ч.)`);
          continue;
        }
      }
      if (market.volumeUsd < strategy.minVolumeUsd) {
        await ctx.log("info", `   ⏭️ объём ${usd(market.volumeUsd)} < ${usd(strategy.minVolumeUsd)}`);
        continue;
      }
      let outcomeIndex = market.outcomes.indexOf(t.outcome);
      if (outcomeIndex < 0) outcomeIndex = market.clobTokenIds.indexOf(t.asset);
      if (outcomeIndex < 0 && t.outcomeIndex !== undefined) outcomeIndex = t.outcomeIndex;
      if (outcomeIndex < 0) {
        await ctx.log("info", `   ⏭️ не удалось определить исход`);
        continue;
      }
      const tokenId = t.asset || market.clobTokenIds[outcomeIndex];

      let bet = calcBet(strategy, price, ctx.portfolio.cashUsd, whaleUsd, (m) => void ctx.log("info", `   ${m}`));
      if (bet <= 0) continue;

      // ── Умное копирование (ИИ) ──
      let aiDecision = null as null | Awaited<ReturnType<typeof askAi>>;
      if (ctx.settings.aiEnabled && strategy.useAi) {
        const ws = stats.find((s) => s.whaleName === whale.name);
        const tradeCtx = buildTradeContext(ctx, whale, strategy, t, market, whaleUsd, exposure, budget, bet, ws);
        if (ctx.settings.aiMemoryEnabled) {
          tradeCtx.memory = await buildMemoryBlock({ whaleName: whale.name, category: whale.category });
        }
        aiDecision = await askAi(ctx.settings, tradeCtx);
        const pass = aiDecision.decision === "COPY" && aiDecision.confidence >= ctx.settings.aiMinConfidence && !aiDecision.error;
        await recordAiDecision({
          mode: ctx.mode,
          whaleName: whale.name,
          market: market.question,
          outcome: market.outcomes[outcomeIndex] ?? t.outcome,
          price,
          decision: aiDecision.decision,
          confidence: aiDecision.confidence,
          sizeMultiplier: aiDecision.sizeMultiplier,
          reason: aiDecision.reason,
          applied: pass,
        });
        await ctx.log(
          pass ? "info" : "warn",
          `   🤖 ИИ: ${aiDecision.decision} (conf ${(aiDecision.confidence * 100).toFixed(0)}%, ×${aiDecision.sizeMultiplier.toFixed(2)}) — ${aiDecision.reason}`
        );
        if (!pass) continue;
        bet = Math.min(Math.round(bet * aiDecision.sizeMultiplier * 100) / 100, strategy.maxBetUsd, ctx.portfolio.cashUsd);
      }

      if (bet < 0.5) {
        await ctx.log("info", `   ⏭️ ставка слишком мала (${usd(bet)})`);
        continue;
      }
      if (ctx.portfolio.cashUsd < bet) {
        await ctx.log("warn", `   ⚠️ Недостаточно кэша: ${usd(ctx.portfolio.cashUsd)} < ${usd(bet)}`);
        continue;
      }
      if (exposure + bet > budget) {
        await ctx.log("info", `   ⏭️ ставка ${usd(bet)} превысит лимит категории`);
        continue;
      }
      if (ctx.mode === "live" && ctx.portfolio.totalInvestedUsd - ctx.portfolio.realizedPnlUsd + bet > ctx.settings.liveMaxBankUsd * 3) {
        await ctx.log("warn", `   ⛔ live: превышен общий лимит оборота`);
        continue;
      }

      const fill = await ctx.executor.buy({ tokenId, price, usd: bet, market: market.question });
      if (!fill.ok) {
        await ctx.log("warn", `   ⚠️ Ордер не исполнен: ${fill.error}`);
        continue;
      }

      const row = await insertPosition({
        mode: ctx.mode,
        whaleId: whale.id,
        whaleName: whale.name,
        whaleAddress: whale.address,
        category: whale.category,
        conditionId: market.conditionId,
        tokenId,
        market: market.question,
        outcome: market.outcomes[outcomeIndex] ?? t.outcome,
        outcomeIndex,
        price: fill.avgPrice,
        lastPrice: fill.avgPrice,
        shares: fill.shares,
        costUsd: fill.costUsd,
        whaleTradeHash: tradeHash(t),
        whaleSizeShares: t.size,
        aiDecision: aiDecision ? { ...aiDecision, raw: undefined } : null,
        liveOrderId: fill.orderId ?? null,
      });
      ctx.open.push(row);
      ctx.portfolio.cashUsd -= fill.costUsd;
      ctx.portfolio.totalInvestedUsd += fill.costUsd;
      heldConditionIds.add(market.conditionId);
      exposure += fill.costUsd;
      copied++;
      opened++;

      await ctx.log(
        "trade",
        `   ✅ НОВАЯ ПОЗИЦИЯ [${ctx.mode}]: ${short(market.question)} — ${row.outcome} @ ${cents(fill.avgPrice)} · ${usd(fill.costUsd)} → ${fill.shares.toFixed(2)} шт. · потенциал +${usd(fill.shares - fill.costUsd)}`,
        { positionId: row.id }
      );
      await sendTelegram(
        ctx.settings,
        `🆕 ${ctx.mode.toUpperCase()} · ${whale.name}
${market.question}
${row.outcome} @ ${cents(fill.avgPrice)} · ставка ${usd(fill.costUsd)}
Потенциал: +${usd(fill.shares - fill.costUsd)}${aiDecision ? `
🤖 ${aiDecision.reason}` : ""}`
      );
      await savePortfolio(ctx.portfolio);
    }

    const summary = Object.entries(skipped)
      .map(([r, n]) => `${r}: ${n}`)
      .join(", ");
    if (summary) await ctx.log("info", `   📋 Пропущено — ${summary}`);
  }
  return { opened, sold };
}

function tradeHash(t: WhaleTrade) {
  return t.transactionHash ?? `${t.conditionId}_${t.timestamp}_${t.asset}`;
}

function buildTradeContext(
  ctx: Ctx,
  whale: Whale,
  strategy: Strategy,
  t: WhaleTrade,
  market: MarketInfo,
  whaleUsd: number,
  exposure: number,
  budget: number,
  bet: number,
  ws?: { copied: number; wins: number; losses: number; pnlUsd: number }
): TradeContext {
  const hoursToEnd = market.endDate ? (new Date(market.endDate).getTime() - Date.now()) / 3_600_000 : null;
  return {
    whale: { name: whale.name, category: whale.category, address: whale.address, notes: whale.notes, promptExtra: strategy.aiPromptExtra },
    whaleStats: { copied: ws?.copied ?? 0, wins: ws?.wins ?? 0, losses: ws?.losses ?? 0, pnlUsd: round2(ws?.pnlUsd ?? 0) },
    trade: {
      side: t.side,
      outcome: t.outcome,
      price: t.price,
      sizeShares: t.size,
      sizeUsd: round2(whaleUsd),
      ageMin: Math.round((Date.now() / 1000 - t.timestamp) / 60),
    },
    market: {
      question: market.question,
      outcomes: market.outcomes,
      outcomePrices: market.outcomePrices,
      volumeUsd: Math.round(market.volumeUsd),
      liquidityUsd: Math.round(market.liquidityUsd),
      endDate: market.endDate,
      hoursToEnd: hoursToEnd === null ? null : Math.round(hoursToEnd * 10) / 10,
    },
    portfolio: {
      mode: ctx.mode,
      cashUsd: round2(ctx.portfolio.cashUsd),
      equityUsd: round2(ctx.portfolio.cashUsd + positionsValue(ctx.open)),
      openPositions: ctx.open.length,
      categoryExposureUsd: round2(exposure),
      categoryBudgetUsd: round2(budget),
      proposedBetUsd: round2(bet),
    },
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function calcBet(s: Strategy, price: number, cashUsd: number, whaleUsd: number, log: (m: string) => void): number {
  let bet = 0;
  switch (s.sizingMode) {
    case "fixed":
      bet = s.fixedBetUsd;
      break;
    case "percent":
      bet = cashUsd * s.betPct;
      break;
    case "proportional":
      bet = whaleUsd * s.proportionalRatio;
      break;
    case "kelly": {
      const p = Math.min(0.95, price + s.assumedEdge);
      const b = (1 - price) / price;
      const q = 1 - p;
      const f = (b * p - q) / b;
      if (f <= 0) {
        log(`Келли ≤ 0 (edge ${s.assumedEdge}, p=${p.toFixed(2)})`);
        return 0;
      }
      const raw = f * s.kellyMultiplier;
      const bounded = Math.max(s.minBetPct, Math.min(s.maxBetPct, raw));
      bet = cashUsd * bounded;
      break;
    }
  }
  return Math.min(Math.round(bet * 100) / 100, s.maxBetUsd, cashUsd);
}

function keywordsOk(title: string, s: Strategy): string | null {
  const text = title.toLowerCase();
  if (s.blockedKeywords) {
    const list = s.blockedKeywords.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
    for (const k of list) if (text.includes(k)) return `стоп-слово: "${k}"`;
  }
  if (s.allowedKeywords) {
    const list = s.allowedKeywords.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
    if (list.length && !list.some((k) => text.includes(k))) return `нет обязательного ключевого слова`;
  }
  return null;
}

// ── 3. Хедж-адвизор ─────────────────────────────────────────────────────────

async function runHedgeAdvisor(ctx: Ctx) {
  const atRisk = ctx.open.filter((p) => {
    const unrealized = p.shares * (p.lastPrice ?? p.price) - p.costUsd;
    return unrealized < -p.costUsd * 0.3; // просадка > 30%
  });
  if (!atRisk.length) return;

  const positionsSummary = atRisk
    .map(
      (p) =>
        `- Позиция #${p.id}: "${p.market}" [${p.outcome}], вход: ${cents(p.price)}, сейчас: ${cents(p.lastPrice ?? p.price)}, ставка: ${usd(p.costUsd)}, убыток: ${usd(p.shares * (p.lastPrice ?? p.price) - p.costUsd)}`
    )
    .join("\n");

  const memory = ctx.settings.aiMemoryEnabled ? await buildMemoryBlock({}, 2000) : "";
  const hedgePrompt = `Ты — хедж-адвизор копитрейдера Polymarket.${memory}\n\nВот текущие открытые позиции и их P&L:
${positionsSummary}

Для каждой проблемной позиции определи, нужен ли хедж:
1. Краткий вердикт: HEDGE (купить противоположный исход), HOLD (ждать разворота), CUT (продать и зафиксировать убыток).
2. Рекомендуемый размер хеджа в % от первоначальной ставки (если HEDGE).
3. Причина (1-2 предложения).

Ответь строго JSON-массивом:
[{"positionId": 1, "action": "HEDGE"|"HOLD"|"CUT", "hedgeSizePct": 50, "reason": "..."}]`;

  try {
    const aiSettings = {
      aiApiUrl: ctx.settings.aiApiUrl,
      aiApiKey: ctx.settings.aiApiKey,
      aiModel: ctx.settings.aiModel,
      aiSystemPrompt: "Ты финансовый риск-менеджер. Отвечай только валидным JSON без разметки markdown.",
      aiTemperature: 0.1,
      aiTimeoutMs: 25_000,
    };
    const { content } = await chatCompletion(aiSettings, [{ role: "user", content: hedgePrompt }]);
    const parsed = content.replace(/```(?:json)?/gi, "").trim();
    const recommendations = JSON.parse(parsed);
    if (Array.isArray(recommendations)) {
      for (const rec of recommendations) {
        const p = atRisk.find((x) => x.id === rec.positionId);
        if (!p) continue;
        await ctx.log(
          "warn",
          `🛡️ Хедж-совет #${p.id} (${short(p.market, 30)}): ${rec.action} ${rec.hedgeSizePct ? `(${rec.hedgeSizePct}%)` : ""} — ${rec.reason}`
        );
      }
    }
  } catch {
    // советник не должен прерывать цикл
  }
}
