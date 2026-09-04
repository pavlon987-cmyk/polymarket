"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ago, api, cents, pct, usd, when } from "@/lib/format";
import { Alert, Badge, Btn, Card, Empty, ModeBadge, Pnl, Stat, Table, sourceLabel, statusTone } from "./ui";

type Position = {
  id: number;
  source: string;
  whaleName: string;
  category: string;
  market: string;
  outcome: string;
  price: number;
  lastPrice: number | null;
  shares: number;
  costUsd: number;
  status: string;
  profitUsd: number | null;
  closeReason: string | null;
  openedAt: string;
  closedAt: string | null;
  aiDecision: { decision: string; confidence: number; reason: string } | null;
};
type WhaleStat = { whaleName: string; copied: number; open: number; wins: number; losses: number; sold: number; investedUsd: number; pnlUsd: number; unrealizedUsd: number };
type SourceStat = { open: number; closed: number; wins: number; losses: number; investedUsd: number; pnlUsd: number; unrealizedUsd: number };
type AiDec = { id: number; whaleName: string; market: string; outcome: string; price: number; decision: string; confidence: number; sizeMultiplier: number; reason: string; applied: boolean; createdAt: string };
type CycleResult = { ok: boolean; trigger: string; closed: number; opened: number; sold: number; halted: boolean; error?: string; notes: string[]; finishedAt: string };
type Status = {
  mode: "paper" | "live";
  configuredMode: string;
  liveReadiness: { ready: boolean; reasons: string[] };
  aiEnabled: boolean;
  runner: { running: boolean; cycleInProgress: boolean; lastRunAt: string | null; nextRunAt: string | null; lastResult: CycleResult | null };
  portfolio: { startingBankUsd: number; cashUsd: number; realizedPnlUsd: number; totalInvestedUsd: number; halted: boolean; cyclesRun: number; lastCycleAt: string | null; inPositions: number; equity: number };
  open: Position[];
  closed: Position[];
  whaleStats: WhaleStat[];
  sourceStats: Record<string, SourceStat>;
  aiDecisions: AiDec[];
  whalesCount: number;
  enabledWhales: number;
};

const unreal = (p: Position) => p.shares * (p.lastPrice ?? p.price) - p.costUsd;
const roi = (p: Position, pnl: number) => (p.costUsd ? (pnl / p.costUsd) * 100 : 0);
const short = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const secondsTo = (iso: string | null) => (iso ? Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000)) : null);

