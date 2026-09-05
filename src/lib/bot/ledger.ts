/**
 * ЛЕДЖЕР — единственный источник правды о деньгах.
 *
 * Проблема старой версии: portfolios.cash_usd — изменяемое число, которое каждый
 * цикл / ручной запуск стратегии / чат перезаписывал целиком из своей копии в памяти
 * (savePortfolio(p)). Два параллельных процесса → «потерянное обновление» → кэш
 * растёт из воздуха (+$95), а лимиты позиций не срабатывают (14 открытых при лимите 10).
 *
 * Решение: кэш НЕ хранится, а ВЫВОДИТСЯ из таблицы positions:
 *
 *   cash      = startingBank − Σ cost(все позиции) + Σ payout(закрытые) + Σ adjustments
 *   realized  = Σ profit(закрытые)
 *   inPos     = Σ shares × (lastPrice ?? price)   (только OPEN)
 *   equity    = cash + inPos  ≡  startingBank + realized + unrealized  (тождество — проверяется)
 *
 * Таблица portfolios остаётся как кэш-снимок для UI, но после каждого цикла
 * пересчитывается функцией reconcilePortfolio(); расхождение пишется в журнал.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { portfolios, positions, type PortfolioRow } from "@/db/schema";
import { addLog } from "./store";
import type { TradingMode } from "./types";

export type LedgerSummary = {
  mode: TradingMode;
  startingBankUsd: number;
  adjustmentsUsd: number; // ручные пополнения/выводы (таблица cash_adjustments)
  costOpenUsd: number; // вложено в открытые
  costAllUsd: number; // вложено за всё время (оборот)
  payoutClosedUsd: number; // получено при закрытии
  marketValueUsd: number; // текущая стоимость открытых
  cashUsd: number; // производный кэш
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  equityUsd: number;
  openCount: number;
  closedCount: number;
  wins: number;
  losses: number;
  soldCount: number; // подмножество closed (информационно, НЕ прибавляется к W/L)
  pendingResolveCount: number; // рынок истёк, но не закрыт — висит в ожидании
  overdraft: boolean; // cash < 0 → открытие новых позиций запрещено
  storedCashUsd: number;
  cashDriftUsd: number; // stored − derived; ≠0 означает баг/гонку в прошлом
  identityErrorUsd: number; // |equity − (bank + realized + unrealized)| — должно быть 0
};

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function computeLedger(mode: TradingMode, p?: PortfolioRow): Promise<LedgerSummary> {
  const portfolio = p ?? (await db.select().from(portfolios).where(eq(portfolios.mode, mode)).limit(1))[0];
  if (!portfolio) throw new Error(`Портфель ${mode} не найден`);

  const [agg] = await db
    .select({
      costAll: sql<number>`coalesce(sum(${positions.costUsd}), 0)`,
      costOpen: sql<number>`coalesce(sum(case when ${positions.status} = 'OPEN' then ${positions.costUsd} end), 0)`,
      mv: sql<number>`coalesce(sum(case when ${positions.status} = 'OPEN' then ${positions.shares} * coalesce(${positions.lastPrice}, ${positions.price}) end), 0)`,
      payout: sql<number>`coalesce(sum(case when ${positions.status} <> 'OPEN' then coalesce(${positions.payoutUsd}, 0) end), 0)`,
      realized: sql<number>`coalesce(sum(case when ${positions.status} <> 'OPEN' then coalesce(${positions.profitUsd}, 0) end), 0)`,
      openN: sql<number>`count(*) filter (where ${positions.status} = 'OPEN')`,
      closedN: sql<number>`count(*) filter (where ${positions.status} <> 'OPEN')`,
      wins: sql<number>`count(*) filter (where ${positions.status} <> 'OPEN' and coalesce(${positions.profitUsd}, 0) > 0)`,
      losses: sql<number>`count(*) filter (where ${positions.status} <> 'OPEN' and coalesce(${positions.profitUsd}, 0) < 0)`,
      sold: sql<number>`count(*) filter (where ${positions.status} = 'SOLD')`,
      pending: sql<number>`count(*) filter (where ${positions.status} = 'OPEN' and ${positions.marketEndAt} is not null and ${positions.marketEndAt} < now() - interval '10 minutes')`,
    })
    .from(positions)
    .where(eq(positions.mode, mode));

  const [adj] = await db.execute<{ total: number }>(
    sql`select coalesce(sum(amount_usd), 0)::float8 as total from cash_adjustments where mode = ${mode}`
  ).then((r) => (Array.isArray(r) ? r : (r as unknown as { rows: { total: number }[] }).rows));

  const adjustmentsUsd = Number(adj?.total ?? 0);
  const costAll = Number(agg.costAll);
  const payout = Number(agg.payout);
  const mv = Number(agg.mv);
  const realized = Number(agg.realized);
  const costOpen = Number(agg.costOpen);

  const cash = portfolio.startingBankUsd + adjustmentsUsd - costAll + payout;
  const unrealized = mv - costOpen;
  const equity = cash + mv;
  const identity = portfolio.startingBankUsd + adjustmentsUsd + realized + unrealized;

  return {
    mode,
    startingBankUsd: portfolio.startingBankUsd,
    adjustmentsUsd: r2(adjustmentsUsd),
    costOpenUsd: r2(costOpen),
    costAllUsd: r2(costAll),
    payoutClosedUsd: r2(payout),
    marketValueUsd: r2(mv),
    cashUsd: r2(cash),
    realizedPnlUsd: r2(realized),
    unrealizedPnlUsd: r2(unrealized),
    equityUsd: r2(equity),
    openCount: Number(agg.openN),
    closedCount: Number(agg.closedN),
    wins: Number(agg.wins),
    losses: Number(agg.losses),
    soldCount: Number(agg.sold),
    pendingResolveCount: Number(agg.pending),
    overdraft: cash < -0.005,
    storedCashUsd: r2(portfolio.cashUsd),
    cashDriftUsd: r2(portfolio.cashUsd - cash),
    identityErrorUsd: r2(Math.abs(equity - identity)),
  };
}

/**
 * Сверка: пересчитывает кэш/realized из леджера и перезаписывает снимок в portfolios.
 * Вызывается в начале и в конце каждого цикла, а также из /api/bot/reconcile.
 */
