/**
 * Межпроцессная блокировка цикла.
 *
 * Старый флаг `let running = false` в engine.ts живёт внутри ОДНОГО экземпляра модуля.
 * В Next.js (dev-режим, instrumentation + API-роуты, CLI-скрипт copytrader.mjs, hot-reload)
 * модуль может быть загружен несколько раз → два цикла идут одновременно →
 * обе копии видят «старый» список открытых позиций → дубли + лимиты не работают.
 *
 * Postgres advisory lock — глобальный для всей БД, независимо от числа процессов.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";

const LOCK_KEY = 0x504f4c59; // 'POLY'

export async function withCycleLock<T>(
  owner: string,
  fn: () => Promise<T>
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  // Отдельное соединение держит lock на всё время работы
  return db.transaction(async (tx) => {
    const res = await tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(${LOCK_KEY}) as ok`);
    const rows = Array.isArray(res) ? res : (res as unknown as { rows: { ok: boolean }[] }).rows;
    if (!rows[0]?.ok) return { acquired: false as const };
    await tx.execute(
      sql`insert into cycle_locks (name, locked_by, locked_at) values ('cycle', ${owner}, now())
          on conflict (name) do update set locked_by = excluded.locked_by, locked_at = now()`
    );
    try {
      const result = await fn();
      return { acquired: true as const, result };
    } finally {
      await tx.execute(sql`delete from cycle_locks where name = 'cycle'`).catch(() => {});
    }
  });
}

export async function cycleLockInfo(): Promise<{ locked: boolean; by?: string; since?: string }> {
  const res = await db.execute<{ locked_by: string; locked_at: string }>(sql`select locked_by, locked_at from cycle_locks where name = 'cycle'`);
  const rows = Array.isArray(res) ? res : (res as unknown as { rows: { locked_by: string; locked_at: string }[] }).rows;
  if (!rows[0]) return { locked: false };
  return { locked: true, by: rows[0].locked_by, since: rows[0].locked_at };
}
