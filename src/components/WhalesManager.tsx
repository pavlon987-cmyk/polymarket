"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Strategy } from "@/lib/bot/types";
import { ago, api, cents, usd, when } from "@/lib/format";
import { StrategyEditor } from "./StrategyEditor";
import { Alert, Badge, Btn, Card, Empty, Field, Table, Toggle, inputCls, textareaCls } from "./ui";

type Whale = { id: number; address: string; name: string; category: string; enabled: boolean; strategy: Partial<Strategy>; notes: string; createdAt: string; updatedAt: string };
type Check = {
  count: number;
  lastTradeAt: string | null;
  lastTradeAgeMin: number | null;
  volumeUsd: number;
  avgBuyPrice: number | null;
  recent: { side: string; title: string; outcome: string; price: number; usd: number; at: string }[];
  messages: string[];
};
type Candidate = { address: string; name: string; trades: number; volumeUsd: number; markets: string[]; buyRatio: number; avgPrice: number };
type Score = { address: string; name: string; score: number; totalTrades: number; winRate: number; totalVolumeUsd: number; avgPrice: number; maxDrawdownPct: number; verified: boolean; category: string; notes: string[] };
type VerifiedRow = { id: number; address: string; name: string; score: number; totalTrades: number; winRate: number; totalVolumeUsd: number; avgPrice: number; verified: boolean; category: string; notes: string; updatedAt: string };

const CATEGORIES = ["LoL", "CS2", "Dota 2", "Valorant", "Tennis", "Football", "Basketball", "MMA", "Crypto", "Politics", "Economy", "Other"];
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const short = (s: string, n = 50) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const emptyForm = { address: "", name: "", category: "Other", notes: "" };

