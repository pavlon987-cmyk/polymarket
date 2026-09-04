"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import type { Settings } from "@/db/schema";
import type { Strategy } from "@/lib/bot/types";
import { api } from "@/lib/format";
import { StrategyEditor } from "./StrategyEditor";
import { Alert, Badge, Btn, Card, Field, Toggle, inputCls, textareaCls } from "./ui";

type S = Settings & { aiApiKeySet: boolean; telegramBotTokenSet: boolean; httpProxyUrlSet: boolean };
type Readiness = { ready: boolean; reasons: string[]; envPresent: { privateKey: boolean; funder: boolean; enabledFlag: boolean } };
type Resp = { settings: S; liveReadiness: Readiness; defaults: { strategy: Strategy; aiPrompt: string } };
type NumKey = { [K in keyof S]-?: S[K] extends number ? K : never }[keyof S];
type StrKey = "dataApiUrl" | "gammaApiUrl" | "clobApiUrl" | "extraHeadersJson" | "aiApiUrl" | "aiModel" | "aiSystemPrompt" | "telegramChatId";
type SecretKey = "aiApiKey" | "telegramBotToken" | "httpProxyUrl";
type AiTest = { loading?: boolean; ok?: boolean; ms?: number; ping?: string; error?: string; decision?: { decision: string; confidence: number; reason: string } };
type Ping = { loading?: boolean; dataApi?: boolean; gammaApi?: boolean; clobApi?: boolean; blockedCount?: number; messages?: string[]; proxy?: boolean; error?: string };

const SECTIONS = [
  { id: "mode", label: "Режим и Live" },
  { id: "bank", label: "Банк и риск" },
  { id: "copy", label: "Копирование" },
  { id: "ai", label: "ИИ" },
  { id: "memory", label: "Память" },
  { id: "net", label: "Сеть" },
  { id: "telegram", label: "Telegram" },
  { id: "verify", label: "Верификация" },
];

