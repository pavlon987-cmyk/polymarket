/**
 * Межпроцессная блокировка цикла.
 *
 * Advisory xact-lock держим внутри транзакции (на одном соединении),
 * а "видимый" маркер в таблице cycle_locks пишем/чистим ВНЕ транзакции,
 * чтобы cycleLockInfo() корректно работал из других сессий/роутов.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";

const LOCK_KEY = 0x504f4c59; // 'POLY'
const LOCK_NAME = "cycle";

// если процесс упал — строка может остаться; считаем её протухшей
const STALE_MS = 30 * 60 * 1000;

type ExecResult<T> = { rows: T[] } | T[];

function rowsOf<T>(res: ExecResult<T>): T[] {
  return Array.isArray(res) ? res : (res as { rows: T[] }).rows;
}

export async function withCycleLock<T>(
  owner: string,
  fn: () => Promise<T>
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  return db.transaction(async (tx) => {
    const res = await tx.execute<{ ok: boolean }>(
      sql`select pg_try_advisory_xact_lock(${LOCK_KEY}) as ok`
    );

    if (!rowsOf(res)[0]?.ok) return { acquired: false as const };

    // ВАЖНО: маркер пишем ВНЕ tx, чтобы был виден другим подключениям
    await db
      .execute(sql`
        insert into cycle_locks (name, locked_by, locked_at)
        values (${LOCK_NAME}, ${owner}, now())
        on conflict (name) do update
        set locked_by = excluded.locked_by, locked_at = now()
      `)
      .catch(() => {});

    try {
      const result = await fn();
      return { acquired: true as const, result };
    } finally {
      // чистим маркер тоже ВНЕ tx
      await db
        .execute(sql`
          delete from cycle_locks
          where name = ${LOCK_NAME} and locked_by = ${owner}
        `)
        .catch(() => {});
    }
  });
}

export async function cycleLockInfo(): Promise<{ locked: boolean; by?: string; since?: string }> {
  const res = await db.execute<{ locked_by: string; locked_at: string }>(
    sql`select locked_by, locked_at from cycle_locks where name = ${LOCK_NAME}`
  );

  const row = rowsOf(res)[0];
  if (!row) return { locked: false };

  const atMs = new Date(row.locked_at).getTime();
  if (Number.isFinite(atMs) && Date.now() - atMs > STALE_MS) {
    await db.execute(sql`delete from cycle_locks where name = ${LOCK_NAME}`).catch(() => {});
    return { locked: false };
  }

  return { locked: true, by: row.locked_by, since: row.locked_at };
}