export function WhalesManager() {
  const [whales, setWhales] = useState<Whale[] | null>(null);
  const [defaults, setDefaults] = useState<Strategy | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; draft: Pick<Whale, "name" | "category" | "notes" | "strategy"> } | null>(null);
  const [checks, setChecks] = useState<Record<number, Check | "loading">>({});
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [scores, setScores] = useState<Record<string, Score | "loading">>({});
  const [verified, setVerified] = useState<VerifiedRow[] | null>(null);
  const [tab, setTab] = useState<"discover" | "verified">("discover");
  const [verifyAddr, setVerifyAddr] = useState("");

  const load = useCallback(async () => {
    try {
      const [w, st] = await Promise.all([
        api<{ whales: Whale[] }>("/api/whales"),
        api<{ settings: { defaultStrategy: Partial<Strategy> }; defaults: { strategy: Strategy } }>("/api/settings"),
      ]);
      setWhales(w.whales);
      setDefaults({ ...st.defaults.strategy, ...(st.settings.defaultStrategy ?? {}) });
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const known = new Set((whales ?? []).map((w) => w.address.toLowerCase()));

  // ── действия ───────────────────────────────────────────────────────────

  const add = async (data = form, enabled = true) => {
    setAdding(true);
    setErr(null);
    try {
      await api("/api/whales", { method: "POST", body: JSON.stringify({ ...data, enabled }) });
      setForm(emptyForm);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setAdding(false);
    }
  };
  const patch = async (id: number, body: Partial<Whale>) => {
    try {
      await api(`/api/whales/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const remove = async (w: Whale) => {
    if (!confirm(`Удалить кита «${w.name}»? Его позиции останутся в истории.`)) return;
    await api(`/api/whales/${w.id}`, { method: "DELETE" });
    await load();
  };
  const check = async (id: number) => {
    setChecks((c) => ({ ...c, [id]: "loading" }));
    try {
      setChecks((c) => ({ ...c, [id]: undefined as unknown as Check }));
      const r = await api<Check>(`/api/whales/${id}`);
      setChecks((c) => ({ ...c, [id]: r }));
    } catch (e) {
      setChecks((c) => ({ ...c, [id]: { count: 0, lastTradeAt: null, lastTradeAgeMin: null, volumeUsd: 0, avgBuyPrice: null, recent: [], messages: [(e as Error).message] } }));
    }
  };
  const discover = async () => {
    setDiscovering(true);
    try {
      const r = await api<{ candidates: Candidate[]; messages: string[] }>("/api/whales/discover?limit=500");
      setCands(r.candidates ?? []);
      if (r.messages?.length && !r.candidates?.length) setErr(Array.isArray(r.messages) ? r.messages.join("; ") : String(r.messages));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDiscovering(false);
    }
  };
  const verify = async (address: string) => {
    const a = address.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(a)) {
      setErr("Неверный адрес (ожидается 0x + 40 hex)");
      return;
    }
    setScores((s) => ({ ...s, [a]: "loading" }));
    try {
      const r = await api<{ score: Score }>("/api/whales/verify", { method: "POST", body: JSON.stringify({ address: a }) });
      setScores((s) => ({ ...s, [a]: r.score }));
      if (tab === "verified") loadVerified();
    } catch (e) {
      setErr((e as Error).message);
      setScores((s) => {
        const n = { ...s };
        delete n[a];
        return n;
      });
    }
  };
  const loadVerified = () => api<{ wallets: VerifiedRow[] }>("/api/whales/verify").then((r) => setVerified(r.wallets)).catch(() => setVerified([]));
  useEffect(() => {
    if (tab === "verified" && verified === null) loadVerified();
  }, [tab, verified]);

  const copy = (t: string) => navigator.clipboard?.writeText(t).catch(() => {});

  if (!whales || !defaults) return <div className="py-20 text-center text-slate-500">{err ?? "Загрузка…"}</div>;

  const enabledN = whales.filter((w) => w.enabled).length;

  const scoreBadge = (sc: Score | "loading" | undefined) => {
    if (!sc) return null;
    if (sc === "loading") return <Badge tone="slate">проверяю…</Badge>;
    const notesStr = Array.isArray(sc.notes) ? sc.notes.join("\n") : (sc.notes ? String(sc.notes) : "");
    return (
      <Badge tone={sc.verified ? "green" : sc.score >= 40 ? "amber" : "red"} title={notesStr}>
        {sc.verified ? "✅" : "❌"} score {sc.score} · {sc.category}
      </Badge>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">🐋 Киты</h1>
          <p className="mt-1 text-sm text-slate-500">
            Активно {enabledN}/{whales.length}. Нужен <b>proxy-кошелёк</b> трейдера (адрес из URL профиля polymarket.com/profile/0x…). Глобальные правила копирования —{" "}
            <Link href="/settings#copy" className="text-indigo-400 hover:underline">
              в настройках
            </Link>
            .
          </p>
        </div>
        <Btn size="sm" onClick={load}>
          ↻ обновить
        </Btn>
      </div>

      {err && (
        <Alert tone="red" title="Ошибка" right={<Btn size="sm" variant="ghost" onClick={() => setErr(null)}>✕</Btn>}>
          {err}
        </Alert>
      )}

      {/* Добавить */}
      <Card title="➕ Добавить кита">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Адрес (0x…)" className="lg:col-span-2">
            <input className={`${inputCls} font-mono text-xs`} value={form.address} placeholder="0x3506e2cefc634ce4c0d0d88d82e7332a81ddca56" onChange={(e) => setForm({ ...form, address: e.target.value.trim() })} />
          </Field>
          <Field label="Имя">
            <input className={inputCls} value={form.name} placeholder="🎾 Tennis Sharp" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Категория" hint="используется для лимита экспозиции">
            <input list="whale-cats" className={inputCls} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            <datalist id="whale-cats">
              {CATEGORIES.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
          <div className="flex items-end gap-2">
            <Btn variant="primary" className="flex-1" onClick={() => add()} loading={adding} disabled={!/^0x[a-fA-F0-9]{40}$/.test(form.address)}>
              Добавить
            </Btn>
            <Btn variant="ghost" onClick={() => verify(form.address)} disabled={!/^0x[a-fA-F0-9]{40}$/.test(form.address)} title="Оценить кошелёк перед добавлением">
              🔍
            </Btn>
          </div>
          <Field label="Заметки (видит ИИ)" className="sm:col-span-2 lg:col-span-5">
            <input className={inputCls} value={form.notes} placeholder="специализация, стиль, особенности…" onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Field>
        </div>
        {form.address && scores[form.address.toLowerCase()] && <div className="mt-2">{scoreBadge(scores[form.address.toLowerCase()])}</div>}
      </Card>

      {/* Список */}
      {whales.length === 0 ? (
        <Empty icon="🐋">Китов нет. Добавь вручную или найди через поиск ниже.</Empty>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {whales.map((w) => {
            const chk = checks[w.id];
            const isEdit = editing?.id === w.id;
            const overrides = Object.keys(w.strategy ?? {}).length;
            return (
              <Card
                key={w.id}
                className={w.enabled ? "border-emerald-500/25" : "opacity-80"}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-base">{w.name}</span>
                    <Badge tone="sky">{w.category}</Badge>
                    {overrides > 0 && <Badge tone="indigo" title="переопределений стратегии">⚙ {overrides}</Badge>}
                    {w.name.startsWith("🔎") && <Badge tone="violet">авто-разведка</Badge>}
                  </span>
                }
                right={<Toggle checked={w.enabled} onChange={(v) => patch(w.id, { enabled: v })} label={w.enabled ? "копируем" : "пауза"} />}
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <code className="rounded bg-slate-950/70 px-2 py-0.5 font-mono text-slate-400" title={w.address}>
                    {shortAddr(w.address)}
                  </code>
                  <button className="text-slate-500 hover:text-slate-200" onClick={() => copy(w.address)} title="Скопировать адрес">
                    ⧉
                  </button>
                  <a href={`https://polymarket.com/profile/${w.address}`} target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline">
                    профиль ↗
                  </a>
                  <span className="text-slate-600">· добавлен {ago(w.createdAt)}</span>
                </div>
                {w.notes && <p className="mt-2 text-sm text-slate-400">{w.notes}</p>}

                <div className="mt-3 flex flex-wrap gap-2">
                  <Btn size="sm" onClick={() => check(w.id)} loading={chk === "loading"}>
                    📡 Проверить активность
                  </Btn>
                  <Btn size="sm" variant={isEdit ? "primary" : "default"} onClick={() => (isEdit ? setEditing(null) : setEditing({ id: w.id, draft: { name: w.name, category: w.category, notes: w.notes, strategy: w.strategy ?? {} } }))}>
                    ⚙ {isEdit ? "Закрыть" : "Настроить"}
                  </Btn>
                  <Btn size="sm" variant="ghost" onClick={() => verify(w.address)}>
                    🔍 Оценить
                  </Btn>
                  {scoreBadge(scores[w.address.toLowerCase()])}
                  <Btn size="sm" variant="danger" className="ml-auto" onClick={() => remove(w)}>
                    удалить
                  </Btn>
                </div>

                {chk && chk !== "loading" && (
                  <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-xs">
                    {chk.count === 0 ? (
                      <div className="text-amber-300">
                        ❌ Сделок не найдено. Проверь адрес (нужен proxy-кошелёк) или доступ к API.
                        {Array.isArray(chk.messages) && chk.messages.length > 0 && <pre className="mt-1 whitespace-pre-wrap text-slate-500">{chk.messages.join("\n")}</pre>}
                      </div>
                    ) : (
                      <>
                        <div className="flex flex-wrap gap-2">
                          <Badge tone="green">✅ {chk.count} сделок</Badge>
                          <Badge tone={chk.lastTradeAgeMin !== null && chk.lastTradeAgeMin < 180 ? "green" : "amber"}>последняя {ago(chk.lastTradeAt)}</Badge>
                          <Badge>объём {usd(chk.volumeUsd)}</Badge>
                          {chk.avgBuyPrice !== null && <Badge>ср. цена покупки {cents(chk.avgBuyPrice)}</Badge>}
                        </div>
                        <ul className="mt-2 divide-y divide-slate-800/60">
                          {chk.recent.map((t, i) => (
                            <li key={i} className="flex items-center gap-2 py-1">
                              <Badge tone={t.side === "BUY" ? "green" : "red"} className="w-12 justify-center">
                                {t.side}
                              </Badge>
                              <span className="truncate text-slate-300" title={t.title}>
                                {short(t.title, 48)}
                              </span>
                              <span className="ml-auto shrink-0 text-slate-400">
                                {t.outcome} @ {cents(t.price)} · {usd(t.usd)}
                              </span>
                              <span className="shrink-0 text-slate-600" title={when(t.at)}>
                                {ago(t.at)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}

                {isEdit && editing && (
                  <div className="mt-3 space-y-3 rounded-xl border border-indigo-500/20 bg-slate-950/50 p-3">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Field label="Имя">
                        <input className={inputCls} value={editing.draft.name} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, name: e.target.value } })} />
                      </Field>
                      <Field label="Категория">
                        <input list="whale-cats" className={inputCls} value={editing.draft.category} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, category: e.target.value } })} />
                      </Field>
                      <Field label="Заметки (видит ИИ)" className="sm:col-span-3">
                        <textarea className={`${textareaCls} min-h-16 font-sans text-sm`} value={editing.draft.notes} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, notes: e.target.value } })} />
                      </Field>
                    </div>
                    <div>
                      <div className="mb-2 text-xs font-semibold text-slate-300">Персональная стратегия — пустые поля берутся из глобальных настроек</div>
                      <StrategyEditor mode="override" value={editing.draft.strategy} defaults={defaults} onChange={(v) => setEditing({ ...editing, draft: { ...editing.draft, strategy: v } })} />
                    </div>
                    <div className="flex gap-2">
                      <Btn
                        variant="primary"
                        onClick={async () => {
                          await patch(w.id, editing.draft);
                          setEditing(null);
                        }}
                      >
                        💾 Сохранить
                      </Btn>
                      <Btn variant="ghost" onClick={() => setEditing(null)}>
                        отмена
                      </Btn>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Поиск / верифицированные */}
      <Card
        title={
          <span className="flex gap-1">
            <Btn size="sm" variant={tab === "discover" ? "primary" : "ghost"} onClick={() => setTab("discover")}>
              🔭 Поиск активных трейдеров
            </Btn>
            <Btn size="sm" variant={tab === "verified" ? "primary" : "ghost"} onClick={() => setTab("verified")}>
              ✅ Верифицированные кошельки
            </Btn>
          </span>
        }
        right={
          tab === "discover" ? (
            <Btn size="sm" variant="primary" onClick={discover} loading={discovering}>
              🔎 Найти (последние 500 сделок биржи)
            </Btn>
          ) : (
            <div className="flex gap-1.5">
              <input className={`${inputCls} w-72 font-mono text-xs`} placeholder="0x… — проверить любой адрес" value={verifyAddr} onChange={(e) => setVerifyAddr(e.target.value)} onKeyDown={(e) => e.key === "Enter" && verify(verifyAddr)} />
              <Btn size="sm" onClick={() => verify(verifyAddr)} disabled={!verifyAddr}>
                проверить
              </Btn>
            </div>
          )
        }
      >
        {tab === "discover" ? (
          cands === null ? (
            <p className="text-sm text-slate-500">Нажми «Найти» — соберём самых объёмных трейдеров из последних сделок на бирже. Это кандидаты, а не гарантия прибыльности: проверь их кнопкой 🔍.</p>
          ) : cands.length === 0 ? (
            <Empty icon="🔭">Кандидатов нет — возможно, API недоступен (см. Настройки → Сеть).</Empty>
          ) : (
            <Table
              minWidth={900}
              head={["Трейдер", "Адрес", "Сделок", "Объём", "BUY %", "Ср. цена", "Примеры рынков", "Оценка", ""]}
              rows={cands.map((c) => {
                const isKnown = known.has(c.address.toLowerCase());
                return [
                  <span key="n" className="font-medium text-slate-200">{c.name || "—"}</span>,
                  <span key="a" className="flex items-center gap-1 font-mono text-xs text-slate-400">
                    {shortAddr(c.address)}
                    <button onClick={() => copy(c.address)} className="text-slate-600 hover:text-slate-200">⧉</button>
                  </span>,
                  c.trades,
                  usd(c.volumeUsd),
                  `${Math.round(c.buyRatio * 100)}%`,
                  cents(c.avgPrice),
                  <span key="m" className="block max-w-[260px] truncate text-xs text-slate-400" title={(c.markets ?? []).join("\n")}>
                    {(c.markets ?? []).join(" · ")}
                  </span>,
                  <span key="s">
                    {scores[c.address.toLowerCase()] ? scoreBadge(scores[c.address.toLowerCase()]) : <Btn size="sm" variant="ghost" onClick={() => verify(c.address)}>🔍</Btn>}
                  </span>,
                  isKnown ? (
                    <Badge key="k" tone="green">уже добавлен</Badge>
                  ) : (
                    <Btn key="add" size="sm" onClick={() => add({ address: c.address, name: c.name || `Trader ${c.address.slice(0, 8)}`, category: "Other", notes: `из поиска: ${c.trades} сделок, объём ${usd(c.volumeUsd)}` }, false)} disabled={adding} title="Добавится выключенным — включи после проверки">
                      ➕ добавить
                    </Btn>
                  ),
                ];
              })}
            />
          )
        ) : verified === null ? (
          <p className="text-sm text-slate-500">Загрузка…</p>
        ) : verified.length === 0 ? (
          <Empty icon="✅">Пока никто не проверен. Верификация выполняется авто-разведкой (страница «Стратегии») или кнопкой 🔍.</Empty>
        ) : (
          <Table
            minWidth={900}
            head={["Кошелёк", "Score", "Сделок", "Умных покупок", "Объём", "Ср. цена", "Стиль", "Заметки", ""]}
            rows={verified.map((v) => {
              const isKnown = known.has(v.address.toLowerCase());
              return [
                <div key="n">
                  <div className="font-medium text-slate-200">{v.name || "—"}</div>
                  <div className="font-mono text-[11px] text-slate-500">{shortAddr(v.address)}</div>
                </div>,
                <Badge key="s" tone={v.verified ? "green" : v.score >= 40 ? "amber" : "red"}>{v.verified ? "✅" : "❌"} {Math.round(v.score)}</Badge>,
                v.totalTrades,
                `${Math.round(v.winRate * 100)}%`,
                usd(v.totalVolumeUsd),
                cents(v.avgPrice),
                v.category,
                <span key="no" className="block max-w-[260px] truncate text-xs text-slate-400" title={v.notes}>{v.notes}</span>,
                isKnown ? (
                  <Badge key="k" tone="green">в китах</Badge>
                ) : (
                  <Btn key="add" size="sm" onClick={() => add({ address: v.address, name: v.name || `Trader ${v.address.slice(0, 8)}`, category: v.category, notes: `verified: score ${Math.round(v.score)}` }, false)} disabled={adding}>
                    ➕ добавить
                  </Btn>
                ),
              ];
            })}
          />
        )}
      </Card>
    </div>
  );
}
