"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BotLog } from "@/db/schema";
import { api, when } from "@/lib/format";
import { Badge, Btn, Card, Empty, Toggle, inputCls, type Tone } from "./ui";

const LEVELS: { id: string; label: string; tone: Tone }[] = [
  { id: "trade", label: "💱 сделки", tone: "green" },
  { id: "info", label: "info", tone: "slate" },
  { id: "warn", label: "warn", tone: "amber" },
  { id: "error", label: "error", tone: "red" },
];
const toneOf = (lvl: string): Tone => LEVELS.find((l) => l.id === lvl)?.tone ?? "slate";

export function LogViewer() {
  const [logs, setLogs] = useState<BotLog[]>([]);
  const [level, setLevel] = useState("");
  const [q, setQ] = useState("");
  const [auto, setAuto] = useState(true);
  const [limit, setLimit] = useState(300);
  const [err, setErr] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useCallback(
    () =>
      api<{ logs: BotLog[] }>(`/api/logs?limit=${limit}`)
        .then((r) => {
          setLogs(r.logs);
          setErr(null);
          setUpdatedAt(new Date());
        })
        .catch((e) => setErr(e.message)),
    [limit]
  );

  useEffect(() => {
    load();
    if (!auto) return;
    const t = setInterval(load, 5_000);
    return () => clearInterval(t);
  }, [load, auto]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const l of logs) c[l.level] = (c[l.level] ?? 0) + 1;
    return c;
  }, [logs]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return logs.filter((l) => (!level || l.level === level) && (!qq || l.message.toLowerCase().includes(qq)));
  }, [logs, level, q]);

  const download = () => {
    const text = [...filtered].reverse().map((l) => `${when(l.createdAt)}\t${l.level.toUpperCase()}\t${l.message}`).join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `copytrader-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">📜 Журнал</h1>
          <p className="mt-1 text-sm text-slate-500">
            Всё, что делает бот: циклы, решения ИИ, сделки, ошибки сети. {updatedAt && <>Обновлено {updatedAt.toLocaleTimeString("ru-RU")}.</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Toggle checked={auto} onChange={setAuto} label="автообновление" />
          <select className={`${inputCls} w-auto`} value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[100, 300, 600, 1000].map((n) => (
              <option key={n} value={n}>
                последние {n}
              </option>
            ))}
          </select>
          <Btn size="sm" onClick={load}>
            ↻ обновить
          </Btn>
          <Btn size="sm" variant="ghost" onClick={download} disabled={!filtered.length}>
            ⬇ .txt
          </Btn>
        </div>
      </div>

      {err && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
          Не удалось загрузить журнал: {err}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Btn size="sm" variant={level === "" ? "primary" : "default"} onClick={() => setLevel("")}>
          все ({logs.length})
        </Btn>
        {LEVELS.map((l) => (
          <Btn key={l.id} size="sm" variant={level === l.id ? "primary" : "default"} onClick={() => setLevel(level === l.id ? "" : l.id)}>
            {l.label} ({counts[l.id] ?? 0})
          </Btn>
        ))}
        <input className={`${inputCls} ml-auto max-w-xs`} placeholder="поиск по тексту… (рынок, кит, «ИИ», «стоп»)" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <Card padded={false}>
        {filtered.length === 0 ? (
          <Empty icon="📭">{logs.length ? "Ничего не найдено по фильтру." : "Журнал пуст — запусти цикл на дашборде."}</Empty>
        ) : (
          <ul className="max-h-[calc(100vh-18rem)] divide-y divide-slate-800/60 overflow-auto">
            {filtered.map((l) => (
              <li
                key={l.id}
                className={`flex gap-3 px-3 py-1.5 font-mono text-[12px] leading-relaxed hover:bg-slate-800/30 ${
                  l.level === "error" ? "bg-rose-500/5" : l.level === "trade" ? "bg-emerald-500/5" : l.level === "warn" ? "bg-amber-500/5" : ""
                }`}
              >
                <span className="w-[72px] shrink-0 pt-px text-slate-600" title={when(l.createdAt)}>
                  {new Date(l.createdAt).toLocaleTimeString("ru-RU")}
                </span>
                <Badge tone={toneOf(l.level)} className="w-14 shrink-0 justify-center self-start">
                  {l.level}
                </Badge>
                <span className="whitespace-pre-wrap break-words text-slate-300">{l.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
