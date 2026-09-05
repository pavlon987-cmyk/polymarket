import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiMemory, type AiMemoryRow, type PositionRow, type Settings, type Whale } from "@/db/schema";
import { chatCompletion, extractJson, type AiSettings } from "./ai";
import type { WhaleTrade } from "./types";

export type MemoryKind = "lesson" | "whale_insight" | "observation" | "market_note" | "strategy_result" | "principle" | "user_note";
export type MemSettings = AiSettings & Pick<Settings, "aiEnabled" | "aiMemoryEnabled" | "aiReflectEnabled" | "aiObserveWhales" | "aiMemoryMaxItems">;
type Log = (m: string) => void;

const clamp = (n: number, lo = 0, hi = 1) => (Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo);
const sign = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;

// ── Базовые операции ────────────────────────────────────────────────────────

export async function remember(
  kind: MemoryKind,
  subject: string,
  content: string,
  opts: { importance?: number; outcome?: string | null; pnlUsd?: number | null; meta?: unknown } = {}
) {
  const text = content.trim();
  if (!text) return;
  await db.insert(aiMemory).values({
    kind,
    subject: subject.slice(0, 120),
    content: text.slice(0, 1500),
    importance: clamp(opts.importance ?? 0.5),
    outcome: opts.outcome ?? null,
    pnlUsd: opts.pnlUsd ?? null,
    meta: opts.meta ?? null,
  });
}

export async function recall(opts: { kinds?: MemoryKind[]; subject?: string; limit?: number } = {}): Promise<AiMemoryRow[]> {
  const conds = [];
  if (opts.kinds?.length) conds.push(inArray(aiMemory.kind, opts.kinds));
  if (opts.subject) conds.push(eq(aiMemory.subject, opts.subject));
  const rows = await db
    .select()
    .from(aiMemory)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(aiMemory.importance), desc(aiMemory.id))
    .limit(opts.limit ?? 20);
  if (rows.length) {
    await db
      .update(aiMemory)
      .set({ usedCount: sql`${aiMemory.usedCount} + 1` })
      .where(inArray(aiMemory.id, rows.map((r) => r.id)));
  }
  return rows;
}

export async function listMemory(limit = 200, kind?: MemoryKind) {
  return db.select().from(aiMemory).where(kind ? eq(aiMemory.kind, kind) : undefined).orderBy(desc(aiMemory.id)).limit(limit);
}

export async function forget(id: number) {
  await db.delete(aiMemory).where(eq(aiMemory.id, id));
}

export async function forgetAll() {
  await db.execute(sql`delete from ai_memory`);
}

export async function memoryStats() {
  const rows = await db.select({ kind: aiMemory.kind, n: sql<number>`count(*)` }).from(aiMemory).groupBy(aiMemory.kind);
  const byKind: Record<string, number> = {};
  for (const r of rows) byKind[r.kind] = Number(r.n);
  return { total: Object.values(byKind).reduce((a, b) => a + b, 0), byKind };
}

// ── Блок памяти для промтов ─────────────────────────────────────────────────

