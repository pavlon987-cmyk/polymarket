"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { AiMemoryRow } from "@/db/schema";
import { ago, api } from "@/lib/format";
import { Badge, Btn, Card, Empty, inputCls, type Tone } from "./ui";

const KINDS: { id: string; label: string; tone: Tone; desc: string }[] = [
  { id: "principle", label: "🧭 Принципы", tone: "violet", desc: "сжатые из уроков правила — главное, на что опирается Вася" },
  { id: "lesson", label: "📚 Уроки", tone: "amber", desc: "разбор каждой закрытой сделки" },
  { id: "whale_insight", label: "🐋 Инсайты о китах", tone: "sky", desc: "устойчивые паттерны конкретных трейдеров" },
  { id: "observation", label: "👀 Наблюдения", tone: "slate", desc: "свежие наблюдения за сделками китов" },
  { id: "market_note", label: "🗂 Категории", tone: "green", desc: "заметки по типам рынков" },
  { id: "strategy_result", label: "🧩 Стратегии", tone: "indigo", desc: "что показали стратегии" },
  { id: "user_note", label: "📝 Указания", tone: "red", desc: "ваши правила — высший приоритет" },
];

type Stats = { total: number; byKind: Record<string, number> };

export function MemoryViewer() {
  const [items, setItems] = useState<AiMemoryRow[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, byKind: {} });
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api<{ items: AiMemoryRow[]; stats: Stats }>(`/api/memory?limit=300${kind ? `&kind=${kind}` : ""}`)
        .then((r) => {
          setItems(r.items);
          setStats(r.stats);
          setErr(null);
        })
        .catch((e) => setErr(e.message)),
    [kind]
  );
  useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    if (!note.trim()) return;
    setBusy(true);
    try {
      await api("/api/memory", { method: "POST", body: JSON.stringify({ content: note, kind: "user_note" }) });
      setNote("");
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const del = async (id: number) => {
    await api(`/api/memory?id=${id}`, { method: "DELETE" });
    await load();
  };
  const wipe = async () => {
    if (!confirm("Стереть ВСЮ память Васи? Уроки, принципы, наблюдения и ваши указания будут удалены. Это необратимо.")) return;
    await api("/api/memory?id=all", { method: "DELETE" });
    await load();
  };

  const qq = q.trim().toLowerCase();
  const shown = qq ? items.filter((m) => m.content.toLowerCase().includes(qq) || m.subject.toLowerCase().includes(qq)) : items;
  const current = KINDS.find((k) => k.id === kind);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">🧠 Память Васи</h1>
          <p className="mt-1 text-sm text-slate-500">
            Всего {stats.total} записей. Всё это Вася читает перед каждым решением, хеджем, в стратегиях и в{" "}
            <Link href="/chat" className="text-indigo-400 hover:underline">
              чате
            </Link>
            .
          </p>
        </div>
        <div className="flex gap-2">
          <Btn size="sm" onClick={load}>
            ↻ обновить
          </Btn>
          <Btn variant="danger" size="sm" onClick={wipe} disabled={!stats.total}>
            стереть всё
          </Btn>
        </div>
      </div>

      {err && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">{err}</div>}

      {/* Фильтр по типу */}
      <div className="flex flex-wrap gap-1.5">
        <Btn size="sm" variant={kind === "" ? "primary" : "default"} onClick={() => setKind("")}>
          все ({stats.total})
        </Btn>
        {KINDS.map((k) => (
          <Btn key={k.id} size="sm" variant={kind === k.id ? "primary" : "default"} onClick={() => setKind(k.id)} title={k.desc}>
            {k.label} ({stats.byKind[k.id] ?? 0})
          </Btn>
        ))}
      </div>
      {current && <p className="-mt-2 text-xs text-slate-500">{current.desc}</p>}

      {/* Указание */}
      <Card title="📝 Дать Васе указание (запомнит навсегда, высший приоритет)">
        <div className="flex gap-2">
          <input
            className={inputCls}
            value={note}
            placeholder="Например: не ставь на UFC · максимум $5 на теннис ночью · не копируй цены выше 60¢"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <Btn variant="primary" onClick={add} loading={busy} disabled={!note.trim()}>
            запомнить
          </Btn>
        </div>
        <p className="mt-1.5 text-[11px] text-slate-500">То же самое можно сказать в чате — Вася сам добавит тег [[ЗАПОМНИ: …]].</p>
      </Card>

      {/* Список */}
      <Card
        title={current ? current.label : "Все записи"}
        right={<input className={`${inputCls} w-56`} placeholder="поиск…" value={q} onChange={(e) => setQ(e.target.value)} />}
        padded={false}
      >
        {shown.length === 0 ? (
          <Empty icon="🧠">
            {items.length ? "Ничего не найдено." : "Пока пусто. Память заполняется после закрытых сделок, наблюдений за китами и работы стратегий (нужен включённый ИИ)."}
          </Empty>
        ) : (
          <ul className="divide-y divide-slate-800/70">
            {shown.map((m) => {
              const k = KINDS.find((x) => x.id === m.kind);
              return (
                <li key={m.id} className="flex gap-3 px-4 py-3 text-sm hover:bg-slate-800/20">
                  <div className="w-40 shrink-0 space-y-1">
                    <Badge tone={k?.tone ?? "slate"}>{k?.label ?? m.kind}</Badge>
                    {m.subject && (
                      <p className="truncate text-[11px] text-slate-500" title={m.subject}>
                        {m.subject}
                      </p>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-slate-200">{m.content}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
                      <span title="важность">
                        <span className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-slate-800 align-middle">
                          <span className="block h-full bg-indigo-500" style={{ width: `${Math.round(m.importance * 100)}%` }} />
                        </span>{" "}
                        {Math.round(m.importance * 100)}%
                      </span>
                      <span>· использовано {m.usedCount}×</span>
                      <span>· {ago(m.createdAt)}</span>
                      {m.outcome && (
                        <span className={m.outcome === "WON" ? "text-emerald-400" : m.outcome === "LOST" ? "text-rose-400" : "text-amber-400"}>
                          · {m.outcome}
                          {m.pnlUsd != null ? ` ${m.pnlUsd >= 0 ? "+" : "-"}$${Math.abs(m.pnlUsd).toFixed(2)}` : ""}
                        </span>
                      )}
                    </p>
                  </div>
                  <button className="self-start text-slate-600 transition hover:text-rose-400" onClick={() => del(m.id)} title="забыть">
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