const AI_PRESETS = [
  { label: "OpenAI", url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" },
  { label: "OpenRouter", url: "https://openrouter.ai/api/v1/chat/completions", model: "openai/gpt-4o-mini" },
  { label: "DeepSeek", url: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-chat" },
  { label: "Groq", url: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile" },
  { label: "Ollama", url: "http://localhost:11434/v1/chat/completions", model: "llama3.1" },
];

export function SettingsForm() {
  const [s, setS] = useState<S | null>(null);
  const [orig, setOrig] = useState<string>("");
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [defaults, setDefaults] = useState<Resp["defaults"] | null>(null);
  const [secrets, setSecrets] = useState<Record<SecretKey, string>>({ aiApiKey: "", telegramBotToken: "", httpProxyUrl: "" });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [aiTest, setAiTest] = useState<AiTest | null>(null);
  const [ping, setPing] = useState<Ping | null>(null);

  const load = useCallback(
    () =>
      api<Resp>("/api/settings")
        .then((r) => {
          setS(r.settings);
          setOrig(JSON.stringify(r.settings));
          setReadiness(r.liveReadiness);
          setDefaults(r.defaults);
        })
        .catch((e) => setErr(e.message)),
    []
  );
  useEffect(() => {
    load();
  }, [load]);

  if (!s || !defaults) return <div className="py-20 text-center text-slate-500">{err ?? "Загрузка…"}</div>;

  const set = <K extends keyof S>(k: K, v: S[K]) => setS((p) => (p ? { ...p, [k]: v } : p));
  const num = (k: NumKey) => (e: ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value) as S[NumKey]);
  const str = (k: StrKey) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(k, e.target.value);
  const secretsDirty = Object.values(secrets).some(Boolean);
  const dirty = JSON.stringify(s) !== orig || secretsDirty;

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const payload: Record<string, unknown> = { ...s };
      for (const k of ["aiApiKey", "telegramBotToken", "httpProxyUrl"] as SecretKey[]) {
        delete payload[k];
        if (secrets[k]) payload[k] = secrets[k];
      }
      const r = await api<{ settings: S; liveReadiness: Readiness }>("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
      setS(r.settings);
      setOrig(JSON.stringify(r.settings));
      setReadiness(r.liveReadiness);
      setSecrets({ aiApiKey: "", telegramBotToken: "", httpProxyUrl: "" });
      setSaved(new Date().toLocaleTimeString("ru-RU"));
      setTimeout(() => setSaved(null), 3000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const testAi = async () => {
    setAiTest({ loading: true });
    try {
      const r = await api<AiTest>("/api/ai/test", {
        method: "POST",
        body: JSON.stringify({
          aiApiUrl: s.aiApiUrl,
          aiModel: s.aiModel,
          aiApiKey: secrets.aiApiKey && secrets.aiApiKey !== "__clear__" ? secrets.aiApiKey : undefined,
          aiSystemPrompt: s.aiSystemPrompt,
        }),
      });
      setAiTest(r);
    } catch (e) {
      setAiTest({ ok: false, error: (e as Error).message });
    }
  };

  const doPing = async () => {
    setPing({ loading: true });
    try {
      setPing(await api<Ping>("/api/net/ping"));
    } catch (e) {
      setPing({ error: (e as Error).message });
    }
  };

  const numField = (k: NumKey, label: string, hint?: string, step = "any") => (
    <Field label={label} hint={hint}>
      <input type="number" step={step} className={inputCls} value={s[k]} onChange={num(k)} />
    </Field>
  );

  const secretField = (k: SecretKey, label: string, hint: string, placeholder: string, isSet: boolean, masked: string, kind: "password" | "text" = "password") => {
    const clearing = secrets[k] === "__clear__";
    return (
      <Field label={label} hint={clearing ? <span className="text-rose-300">будет очищен при сохранении</span> : hint}>
        <div className="flex gap-1.5">
          <input
            type={kind}
            autoComplete="off"
            className={`${inputCls} ${secrets[k] && !clearing ? "border-indigo-500/60" : ""}`}
            value={clearing ? "" : secrets[k]}
            placeholder={isSet ? `сохранён: ${masked || "••••••"}` : placeholder}
            onChange={(e) => setSecrets({ ...secrets, [k]: e.target.value })}
          />
          {isSet && !clearing && (
            <Btn size="sm" variant="ghost" title="Очистить" onClick={() => setSecrets({ ...secrets, [k]: "__clear__" })}>
              ✕
            </Btn>
          )}
          {clearing && (
            <Btn size="sm" variant="ghost" onClick={() => setSecrets({ ...secrets, [k]: "" })}>
              ↺
            </Btn>
          )}
        </div>
      </Field>
    );
  };

  const check = (ok: boolean, text: string) => (
    <li className={`flex items-center gap-2 ${ok ? "text-emerald-300" : "text-slate-400"}`}>
      <span>{ok ? "✅" : "⬜"}</span>
      {text}
    </li>
  );

  return (
    <div className="space-y-5 pb-24">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">⚙️ Настройки</h1>
          <p className="mt-1 text-sm text-slate-500">Изменения применяются со следующего цикла после сохранения.</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SECTIONS.map((x) => (
            <a key={x.id} href={`#${x.id}`} className="rounded-full border border-slate-800 px-2.5 py-1 text-[11px] text-slate-400 hover:border-slate-600 hover:text-slate-200">
              {x.label}
            </a>
          ))}
        </div>
      </div>

      {err && (
        <Alert tone="red" title="Ошибка" right={<Btn size="sm" variant="ghost" onClick={() => setErr(null)}>✕</Btn>}>
          {err}
        </Alert>
      )}

      {/* ── Режим и Live ── */}
      <Card
        id="mode"
        title="🎛 Режим торговли и Live"
        right={s.tradingMode === "live" ? <Badge tone={readiness?.ready ? "red" : "amber"}>{readiness?.ready ? "🔴 LIVE активен" : "LIVE не активирован"}</Badge> : <Badge tone="sky">📝 PAPER</Badge>}
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <Field label="Режим" hint="paper — виртуальный банк; live — реальные ордера (нужны все предохранители)">
              <select className={inputCls} value={s.tradingMode} onChange={(e) => set("tradingMode", e.target.value)}>
                <option value="paper">Paper (бумажная торговля)</option>
                <option value="live">Live (реальные деньги)</option>
              </select>
            </Field>
            <Toggle
              checked={s.liveArmed}
              disabled={s.tradingMode !== "live"}
              onChange={(v) => set("liveArmed", v)}
              label="Разрешить реальные сделки"
              hint="последний программный предохранитель; сбрасывается при переходе в paper"
            />
            {numField("liveMaxBankUsd", "Лимит банка для live, $", "стартовый банк live-портфеля; бот не разгонит оборот выше ×3 от него")}
            <Toggle checked={s.autorun} onChange={(v) => set("autorun", v)} label="Автозапуск авто-цикла при старте сервера" hint="то же, что кнопка «Старт авто-цикл» на дашборде" />
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-sm">
            <div className="mb-2 font-semibold text-slate-200">Чек-лист Live</div>
            <ul className="space-y-1">
              {check(s.tradingMode === "live", "Режим = Live (сохранено)")}
              {check(s.liveArmed, "Тумблер «Разрешить реальные сделки»")}
              {check(Boolean(readiness?.envPresent.enabledFlag), "LIVE_TRADING_ENABLED=true в .env")}
              {check(Boolean(readiness?.envPresent.privateKey), "POLYMARKET_PRIVATE_KEY в .env")}
              {check(Boolean(readiness?.envPresent.funder), "POLYMARKET_FUNDER_ADDRESS в .env (proxy-кошелёк с USDC)")}
            </ul>
            <p className="mt-3 text-[11px] text-slate-500">
              Переменные .env читаются при старте сервера — после правки перезапусти <code>npm run dev</code>. Пока хоть один пункт не выполнен, бот работает как paper и пишет об этом в журнал.
            </p>
          </div>
        </div>
      </Card>

      {/* ── Банк и риск ── */}
      <Card id="bank" title="💰 Банк, риск и расписание">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {numField("paperStartingBankUsd", "Стартовый банк paper, $", "применяется при сбросе портфеля")}
          {numField("stopLossPercent", "Стоп-лосс портфеля, доля", "0.2 = остановиться при −20% эквити")}
          {numField("maxOpenPositions", "Макс. открытых позиций", "суммарно по всем стратегиям", "1")}
          {numField("checkIntervalSec", "Интервал цикла, сек", "минимум 30", "1")}
          {numField("requestDelayMs", "Пауза между запросами к API, мс", "защита от rate-limit", "1")}
          {numField("minHoursToEnd", "Мин. часов до окончания", "слишком близкие рынки (< N ч) пропускаем", "1")}
          <div className="sm:col-span-2 lg:col-span-2">
            <Field label="Макс. дней до окончания рынка" hint="рынки дольше указанного срока отсекаются (деньги не зависают надолго)">
              <div className="space-y-2">
                <input type="number" step="1" className={inputCls} value={s.maxDaysToEnd} onChange={num("maxDaysToEnd")} />
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-slate-500">Быстрый фильтр:</span>
                  {[
                    { label: "⚡ 1 день", val: 1 },
                    { label: "⏳ 2 дня", val: 2 },
                    { label: "📅 3 дня", val: 3 },
                    { label: "🗓️ 4 дня", val: 4 },
                    { label: "📆 7 дней", val: 7 },
                    { label: "30 дней", val: 30 },
                  ].map((p) => (
                    <button
                      key={p.val}
                      type="button"
                      onClick={() => set("maxDaysToEnd", p.val)}
                      className={`rounded-full border px-2.5 py-0.5 transition ${
                        s.maxDaysToEnd === p.val
                          ? "border-indigo-500 bg-indigo-600/30 text-white font-medium"
                          : "border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </Field>
          </div>
        </div>
      </Card>

      {/* ── Копирование ── */}
      <Card id="copy" title="🐋 Стратегия копирования по умолчанию" right={<Link href="/whales" className="text-xs text-indigo-400 hover:underline">Переопределить для кита →</Link>}>
        <p className="mb-3 text-xs text-slate-400">Эти значения действуют для всех китов, у которых поле не переопределено на странице «Киты».</p>
        <StrategyEditor
          mode="defaults"
          value={s.defaultStrategy ?? {}}
          defaults={{ ...defaults.strategy, ...(s.defaultStrategy ?? {}) }}
          onChange={(v) => set("defaultStrategy", { ...defaults.strategy, ...v } as Strategy)}
        />
        <div className="mt-3">
          <Btn size="sm" variant="ghost" onClick={() => set("defaultStrategy", defaults.strategy)}>
            сбросить к заводским
          </Btn>
        </div>
      </Card>

      {/* ── ИИ ── */}
      <Card id="ai" title="🤖 ИИ (любой OpenAI-совместимый API)" right={<Toggle checked={s.aiEnabled} onChange={(v) => set("aiEnabled", v)} label={s.aiEnabled ? "включён" : "выключен"} />}>
        <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-slate-500">Пресеты:</span>
          {AI_PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => {
                set("aiApiUrl", p.url);
                set("aiModel", p.model);
              }}
              className="rounded-full border border-slate-700 px-2.5 py-0.5 text-slate-300 hover:border-indigo-500/60 hover:text-white"
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="URL API" hint="можно базу (…/v1) или полный путь до chat/completions" className="sm:col-span-2">
            <input className={inputCls} value={s.aiApiUrl} onChange={str("aiApiUrl")} />
          </Field>
          <Field label="Модель">
            <input className={inputCls} value={s.aiModel} onChange={str("aiModel")} placeholder="gpt-4o-mini" />
          </Field>
          {secretField("aiApiKey", "API-ключ", "для Ollama можно пусто", "sk-…", s.aiApiKeySet, s.aiApiKey)}
          {numField("aiTemperature", "Температура", "0.1–0.3 для решений")}
          {numField("aiMinConfidence", "Мин. уверенность для COPY", "0.6 = 60%")}
          {numField("aiTimeoutMs", "Таймаут, мс", "", "1")}
          <div className="flex items-end">
            <Btn variant="primary" onClick={testAi} loading={aiTest?.loading} className="w-full">
              🔌 Проверить подключение
            </Btn>
          </div>
        </div>
        {aiTest && !aiTest.loading && (
          <div className={`mt-3 rounded-xl border p-3 text-sm ${aiTest.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-rose-500/30 bg-rose-500/10 text-rose-200"}`}>
            {aiTest.ok ? (
              <>
                <div className="font-semibold">✅ Работает · {aiTest.ms} мс</div>
                <div className="mt-1 text-xs opacity-90">Пинг: «{aiTest.ping}»</div>
                {aiTest.decision && (
                  <div className="mt-1 text-xs opacity-90">
                    Тестовое решение: <b>{aiTest.decision.decision}</b> ({Math.round(aiTest.decision.confidence * 100)}%) — {aiTest.decision.reason}
                  </div>
                )}
              </>
            ) : (
              <div>❌ {aiTest.error}</div>
            )}
          </div>
        )}
        <Field label="Системный промт для решений по копированию" hint="память Васи и дополнение по киту подмешиваются автоматически" className="mt-3">
          <textarea className={`${textareaCls} min-h-40`} value={s.aiSystemPrompt} onChange={str("aiSystemPrompt")} />
        </Field>
        <Btn size="sm" variant="ghost" className="mt-2" onClick={() => set("aiSystemPrompt", defaults.aiPrompt)}>
          вернуть промт по умолчанию
        </Btn>
      </Card>

      {/* ── Память ── */}
      <Card id="memory" title="🧠 Память и обучение Васи" right={<Toggle checked={s.aiMemoryEnabled} onChange={(v) => set("aiMemoryEnabled", v)} label={s.aiMemoryEnabled ? "включена" : "выключена"} />}>
        <p className="mb-3 text-xs text-slate-400">
          Вася разбирает каждую закрытую сделку (урок), изучает сделки китов (куда/зачем/на что), помнит результаты стратегий и ваши указания. Когда уроков накапливается много — сжимает их в принципы. Всё это он читает перед каждым решением. Требует включённого ИИ.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Toggle checked={s.aiReflectEnabled} onChange={(v) => set("aiReflectEnabled", v)} label="Разбирать закрытые сделки" hint="1 запрос к ИИ на каждую закрытую позицию" />
          <Toggle checked={s.aiObserveWhales} onChange={(v) => set("aiObserveWhales", v)} label="Изучать сделки китов" hint="1 запрос на кита при новых сделках" />
          {numField("aiMemoryMaxItems", "Консолидация после N записей", "уроки → принципы", "1")}
        </div>
        <Link href="/memory" className="mt-3 inline-block text-xs text-indigo-400 hover:underline">
          Посмотреть, что Вася запомнил →
        </Link>
      </Card>

      {/* ── Стратегии (ссылка) ── */}
      <Card title="🧩 Стратегии">
        <p className="text-sm text-slate-400">
          Арбитраж Yes+No, крипто-порог, фаворит на финише, импульс, контртренд, консенсус китов, аутсайдеры, свободное плавание и авто-разведка кошельков — на отдельной странице, у каждой своя кнопка, бюджет и параметры.{" "}
          <Link href="/strategies" className="text-indigo-400 underline">
            Открыть стратегии →
          </Link>
        </p>
      </Card>

      {/* ── Сеть ── */}
      <Card id="net" title="🌐 Сеть и доступ к Polymarket" right={<Btn size="sm" onClick={doPing} loading={ping?.loading}>📡 Проверить доступ</Btn>}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Data API">
            <input className={inputCls} value={s.dataApiUrl} onChange={str("dataApiUrl")} />
          </Field>
          <Field label="Gamma API">
            <input className={inputCls} value={s.gammaApiUrl} onChange={str("gammaApiUrl")} />
          </Field>
          <Field label="CLOB API">
            <input className={inputCls} value={s.clobApiUrl} onChange={str("clobApiUrl")} />
          </Field>
          {secretField("httpProxyUrl", "HTTP(S)-прокси", "если API отвечают 401/403 (гео-блок): http://user:pass@host:port", "http://user:pass@host:port", s.httpProxyUrlSet, s.httpProxyUrl, "text")}
          <Field label="Доп. заголовки (JSON)" hint='например {"CF-Access-Client-Id":"…"}' className="sm:col-span-2">
            <input className={`${inputCls} font-mono text-xs`} value={s.extraHeadersJson} onChange={str("extraHeadersJson")} placeholder='{"Header":"value"}' />
          </Field>
        </div>
        {ping && !ping.loading && (
          <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-sm">
            {ping.error ? (
              <span className="text-rose-300">❌ {ping.error}</span>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  <Badge tone={ping.dataApi ? "green" : "red"}>data-api {ping.dataApi ? "✓" : "✗"}</Badge>
                  <Badge tone={ping.gammaApi ? "green" : "red"}>gamma-api {ping.gammaApi ? "✓" : "✗"}</Badge>
                  <Badge tone={ping.clobApi ? "green" : "red"}>clob {ping.clobApi ? "✓" : "✗"}</Badge>
                  {ping.proxy && <Badge tone="indigo">через прокси</Badge>}
                  {Boolean(ping.blockedCount) && <Badge tone="amber">блокировок: {ping.blockedCount}</Badge>}
                </div>
                {ping.messages?.length ? <pre className="mt-2 max-h-40 overflow-auto font-mono text-[11px] text-slate-400">{ping.messages.join("\n")}</pre> : null}
                <p className="mt-2 text-[11px] text-slate-500">Проверяются сохранённые настройки — сначала сохрани, потом проверяй.</p>
              </>
            )}
          </div>
        )}
      </Card>

      {/* ── Telegram ── */}
      <Card id="telegram" title="✈️ Telegram-уведомления" right={<Badge tone={s.telegramBotTokenSet && s.telegramChatId ? "green" : "slate"}>{s.telegramBotTokenSet && s.telegramChatId ? "настроен" : "выкл"}</Badge>}>
        <div className="grid gap-3 sm:grid-cols-2">
          {secretField("telegramBotToken", "Токен бота", "получить у @BotFather", "123456:ABC-DEF…", s.telegramBotTokenSet, "")}
          <Field label="Chat ID" hint="ваш id или id группы (узнать у @userinfobot)">
            <input className={inputCls} value={s.telegramChatId} onChange={str("telegramChatId")} placeholder="123456789" />
          </Field>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">Уведомления: новые позиции, закрытия с P&L, хеджи, стоп-лосс портфеля.</p>
      </Card>

      {/* ── Верификация ── */}
      <Card id="verify" title="🔎 Верификация кошельков (для авто-разведки и ручной проверки)">
        <p className="mb-3 text-xs text-slate-400">
          Пороги, по которым кошелёк считается «верифицированным». Data-API не отдаёт итог сделок, поэтому «доля умных покупок» — эвристика (недорогие исходы с заметным размером), а не реальный win rate.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {numField("walletMinScore", "Мин. score (0–100)")}
          {numField("walletMinTrades", "Мин. сделок", "", "1")}
          {numField("walletMinWinRate", "Мин. доля умных покупок", "0.5 = 50%")}
          {numField("walletMinVolumeUsd", "Мин. объём, $")}
          {numField("walletMaxDrawdownPct", "Макс. drawdown, доля", "0.3 = 30%")}
        </div>
      </Card>

      {/* ── Панель сохранения ── */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-800 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="text-sm">
            {dirty ? <span className="text-amber-300">● Есть несохранённые изменения</span> : saved ? <span className="text-emerald-300">✓ Сохранено в {saved}</span> : <span className="text-slate-500">Всё сохранено</span>}
          </div>
          <div className="flex gap-2">
            <Btn variant="ghost" onClick={load} disabled={!dirty || saving}>
              отменить
            </Btn>
            <Btn variant="primary" onClick={save} loading={saving} disabled={!dirty}>
              💾 Сохранить
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}