export async function buildMemoryBlock(ctx: { whaleName?: string; category?: string; strategyId?: string } = {}, maxChars = 3500): Promise<string> {
  const [principles, lessons, userNotes, whale, cat, strat] = await Promise.all([
    recall({ kinds: ["principle"], limit: 10 }),
    recall({ kinds: ["lesson"], limit: 12 }),
    recall({ kinds: ["user_note"], limit: 8 }),
    ctx.whaleName ? recall({ kinds: ["whale_insight", "observation"], subject: ctx.whaleName, limit: 8 }) : Promise.resolve([]),
    ctx.category ? recall({ kinds: ["market_note"], subject: ctx.category, limit: 5 }) : Promise.resolve([]),
    ctx.strategyId ? recall({ kinds: ["strategy_result"], subject: ctx.strategyId, limit: 5 }) : Promise.resolve([]),
  ]);
  const fmt = (title: string, rows: AiMemoryRow[]) =>
    rows.length
      ? `### ${title}\n${rows.map((r) => `- ${r.outcome ? `[${r.outcome}${r.pnlUsd != null ? ` ${sign(r.pnlUsd)}` : ""}] ` : ""}${r.content}`).join("\n")}`
      : "";
  const block = [
    fmt("Мои принципы (выведены из опыта)", principles),
    fmt("Указания пользователя", userNotes),
    fmt("Уроки из прошлых сделок", lessons),
    ctx.whaleName ? fmt(`Что я знаю про трейдера «${ctx.whaleName}»`, whale) : "",
    ctx.category ? fmt(`Заметки по категории «${ctx.category}»`, cat) : "",
    ctx.strategyId ? fmt(`Результаты стратегии «${ctx.strategyId}»`, strat) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return block ? `\n\n## ПАМЯТЬ ВАСИ (используй это при принятии решения)\n${block}`.slice(0, maxChars) : "";
}

// ── Обучение: разбор закрытой сделки ────────────────────────────────────────

export async function reflectOnClosedPosition(s: MemSettings, pos: PositionRow, status: string, profitUsd: number, reason: string, log: Log) {
  if (!s.aiEnabled || !s.aiMemoryEnabled || !s.aiReflectEnabled) return;
  const heldHours = Math.round((Date.now() - new Date(pos.openedAt).getTime()) / 3_600_000);
  const facts = {
    source: pos.source,
    market: pos.market,
    outcome: pos.outcome,
    category: pos.category,
    whale: pos.whaleName,
    entry: pos.price,
    exit: pos.lastPrice ?? null,
    costUsd: pos.costUsd,
    status,
    profitUsd: Math.round(profitUsd * 100) / 100,
    roiPct: pos.costUsd ? Math.round((profitUsd / pos.costUsd) * 100) : 0,
    closeReason: reason,
    heldHours,
    reasonAtEntry: pos.aiDecision?.reason ?? null,
  };
  const prompt = `Сделка закрыта. Сделай короткий честный разбор (post-mortem), чтобы в будущем торговать лучше.
Факты: ${JSON.stringify(facts)}

Ответь СТРОГО JSON:
{"lesson":"одно конкретное, проверяемое правило на будущее (до 200 символов)",
 "whaleInsight":"что это говорит о трейдере/стратегии-источнике: сильные/слабые стороны (до 150 символов) или null",
 "categoryNote":"замечание про категорию/тип рынка (до 150 символов) или null",
 "importance":0..1}`;
  try {
    const { content } = await chatCompletion(
      { ...s, aiSystemPrompt: "Ты — трейдер, который учится на своих сделках. Отвечай ТОЛЬКО JSON.", aiTemperature: 0.2 },
      [{ role: "user", content: prompt }]
    );
    const r = extractJson(content) as { lesson?: string; whaleInsight?: string | null; categoryNote?: string | null; importance?: number } | null;
    if (!r?.lesson) return;
    const imp = clamp(r.importance ?? Math.min(1, 0.4 + Math.abs(profitUsd) / 20));
    await remember("lesson", pos.category, r.lesson, { importance: imp, outcome: status, pnlUsd: profitUsd, meta: facts });
    if (r.whaleInsight) {
      await remember("whale_insight", pos.whaleName, r.whaleInsight, { importance: imp, outcome: status, pnlUsd: profitUsd });
      if (pos.source !== "copy") await remember("strategy_result", pos.source, r.whaleInsight, { importance: imp, outcome: status, pnlUsd: profitUsd });
    }
    if (r.categoryNote) await remember("market_note", pos.category, r.categoryNote, { importance: imp * 0.8, outcome: status });
    log(`🧠 Урок: ${r.lesson}`);
  } catch (err) {
    log(`🧠 Разбор сделки не удался: ${(err as Error).message}`);
  }
}

// ── Обучение: наблюдение за чужими сделками ─────────────────────────────────

export async function observeWhaleTrades(s: MemSettings, whale: Whale, trades: WhaleTrade[], log: Log) {
  if (!s.aiEnabled || !s.aiMemoryEnabled || !s.aiObserveWhales || !trades.length) return;
  const now = Date.now() / 1000;
  const sample = trades.slice(0, 12).map((t) => ({
    side: t.side,
    market: t.title,
    outcome: t.outcome,
    price: t.price,
    usd: Math.round(t.size * t.price),
    ageMin: Math.round((now - t.timestamp) / 60),
  }));
  const known = await recall({ kinds: ["whale_insight"], subject: whale.name, limit: 6 });
  const prompt = `Ты изучаешь трейдера «${whale.name}» (категория ${whale.category}). Заметки: ${whale.notes || "нет"}.
Что ты уже знаешь о нём:
${known.map((k) => `- ${k.content}`).join("\n") || "- пока ничего"}

Его новые сделки:
${JSON.stringify(sample)}

Разберись: КУДА он ставит (какие рынки), ЗАЧЕМ (какую неэффективность ловит), НА ЧТО (фавориты/аутсайдеры, диапазон цен, размер), КОГДА (за сколько до события). Не повторяй уже известное.
Ответь СТРОГО JSON:
{"observation":"новое наблюдение (до 250 символов)","pattern":"устойчивый паттерн, который стоит копировать или избегать (до 200 символов) или null","confidence":0..1}`;
  try {
    const { content } = await chatCompletion(
      { ...s, aiSystemPrompt: "Ты аналитик, изучающий чужие сделки. Отвечай ТОЛЬКО JSON.", aiTemperature: 0.2 },
      [{ role: "user", content: prompt }]
    );
    const r = extractJson(content) as { observation?: string; pattern?: string | null; confidence?: number } | null;
    if (!r?.observation) return;
    const conf = clamp(r.confidence ?? 0.5);
    await remember("observation", whale.name, r.observation, { importance: conf * 0.6, meta: { trades: sample } });
    if (r.pattern) await remember("whale_insight", whale.name, r.pattern, { importance: Math.max(0.6, conf) });
    log(`🧠 Наблюдение (${whale.name}): ${r.observation}`);
  } catch (err) {
    log(`🧠 Наблюдение не удалось: ${(err as Error).message}`);
  }
}

// ── Обучение: результат стратегии ───────────────────────────────────────────

export async function rememberStrategyResult(strategyId: string, summary: string, pnlUsd: number | null, meta?: unknown) {
  await remember("strategy_result", strategyId, summary, { importance: 0.5, pnlUsd, meta });
}

// ── Консолидация: уроки → принципы ──────────────────────────────────────────

export async function consolidateMemory(s: MemSettings, log: Log) {
  if (!s.aiEnabled || !s.aiMemoryEnabled) return;
  const stats = await memoryStats();
  const lessonsN = stats.byKind.lesson ?? 0;
  if (stats.total <= s.aiMemoryMaxItems || lessonsN < 40) return;

  const lessons = await db.select().from(aiMemory).where(eq(aiMemory.kind, "lesson")).orderBy(desc(aiMemory.id)).limit(120);
  const principles = await recall({ kinds: ["principle"], limit: 15 });
  const prompt = `Вот ${lessons.length} уроков из моих сделок и ${principles.length} уже выведенных принципов.
Сожми всё в 10–15 главных принципов торговли на Polymarket. Сохрани цифры и конкретику, убери дубли и противоречия (побеждает то, что подтверждено большей суммой P&L).

Принципы сейчас:
${principles.map((p) => `- ${p.content}`).join("\n") || "- нет"}

Уроки:
${lessons.map((l) => `- [${l.outcome ?? "?"} ${l.pnlUsd != null ? sign(l.pnlUsd) : ""}] ${l.content}`).join("\n")}

Ответь СТРОГО JSON: {"principles":["...","..."]}`;
  try {
    const { content } = await chatCompletion(
      { ...s, aiSystemPrompt: "Ты сжимаешь опыт в принципы. Отвечай ТОЛЬКО JSON.", aiTemperature: 0.2, aiTimeoutMs: 90_000 },
      [{ role: "user", content: prompt }]
    );
    const r = extractJson(content) as { principles?: string[] } | null;
    if (!r?.principles?.length) return;
    await db.delete(aiMemory).where(eq(aiMemory.kind, "principle"));
    for (const p of r.principles.slice(0, 15)) await remember("principle", "", p, { importance: 0.9 });
    const keep = await db
      .select({ id: aiMemory.id })
      .from(aiMemory)
      .where(eq(aiMemory.kind, "lesson"))
      .orderBy(desc(aiMemory.importance), desc(aiMemory.id))
      .limit(30);
    const keepIds = keep.map((k) => k.id);
    if (keepIds.length) {
      await db.delete(aiMemory).where(and(eq(aiMemory.kind, "lesson"), sql`${aiMemory.id} not in (${sql.join(keepIds.map((i) => sql`${i}`), sql`, `)})`));
    }
    await db.execute(
      sql`delete from ai_memory where kind = 'observation' and id not in (select id from ai_memory where kind = 'observation' order by id desc limit 100)`
    );
    log(`🧠 Память консолидирована: ${r.principles.length} принципов`);
  } catch (err) {
    log(`🧠 Консолидация не удалась: ${(err as Error).message}`);
  }
}

/** Вася может сам попросить что-то запомнить: в ответе пишет [[ЗАПОМНИ: ...]] */
export async function extractRememberTags(reply: string): Promise<string> {
  const re = /\[\[\s*ЗАПОМНИ\s*:\s*([\s\S]*?)\]\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(reply))) {
    await remember("user_note", "", m[1], { importance: 0.85 });
  }
  return reply.replace(re, "").trim();
}

export async function rememberFact(text: string, topic = "general") {
  await db.execute(sql`insert into ai_memory (kind, subject, content, importance, created_at) values ('lesson', ${topic}, ${text}, 0.9, now())`);
  return { ok: true };
}
