-- ─────────────────────────────────────────────────────────────────────────────
-- 0001: леджер, защита от дублей и гонок.  Применить: psql $DATABASE_URL -f 0001_ledger_and_guards.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Один и тот же токен нельзя держать открытым дважды в одном режиме.
--    Именно это породило пары «Will the price of Bitcoin be above $78,000» × 2 и т.д.
CREATE UNIQUE INDEX IF NOT EXISTS positions_one_open_per_token
  ON positions (mode, token_id)
  WHERE status = 'OPEN';

-- 2. Быстрый поиск открытых позиций по рынку (проверка heldConditionIds прямо в БД)
CREATE INDEX IF NOT EXISTS positions_open_by_condition
  ON positions (mode, condition_id)
  WHERE status = 'OPEN';

-- 3. Дата окончания рынка на позиции — чтобы находить «зависшие» 5-минутные крипто-рынки,
--    которые истекли 2 часа назад, но всё ещё OPEN по цене входа.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS market_end_at timestamptz;

-- 4. Легальные ручные пополнения/выводы. Всё остальное движение денег — только через positions.
CREATE TABLE IF NOT EXISTS cash_adjustments (
  id          serial PRIMARY KEY,
  mode        text NOT NULL,
  amount_usd  double precision NOT NULL,
  reason      text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 5. Кэш не может уйти в минус (paper). Если старые данные уже в минусе — сначала выполните сверку:
--    curl -X POST localhost:3000/api/bot/reconcile   (она пересчитает cash_usd из positions)
--    и при необходимости добавьте корректировку через чат: «Вася, внеси корректировку +50 причина: восстановление банка»
-- ALTER TABLE portfolios ADD CONSTRAINT portfolios_cash_nonnegative CHECK (cash_usd >= -0.01) NOT VALID;

-- 6. Один запущенный цикл на всю БД (advisory lock используется в коде, таблица — для наблюдаемости)
CREATE TABLE IF NOT EXISTS cycle_locks (
  name        text PRIMARY KEY,
  locked_by   text NOT NULL,
  locked_at   timestamptz NOT NULL DEFAULT now()
);

-- 7. Журнал реальных сделок live-режима (заполняется из user-канала WebSocket)
CREATE TABLE IF NOT EXISTS live_fills (
  id           serial PRIMARY KEY,
  order_id     text,
  trade_id     text UNIQUE,
  token_id     text NOT NULL,
  side         text NOT NULL,
  price        double precision NOT NULL,
  size         double precision NOT NULL,
  status       text NOT NULL,
  raw          jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
