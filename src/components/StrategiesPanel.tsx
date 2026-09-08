"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, usd } from "@/lib/format";
import { Alert, Badge, Btn, Card, Field, Pnl, Toggle, inputCls } from "./ui";

type Params = Record<string, number | string | boolean>;
type Strat = {
  id: string;
  name: string;
  emoji: string;
  description: string;
  needsAi: boolean;
  manualRun: boolean;
  defaults: { maxBetUsd: number; maxPositions: number; params: Params };
  paramLabels: Record<string, string>;
  config: { enabled: boolean; maxBetUsd: number; maxPositions: number; params: Params };
  stats: { open: number; closed: number; wins: number; losses: number; investedUsd: number; pnlUsd: number; unrealizedUsd: number } | null;
};
type Resp = { mode: string; aiEnabled: boolean; strategies: Strat[] };
type RunResp = { ok: boolean; result: { opened: number; scanned: number; skipped: number; mode: string; notesLog: string[] } };

const RISK: Record<string, { label: string; tone: "green" | "amber" | "red" | "slate" }> = {
  arb_yes_no: { label: "низкий риск", tone: "green" },
  cross_venue_arb: { label: "минимальный (арбитраж)", tone: "green" },
  favorite_finish: { label: "низкий риск", tone: "green" },
  spot_strike_sniper: { label: "низкий риск (спот)", tone: "green" },
  crypto_threshold: { label: "низкий–средний", tone: "green" },
  news_lag: { label: "средний (новости)", tone: "amber" },
  copy: { label: "зависит от кита", tone: "amber" },
  consensus: { label: "средний", tone: "amber" },
  momentum: { label: "средний", tone: "amber" },
  free_swim: { label: "средний", tone: "amber" },
  contrarian: { label: "высокий", tone: "red" },
  cheap_longshot: { label: "высокий", tone: "red" },
  auto_scout: { label: "не торгует", tone: "slate" },
};