export function Dashboard() {
  const [viewMode, setViewMode] = useState<"paper" | "live" | null>(null);
  const [s, setS] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<CycleResult | null>(null);
  const [closedFilter, setClosedFilter] = useState<"all" | "WON" | "LOST" | "SOLD">("all");
  const [tick, setTick] = useState(0);

  const load = useCallback(
    () =>
      api<Status>(`/api/bot/status${viewMode ? `?mode=${viewMode}` : ""}`)
        .then((d) => {
          setS(d);
          setErr(null);
        })
        .catch((e) => setErr(e.message)),
    [viewMode]
  );

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    const tk = setInterval(() => setTick((x) => x + 1), 1000);
    return () => {
      clearInterval(t);
      clearInterval(tk);
    };
  }, [load]);

  const runNow = async () => {
    setBusy("run");
    try {
      const r = await api<CycleResult>("/api/bot/run", { method: "POST" });
      setLastRun(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      await load();
    }
  };
  const loop = async (action: "start" | "stop") => {
    setBusy("loop");
    try {
      await api("/api/bot/loop", { method: "POST", body: JSON.stringify({ action }) });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      await load();
    }
  };
  const reset = async () => {
    if (!s) return;
    if (!confirm(`Сбросить портфель ${s.mode.toUpperCase()}?\nВсе позиции, решения ИИ и статистика этого режима будут удалены. Память Васи останется.`)) return;
    setBusy("reset");
    try {
      await api("/api/bot/reset", { method: "POST", body: JSON.stringify({ mode: s.mode }) });
      setLastRun(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      await load();
    }
  };

  if (!s) {
    return (
      <div className="py-24 text-center">
        {err ? (
          <>
            <p className="text-rose-300">{err}</p>
            <p className="mt-2 text-sm text-slate-500">
              Проверь <code>DATABASE_URL</code> в <code>.env</code> и что выполнен <code>npm run db:push</code>.
            </p>
          </>
        ) : (
          <p className="text-slate-500">Загрузка…</p>
        )}
      </div>
    );
  }

  const p = s.portfolio;
  const r = s.runner;
  const ret = p.startingBankUsd ? ((p.equity - p.startingBankUsd) / p.startingBankUsd) * 100 : 0;
  const unrealTotal = s.open.reduce((a, x) => a + unreal(x), 0);
  const wins = s.closed.filter((c) => c.status === "WON" || (c.profitUsd ?? 0) > 0).length;
  const losses = s.closed.filter((c) => c.status === "LOST" || (c.profitUsd ?? 0) < 0).length;
  const sold = s.closed.filter((c) => c.status === "SOLD").length;
  const winRate = wins + losses ? (wins / (wins + losses)) * 100 : null;
  const closedShown = s.closed.filter((c) => closedFilter === "all" || c.status === closedFilter).slice(0, 40);
  const nextIn = secondsTo(r.nextRunAt);
  void tick;
  const cycle = lastRun ?? r.lastResult;

  return (
    <div className="space-y-6">
      {/* Шапка */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold text-white">
            Дашборд <ModeBadge mode={s.mode} />
            {p.halted && <Badge tone="red">🚨 HALTED</Badge>}
            {r.cycleInProgress && <Badge tone="amber">⏳ цикл выполняется</Badge>}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Циклов: {p.cyclesRun} · последний {ago(p.lastCycleAt)} · китов активно {s.enabledWhales}/{s.whalesCount} · ИИ {s.aiEnabled ? "включён" : "выключен"}
            {r.running && nextIn !== null && <> · следующий цикл через {nextIn >= 60 ? `${Math.floor(nextIn / 60)} мин ${nextIn % 60} с` : `${nextIn} с`}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-slate-700 p-0.5 text-xs" title="Какой портфель показывать">
            {(["paper", "live"] as const).map((m) => (
              <button key={m} onClick={() => setViewMode(m)} className={`rounded-md px-2.5 py-1 transition ${s.mode === m ? (m === "live" ? "bg-rose-600/80 text-white" : "bg-slate-700 text-white") : "text-slate-400 hover:text-slate-200"}`}>
                {m.toUpperCase()}
              </button>
            ))}
          </div>
          <Btn size="sm" onClick={load} title="Обновить">
            ↻
          </Btn>
          <Btn variant={r.running ? "danger" : "success"} onClick={() => loop(r.running ? "stop" : "start")} loading={busy === "loop"}>
            {r.running ? "⏹ Стоп авто-цикл" : "🟢 Старт авто-цикл"}
          </Btn>
          <Btn variant="primary" onClick={runNow} loading={busy === "run"} disabled={r.cycleInProgress}>
            ▶ Цикл сейчас
          </Btn>
          <Btn variant="ghost" onClick={reset} disabled={busy !== null} title="Сбросить портфель этого режима">
            🗑 Сброс
          </Btn>
        </div>
      </div>

      {/* Предупреждения */}
      {err && (
        <Alert tone="red" title="Ошибка" right={<Btn size="sm" variant="ghost" onClick={() => setErr(null)}>✕</Btn>}>
          {err}
        </Alert>
      )}
      {p.halted && (
        <Alert tone="red" title="🚨 Сработал стоп-лосс портфеля">
          Бот больше не открывает позиции (открытые продолжают отслеживаться). Снять блокировку: сбросить портфель или увеличить «Стоп-лосс портфеля» в{" "}
          <Link href="/settings" className="underline">
            настройках
          </Link>
          .
        </Alert>
      )}
      {s.configuredMode === "live" && !s.liveReadiness.ready && (
        <Alert tone="amber" title="Выбран Live, но реальные сделки не активированы — бот работает как paper">
          <ul className="mt-1 list-disc pl-5">
            {s.liveReadiness.reasons.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </Alert>
      )}
      {s.mode === "live" && s.liveReadiness.ready && (
        <Alert tone="red" title="⚠️ Реальные деньги">
          Все ордера отправляются на Polymarket. Лимит банка и размеры ставок — в настройках и стратегиях.
        </Alert>
      )}
      {s.enabledWhales === 0 && (
        <Alert tone="sky" title="Нет активных китов">
          Копирование не работает без китов.{" "}
          <Link href="/whales" className="underline">
            Добавить →
          </Link>{" "}
          Остальные стратегии (арбитраж, крипто-порог и т.д.) — на странице{" "}
          <Link href="/strategies" className="underline">
            Стратегии
          </Link>
          .
        </Alert>
      )}

      {/* Статы */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Stat label="Эквити" icon="💎" tone={ret > 0 ? "green" : ret < 0 ? "red" : "slate"} value={usd(p.equity)} sub={<span className={ret >= 0 ? "text-emerald-400" : "text-rose-400"}>{pct(ret)} от {usd(p.startingBankUsd)}</span>} />
        <Stat label="Кэш" icon="💵" value={usd(p.cashUsd)} sub={`${p.equity ? Math.round((p.cashUsd / p.equity) * 100) : 0}% эквити свободно`} />
        <Stat label="В позициях" icon="📂" value={usd(p.inPositions)} sub={`${s.open.length} открытых`} />
        <Stat label="Реализ. P&L" icon="🏦" tone={p.realizedPnlUsd > 0 ? "green" : p.realizedPnlUsd < 0 ? "red" : "slate"} value={<Pnl value={p.realizedPnlUsd} className="text-2xl" />} sub={`оборот ${usd(p.totalInvestedUsd)}`} />
        <Stat label="Нереализ. P&L" icon="📈" tone={unrealTotal > 0 ? "green" : unrealTotal < 0 ? "red" : "slate"} value={<Pnl value={unrealTotal} className="text-2xl" />} sub="по текущим ценам" />
        <Stat label="Win rate" icon="🎯" value={winRate === null ? "—" : `${winRate.toFixed(0)}%`} sub={`W ${wins} · L ${losses} · S ${sold}`} />
      </div>

      {/* Открытые позиции */}
      <Card
        title={`📂 Открытые позиции (${s.open.length})`}
        right={<span className="text-xs text-slate-500">цены обновляются каждый цикл</span>}
      >
        {s.open.length === 0 ? (
          <Empty>Пока нет открытых позиций. Запусти цикл или включи авто-цикл.</Empty>
        ) : (
          <Table
            minWidth={860}
            head={["Рынок", "Исход", "Вход", "Сейчас", "Ставка", "P&L", "Источник", "Открыта"]}
            rows={s.open.map((x) => {
              const now = x.lastPrice ?? x.price;
              const pnl = unreal(x);
              return [
                <div key="m" className="max-w-[320px]">
                  <div className="truncate font-medium text-slate-200" title={x.market}>
                    {x.market}
                  </div>
                  {x.aiDecision?.reason && (
                    <div className="truncate text-[11px] text-slate-500" title={x.aiDecision.reason}>
                      🤖 {x.aiDecision.reason}
                    </div>
                  )}
                </div>,
                <Badge key="o" tone="sky">{x.outcome}</Badge>,
                cents(x.price),
                <span key="n" className={now > x.price ? "text-emerald-400" : now < x.price ? "text-rose-400" : ""}>
                  {cents(now)} {now > x.price ? "↑" : now < x.price ? "↓" : ""}
                </span>,
                usd(x.costUsd),
                <Pnl key="p" value={pnl} pct={roi(x, pnl)} />,
                <div key="s" className="max-w-[180px]">
                  <div className="truncate text-slate-300" title={x.whaleName}>{x.whaleName}</div>
                  <div className="text-[11px] text-slate-500">{sourceLabel(x.source)} · {x.category}</div>
                </div>,
                <span key="t" className="text-slate-500" title={when(x.openedAt)}>{ago(x.openedAt)}</span>,
              ];
            })}
          />
        )}
      </Card>

      {/* Эффективность */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="🐋 Эффективность китов" right={<Link href="/whales" className="text-xs text-indigo-400 hover:underline">Управлять →</Link>}>
          {s.whaleStats.length === 0 ? (
            <p className="text-sm text-slate-500">Пока нет скопированных сделок.</p>
          ) : (
            <Table
              minWidth={480}
              head={["Кит", "Копий", "Откр.", "W/L/S", "P&L", "Нереализ."]}
              rows={s.whaleStats.map((w) => [
                <span key="n" className="font-medium text-slate-200">{w.whaleName}</span>,
                w.copied,
                w.open,
                <span key="wl">
                  <span className="text-emerald-400">{w.wins}</span>/<span className="text-rose-400">{w.losses}</span>/<span className="text-amber-400">{w.sold}</span>
                </span>,
                <Pnl key="p" value={w.pnlUsd} />,
                <Pnl key="u" value={w.unrealizedUsd} />,
              ])}
            />
          )}
        </Card>

        <Card title="🧩 Эффективность стратегий" right={<Link href="/strategies" className="text-xs text-indigo-400 hover:underline">Управлять →</Link>}>
          {Object.keys(s.sourceStats).length === 0 ? (
            <p className="text-sm text-slate-500">Пока нет сделок.</p>
          ) : (
            <Table
              minWidth={480}
              head={["Стратегия", "Откр.", "Закр.", "W/L", "P&L", "Нереализ."]}
              rows={Object.entries(s.sourceStats)
                .sort((a, b) => b[1].pnlUsd - a[1].pnlUsd)
                .map(([id, v]) => [
                  <span key="n" className="font-medium text-slate-200">{sourceLabel(id)}</span>,
                  v.open,
                  v.closed,
                  <span key="wl">
                    <span className="text-emerald-400">{v.wins}</span>/<span className="text-rose-400">{v.losses}</span>
                  </span>,
                  <Pnl key="p" value={v.pnlUsd} />,
                  <Pnl key="u" value={v.unrealizedUsd} />,
                ])}
            />
          )}
        </Card>
      </div>

      {/* Закрытые */}
      <Card
        title={`📁 Закрытые позиции (${s.closed.length})`}
        right={
          <div className="flex gap-1">
            {(["all", "WON", "LOST", "SOLD"] as const).map((f) => (
              <Btn key={f} size="sm" variant={closedFilter === f ? "primary" : "ghost"} onClick={() => setClosedFilter(f)}>
                {f === "all" ? "все" : f}
              </Btn>
            ))}
          </div>
        }
      >
        {closedShown.length === 0 ? (
          <Empty icon="📁">Закрытых позиций нет.</Empty>
        ) : (
          <Table
            minWidth={860}
            head={["Рынок", "Исход", "Вход", "Статус", "Ставка", "P&L", "Причина", "Источник", "Закрыта"]}
            rows={closedShown.map((x) => [
              <div key="m" className="max-w-[300px] truncate text-slate-200" title={x.market}>{x.market}</div>,
              <Badge key="o" tone="sky">{x.outcome}</Badge>,
              cents(x.price),
              <Badge key="s" tone={statusTone(x.status)}>{x.status}</Badge>,
              usd(x.costUsd),
              <Pnl key="p" value={x.profitUsd} pct={roi(x, x.profitUsd ?? 0)} />,
              <span key="r" className="max-w-[160px] truncate text-[11px] text-slate-500" title={x.closeReason ?? ""}>{x.closeReason ?? "—"}</span>,
              <span key="w" className="max-w-[160px] truncate text-slate-400" title={x.whaleName}>{x.whaleName}</span>,
              <span key="t" className="text-slate-500" title={when(x.closedAt)}>{ago(x.closedAt)}</span>,
            ])}
          />
        )}
      </Card>

      {/* Решения ИИ + последний цикл */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="🤖 Последние решения ИИ по копированию">
          {s.aiDecisions.length === 0 ? (
            <p className="text-sm text-slate-500">{s.aiEnabled ? "Решений пока нет." : "ИИ выключен — решения не принимаются."}</p>
          ) : (
            <ul className="max-h-96 divide-y divide-slate-800/70 overflow-auto">
              {s.aiDecisions.slice(0, 20).map((d) => (
                <li key={d.id} className="py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge tone={d.decision === "COPY" ? (d.applied ? "green" : "amber") : "red"}>
                      {d.decision} {Math.round(d.confidence * 100)}%
                    </Badge>
                    <span className="truncate text-slate-200" title={d.market}>{short(d.market, 55)}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-slate-500">{ago(d.createdAt)}</span>
                  </div>
                  <div className="mt-0.5 text-[12px] text-slate-400">
                    {d.whaleName} · {d.outcome} @ {cents(d.price)} · ×{d.sizeMultiplier.toFixed(2)} — {d.reason}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="🧾 Последний цикл"
          right={
            cycle && (
              <Badge tone={cycle.ok ? "green" : "red"}>
                {cycle.ok ? "ok" : "ошибка"} · {cycle.trigger}
              </Badge>
            )
          }
        >
          {!cycle ? (
            <p className="text-sm text-slate-500">Циклов ещё не было.</p>
          ) : (
            <div className="space-y-2 text-sm">
              <div className="flex flex-wrap gap-2">
                <Badge>закрыто {cycle.closed}</Badge>
                <Badge tone="green">открыто {cycle.opened}</Badge>
                <Badge tone="amber">продано {cycle.sold}</Badge>
                <Badge>{when(cycle.finishedAt)}</Badge>
              </div>
              {cycle.error && <p className="text-rose-300">{cycle.error}</p>}
              <details className="group">
                <summary className="cursor-pointer text-xs text-indigo-400 hover:underline">показать журнал цикла ({cycle.notes.length} строк)</summary>
                <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-300">{cycle.notes.join("\n")}</pre>
              </details>
              <Link href="/logs" className="inline-block text-xs text-indigo-400 hover:underline">
                Полный журнал →
              </Link>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