export async function reconcilePortfolio(mode: TradingMode, opts: { log?: boolean } = {}): Promise<LedgerSummary> {
  const led = await computeLedger(mode);
  const drift = Math.abs(led.cashDriftUsd);
  if (drift > 0.009 || led.identityErrorUsd > 0.009) {
    await db
      .update(portfolios)
      .set({
        cashUsd: led.cashUsd,
        realizedPnlUsd: led.realizedPnlUsd,
        totalInvestedUsd: led.costAllUsd,
        lastUpdated: new Date(),
      })
      .where(eq(portfolios.mode, mode));
    if (opts.log !== false) {
      await addLog(
        "warn",
        `🧮 Сверка [${mode}]: кэш в БД $${led.storedCashUsd.toFixed(2)} ≠ расчётный $${led.cashUsd.toFixed(2)} (дрейф ${led.cashDriftUsd >= 0 ? "+" : ""}$${led.cashDriftUsd.toFixed(2)}). Исправлено. Эквити = $${led.equityUsd.toFixed(2)}${led.overdraft ? " ⛔ ОВЕРДРАФТ — новые позиции заблокированы до восстановления кэша" : ""}`,
        led
      );
    }
  }
  return led;
}

/**
 * Атомарное резервирование кэша под ставку. Возвращает false, если денег нет.
 * Работает в транзакции с блокировкой строки портфеля — вторая параллельная
 * покупка дождётся первой и увидит уже уменьшенный кэш.
 */
export async function reserveCash(mode: TradingMode, usd: number): Promise<{ ok: boolean; cashAfter: number }> {
  return db.transaction(async (tx) => {
    const [row] = await tx.execute<{ cash: number }>(
      sql`select cash_usd::float8 as cash from portfolios where mode = ${mode} for update`
    ).then((r) => (Array.isArray(r) ? r : (r as unknown as { rows: { cash: number }[] }).rows));
    const cash = Number(row?.cash ?? 0);
    if (cash < usd) return { ok: false, cashAfter: cash };
    await tx.execute(sql`update portfolios set cash_usd = cash_usd - ${usd}, last_updated = now() where mode = ${mode}`);
    return { ok: true, cashAfter: cash - usd };
  });
}

/** Атомарное зачисление выплаты при закрытии позиции */
export async function creditCash(mode: TradingMode, payoutUsd: number, profitUsd: number): Promise<void> {
  await db.execute(
    sql`update portfolios set cash_usd = cash_usd + ${payoutUsd}, realized_pnl_usd = realized_pnl_usd + ${profitUsd}, last_updated = now() where mode = ${mode}`
  );
}

/** Ручная корректировка (пополнение / вывод) — единственный легальный способ «взять деньги откуда-то» */
export async function addCashAdjustment(mode: TradingMode, amountUsd: number, reason: string): Promise<void> {
  await db.execute(sql`insert into cash_adjustments (mode, amount_usd, reason) values (${mode}, ${amountUsd}, ${reason})`);
  await reconcilePortfolio(mode);
}

/** Есть ли уже открытая позиция на этот рынок/токен (проверка прямо в БД перед покупкой) */
export async function alreadyHeld(mode: TradingMode, conditionId: string, tokenId?: string): Promise<boolean> {
  const rows = await db
    .select({ id: positions.id })
    .from(positions)
    .where(
      and(
        eq(positions.mode, mode),
        eq(positions.status, "OPEN"),
        tokenId ? eq(positions.tokenId, tokenId) : eq(positions.conditionId, conditionId)
      )
    )
    .limit(1);
  return rows.length > 0;
}