export function StrategiesPanel() {
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ maxBetUsd: number; maxPositions: number; params: Params } | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [runLog, setRunLog] = useState<{ id: string; lines: string[]; summary?: string } | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const load = useCallback(() => api<Resp>("/api/strategies").then(setData).catch((e) => setErr(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);

  if (!data) return <div className="py-20 text-center text-slate-500">{err ?? "Загрузка…"}</div>;

  const toggle = async (s: Strat) => {
    setToggling(s.id);
    try {
      await api("/api/strategies", { method: "PUT", body: JSON.stringify({ id: s.id, enabled: !s.config.enabled }) });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setToggling(null);
    }
  };
  const startEdit = (s: Strat) => {
    setEditing(s.id);
    setDraft({ maxBetUsd: s.config.maxBetUsd, maxPositions: s.config.maxPositions, params: { ...s.defaults.params, ...s.config.params } });
  };
  const save = async () => {
    if (!editing || !draft) return;
    try {
      await api("/api/strategies", { method: "PUT", body: JSON.stringify({ id: editing, ...draft }) });
      setEditing(null);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const runNow = async (s: Strat) => {
    setRunning(s.id);
    setRunLog(null);
    try {
      const r = await api<RunResp>("/api/strategies", { method: "POST", body: JSON.stringify({ id: s.id }) });
      setRunLog({ id: s.id, lines: r.result.notesLog, summary: `${r.result.mode.toUpperCase()} · просмотрено ${r.result.scanned} · открыто ${r.result.opened} · пропущено ${r.result.skipped}` });
    } catch (e) {
      setRunLog({ id: s.id, lines: [`❌ ${(e as Error).message}`] });
    } finally {
      setRunning(null);
      await load();
    }
  };

  const runAllEnabled = async () => {
    setRunningAll(true);
    setRunLog(null);
    try {
      const r = await api<{ ok: boolean; results: Record<string, { scanned: number; opened: number; skipped: number; mode: string; notesLog: string[] }> }>("/api/strategies", {
        method: "POST",
        body: JSON.stringify({ runAllEnabled: true }),
      });
      if (r.results) {
        const allLines: string[] = [];
        let totalOpened = 0;
        let totalScanned = 0;
        for (const [id, res] of Object.entries(r.results)) {
          const strat = data.strategies.find((x) => x.id === id);
          const name = strat ? `${strat.emoji} ${strat.name}` : id;
          allLines.push(`=== ${name} ===`);
          if (res.notesLog?.length) allLines.push(...res.notesLog);
          allLines.push(`Итог: просмотрено ${res.scanned}, открыто ${res.opened}, пропущено ${res.skipped}\n`);
          totalOpened += res.opened;
          totalScanned += res.scanned;
        }
        setRunLog({
          id: "all",
          lines: allLines,
          summary: `Все включённые · просмотрено ${totalScanned} · открыто ${totalOpened}`,
        });
      }
    } catch (e) {
      setRunLog({ id: "all", lines: [`❌ ${(e as Error).message}`] });
    } finally {
      setRunningAll(false);
      await load();
    }
  };

  const enabled = data.strategies.filter((s) => s.config.enabled);
  const totalPnl = data.strategies.reduce((a, s) => a + (s.stats?.pnlUsd ?? 0), 0);
  const budget = enabled.reduce((a, s) => a + s.config.maxBetUsd * s.config.maxPositions, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">🧩 Стратегии Васи</h1>
          <p className="mt-1 text-sm text-slate-500">
            Включено {enabled.length}/{data.strategies.length} · режим {data.mode.toUpperCase()} · макс. экспозиция включённых ≈ {usd(budget)} · суммарный P&L <Pnl value={totalPnl} />
          </p>
        </div>
        <div className="flex items-center gap-2">
          {enabled.some((s) => s.manualRun) && (
            <Btn size="sm" variant="primary" onClick={runAllEnabled} loading={runningAll} disabled={runningAll || running !== null}>
              ▶ Запустить все включённые ({enabled.filter((s) => s.manualRun).length})
            </Btn>
          )}
          <Btn size="sm" onClick={load}>
            ↻ обновить
          </Btn>
        </div>
      </div>

      {err && (
        <Alert tone="red" title="Ошибка" right={<Btn size="sm" variant="ghost" onClick={() => setErr(null)}>✕</Btn>}>
          {err}
        </Alert>
      )}
      {!data.aiEnabled && (
        <Alert tone="amber" title="ИИ выключен">
          Стратегии с пометкой 🤖 пропускаются.{" "}
          <Link href="/settings#ai" className="underline">
            Включить ИИ →
          </Link>
        </Alert>
      )}
      <Alert tone="sky">
        Все стратегии работают внутри авто-цикла, ставят через один исполнитель (paper или live) и подчиняются общему стоп-лоссу портфеля и лимиту открытых позиций. Позиции стратегий закрываются по резолву рынка, экстремальной цене и своим стоп/тейк в процентах. Для старта в paper рекомендуем: ⚖️ + 🏁 + ₿ (без ИИ, понятная математика), затем 🎯 и 🔄.
      </Alert>

      {runLog?.id === "all" && (
        <Card title="📋 Результат прогона всех включённых стратегий">
          {runLog.summary && <div className="mb-2 text-xs font-medium text-emerald-400">{runLog.summary}</div>}
          <pre className="max-h-80 overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
            {(runLog.lines ?? []).join("\n") || "пусто"}
          </pre>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {data.strategies.map((s) => {
          const disabledAi = s.needsAi && !data.aiEnabled;
          const st = s.stats;
          const risk = RISK[s.id];
          const winRate = st && st.wins + st.losses ? Math.round((st.wins / (st.wins + st.losses)) * 100) : null;
          return (
            <Card
              key={s.id}
              className={s.config.enabled ? (disabledAi ? "border-amber-500/30" : "border-emerald-500/30") : ""}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-base">
                    {s.emoji} {s.name}
                  </span>
                  {s.needsAi && <Badge tone="violet">🤖 ИИ</Badge>}
                  {s.id === "copy" && <Badge tone="sky">базовая</Badge>}
                  {risk && <Badge tone={risk.tone}>{risk.label}</Badge>}
                </span>
              }
              right={<Toggle checked={s.config.enabled} disabled={toggling === s.id} onChange={() => toggle(s)} label={s.config.enabled ? "вкл" : "выкл"} />}
            >
              <p className="text-xs leading-relaxed text-slate-400">{s.description}</p>
              {disabledAi && s.config.enabled && <p className="mt-2 text-xs text-amber-300">⚠️ Включена, но ИИ выключен — стратегия пропускается.</p>}

              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                {s.config.maxBetUsd > 0 && <Badge>ставка до {usd(s.config.maxBetUsd)}</Badge>}
                {s.config.maxPositions > 0 && <Badge>позиций до {s.config.maxPositions}</Badge>}
                {st ? (
                  <>
                    <Badge tone={st.pnlUsd > 0 ? "green" : st.pnlUsd < 0 ? "red" : "slate"}>
                      откр. {st.open} · закр. {st.closed} · W/L {st.wins}/{st.losses}
                      {winRate !== null && ` (${winRate}%)`}
                    </Badge>
                    <span className="flex items-center gap-1 text-slate-400">
                      P&L <Pnl value={st.pnlUsd} /> · нереализ. <Pnl value={st.unrealizedUsd} />
                    </span>
                  </>
                ) : (
                  <span className="text-slate-600">сделок ещё не было</span>
                )}
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {s.id === "copy" ? (
                  <Link href="/whales" className="inline-flex items-center rounded-lg border border-indigo-500/60 bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500">
                    🐋 Управлять китами →
                  </Link>
                ) : (
                  <Btn size="sm" variant={editing === s.id ? "default" : "primary"} onClick={() => (editing === s.id ? setEditing(null) : startEdit(s))}>
                    ⚙ {editing === s.id ? "Скрыть параметры" : "Параметры"}
                  </Btn>
                )}
                {s.manualRun && (
                  <Btn size="sm" onClick={() => runNow(s)} loading={running === s.id} disabled={running === s.id || runningAll || disabledAi} title="Один прогон вне авто-цикла (ставит по-настоящему в текущем режиме)">
                    ▶ Запустить сейчас
                  </Btn>
                )}
              </div>

              {editing === s.id && draft && (
                <div className="mt-4 space-y-3 rounded-xl border border-indigo-500/20 bg-slate-950/60 p-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {s.defaults.maxBetUsd > 0 && (
                      <Field label="Макс. ставка, $" hint={`по умолчанию ${s.defaults.maxBetUsd}`}>
                        <input type="number" step="any" className={inputCls} value={draft.maxBetUsd} onChange={(e) => setDraft({ ...draft, maxBetUsd: Number(e.target.value) })} />
                      </Field>
                    )}
                    {s.defaults.maxPositions > 0 && (
                      <Field label="Макс. одновременных позиций" hint={`по умолчанию ${s.defaults.maxPositions}`}>
                        <input type="number" step="1" className={inputCls} value={draft.maxPositions} onChange={(e) => setDraft({ ...draft, maxPositions: Number(e.target.value) })} />
                      </Field>
                    )}
                    {Object.keys(s.defaults.params).map((k) => (
                      <Field key={k} label={s.paramLabels[k] ?? k} hint={`по умолчанию ${String(s.defaults.params[k])}${k.endsWith("Pct") && !s.paramLabels[k]?.includes("%") ? " (доля: 0.2 = 20%)" : ""}`}>
                        <input type="number" step="any" className={inputCls} value={Number(draft.params[k] ?? s.defaults.params[k])} onChange={(e) => setDraft({ ...draft, params: { ...draft.params, [k]: Number(e.target.value) } })} />
                      </Field>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Btn size="sm" variant="primary" onClick={save}>
                      💾 Сохранить
                    </Btn>
                    <Btn size="sm" variant="ghost" onClick={() => setDraft({ maxBetUsd: s.defaults.maxBetUsd, maxPositions: s.defaults.maxPositions, params: { ...s.defaults.params } })}>
                      сбросить к дефолту
                    </Btn>
                    <Btn size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      отмена
                    </Btn>
                  </div>
                </div>
              )}

              {runLog?.id === s.id && (
                <div className="mt-3">
                  {runLog.summary && <div className="mb-1 text-xs text-slate-400">{runLog.summary}</div>}
                  <pre className="max-h-64 overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-300">{(runLog.lines ?? []).join("\n") || "пусто"}</pre>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
