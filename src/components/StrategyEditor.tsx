"use client";

import type { ReactNode } from "react";
import type { Strategy } from "@/lib/bot/types";
import { Badge, Btn, Field, Toggle, inputCls, textareaCls } from "./ui";

type SizingMode = Strategy["sizingMode"];
type NumKey = { [K in keyof Strategy]: Strategy[K] extends number | null ? K : never }[keyof Strategy];
type BoolKey = "copySells" | "useAi";
type StrKey = "allowedKeywords" | "blockedKeywords" | "aiPromptExtra";

type NumField = { key: NumKey; label: string; hint?: string; nullable?: boolean; showFor?: SizingMode[] };

const SIZING: { id: SizingMode; label: string; hint: string }[] = [
  { id: "kelly", label: "Келли (дробный)", hint: "размер по формуле Келли от цены и предполагаемого преимущества" },
  { id: "fixed", label: "Фиксированная сумма", hint: "каждая ставка — одинаковая сумма в $" },
  { id: "percent", label: "Процент от кэша", hint: "ставка = доля свободного кэша" },
  { id: "proportional", label: "Пропорционально киту", hint: "ставка = коэффициент × размер сделки кита" },
];

const SIZING_FIELDS: NumField[] = [
  { key: "fixedBetUsd", label: "Фикс. ставка, $", showFor: ["fixed"] },
  { key: "betPct", label: "Доля кэша на ставку", hint: "0.05 = 5%", showFor: ["percent"] },
  { key: "proportionalRatio", label: "Коэффициент к сделке кита", hint: "0.01 = 1% от суммы кита", showFor: ["proportional"] },
  { key: "assumedEdge", label: "Предполагаемое преимущество", hint: "добавка к вероятности, 0.05 = +5 п.п.", showFor: ["kelly"] },
  { key: "kellyMultiplier", label: "Множитель Келли", hint: "0.25 = четверть Келли (консервативно)", showFor: ["kelly"] },
  { key: "minBetPct", label: "Мин. доля кэша", hint: "нижняя граница ставки", showFor: ["kelly"] },
  { key: "maxBetPct", label: "Макс. доля кэша", hint: "верхняя граница ставки", showFor: ["kelly"] },
  { key: "maxBetUsd", label: "Потолок ставки, $", hint: "не больше этой суммы никогда" },
];

const FILTER_FIELDS: NumField[] = [
  { key: "minEntryPrice", label: "Мин. цена входа", hint: "0.10 = 10¢" },
  { key: "maxEntryPrice", label: "Макс. цена входа", hint: "0.55 = 55¢" },
  { key: "minVolumeUsd", label: "Мин. объём рынка, $" },
  { key: "maxTradeAgeMin", label: "Макс. возраст сделки, мин", hint: "старше — не копируем" },
  { key: "minWhaleTradeUsd", label: "Мин. сумма сделки кита, $", hint: "0 = любая" },
  { key: "maxCopiesPerCycle", label: "Макс. копий за цикл" },
  { key: "maxPositionsPerWhale", label: "Макс. позиций на кита" },
  { key: "maxCategoryExposure", label: "Лимит категории, доля банка", hint: "0.3 = 30% стартового банка" },
];

const EXIT_FIELDS: NumField[] = [
  { key: "takeProfitPrice", label: "Take-profit по цене", hint: "продать, когда цена ≥ (0.9 = 90¢)", nullable: true },
  { key: "stopLossPrice", label: "Stop-loss по цене", hint: "продать, когда цена ≤ (0.2 = 20¢)", nullable: true },
];

type Props = {
  value: Partial<Strategy>;
  onChange: (v: Partial<Strategy>) => void;
  /** полные значения по умолчанию (для плейсхолдеров и итога) */
  defaults: Strategy;
  /** defaults — редактируем глобальные значения; override — переопределения для кита (пусто = по умолчанию) */
  mode?: "defaults" | "override";
};

export function StrategyEditor({ value, onChange, defaults, mode = "defaults" }: Props) {
  const override = mode === "override";

  const eff: Strategy = { ...defaults };
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || v === "") continue;
    if (v === null && k !== "takeProfitPrice" && k !== "stopLossPrice") continue;
    (eff as unknown as Record<string, unknown>)[k] = v;
  }

  function setKey<K extends keyof Strategy>(k: K, v: Strategy[K] | undefined) {
    const next: Record<string, unknown> = { ...value };
    if (v === undefined) delete next[k];
    else next[k] = v;
    onChange(next as Partial<Strategy>);
  }

  const cents = (p: number | null) => (p === null ? "выкл" : `${Math.round(p * 100)}¢`);
  const overrides = Object.keys(value).filter((k) => value[k as keyof Strategy] !== undefined);

  // ── рендеры полей ──────────────────────────────────────────────────────

  const renderNum = (f: NumField) => {
    const raw = value[f.key];
    const def = defaults[f.key];
    const isSet = raw !== undefined;
    const shown = raw === undefined || raw === null ? "" : String(raw);
    const placeholder = raw === null ? "выкл" : override ? (def === null ? "по умолч.: выкл" : `по умолч.: ${def}`) : f.nullable ? "выкл (пусто)" : "";
    return (
      <Field key={f.key} label={f.label} hint={f.hint}>
        <div className="flex items-center gap-1">
          <input
            type="number"
            step="any"
            className={`${inputCls} ${override && isSet ? "border-indigo-500/60" : ""}`}
            value={shown}
            placeholder={placeholder}
            onChange={(e) => {
              const t = e.target.value;
              if (t === "") setKey(f.key, override ? undefined : f.nullable ? null : undefined);
              else setKey(f.key, Number(t));
            }}
          />
          {f.nullable && override && raw !== null && def !== null && (
            <Btn size="sm" variant="ghost" title="Отключить для этого кита" onClick={() => setKey(f.key, null)}>
              выкл
            </Btn>
          )}
          {override && isSet && (
            <Btn size="sm" variant="ghost" title="Сбросить к значению по умолчанию" onClick={() => setKey(f.key, undefined)}>
              ↺
            </Btn>
          )}
        </div>
      </Field>
    );
  };

  const renderBool = (k: BoolKey, label: string, hint: string) => {
    const raw = value[k];
    if (!override) return <Toggle key={k} checked={eff[k]} onChange={(v) => setKey(k, v)} label={label} hint={hint} />;
    return (
      <Field key={k} label={label} hint={hint}>
        <select
          className={`${inputCls} ${raw !== undefined ? "border-indigo-500/60" : ""}`}
          value={raw === undefined ? "" : raw ? "1" : "0"}
          onChange={(e) => setKey(k, e.target.value === "" ? undefined : e.target.value === "1")}
        >
          <option value="">по умолчанию ({defaults[k] ? "да" : "нет"})</option>
          <option value="1">да</option>
          <option value="0">нет</option>
        </select>
      </Field>
    );
  };

  const renderStr = (k: StrKey, label: string, hint: string, multiline = false) => {
    const raw = value[k];
    const shown = raw ?? "";
    const placeholder = override ? (defaults[k] ? `по умолч.: ${defaults[k]}` : "по умолчанию пусто") : "";
    const common = {
      value: shown,
      placeholder,
      className: `${multiline ? textareaCls : inputCls} ${override && raw !== undefined ? "border-indigo-500/60" : ""}`,
      onChange: (e: { target: { value: string } }) => setKey(k, e.target.value === "" && override ? undefined : e.target.value),
    };
    return (
      <Field key={k} label={label} hint={hint} className={multiline ? "sm:col-span-2 lg:col-span-4" : "sm:col-span-2"}>
        {multiline ? <textarea {...common} /> : <input {...common} />}
      </Field>
    );
  };

  const section = (title: string, desc: string, children: ReactNode) => (
    <div className="rounded-xl border border-slate-800/70 bg-slate-950/40 p-3">
      <div className="mb-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</div>
        <div className="text-[11px] text-slate-500">{desc}</div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
    </div>
  );

  const sizingLabel = SIZING.find((s) => s.id === eff.sizingMode)?.label ?? eff.sizingMode;

  return (
    <div className="space-y-3">
      {/* Итог */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-3 text-xs text-slate-300">
        <span className="mr-1 font-semibold text-indigo-300">Итого:</span>
        <Badge tone="indigo">{sizingLabel}</Badge>
        <Badge>ставка ≤ ${eff.maxBetUsd}</Badge>
        <Badge>
          вход {cents(eff.minEntryPrice)}–{cents(eff.maxEntryPrice)}
        </Badge>
        <Badge>объём ≥ ${eff.minVolumeUsd.toLocaleString("ru-RU")}</Badge>
        <Badge>свежесть ≤ {eff.maxTradeAgeMin} мин</Badge>
        <Badge tone={eff.takeProfitPrice !== null ? "green" : "slate"}>TP {cents(eff.takeProfitPrice)}</Badge>
        <Badge tone={eff.stopLossPrice !== null ? "red" : "slate"}>SL {cents(eff.stopLossPrice)}</Badge>
        <Badge tone={eff.useAi ? "violet" : "slate"}>ИИ {eff.useAi ? "да" : "нет"}</Badge>
        <Badge tone={eff.copySells ? "amber" : "slate"}>выход за китом {eff.copySells ? "да" : "нет"}</Badge>
        {override && (
          <span className="ml-auto flex items-center gap-2">
            <span className="text-slate-500">переопределений: {overrides.length}</span>
            {overrides.length > 0 && (
              <Btn size="sm" variant="ghost" onClick={() => onChange({})}>
                сбросить все
              </Btn>
            )}
          </span>
        )}
      </div>

      {section(
        "💵 Размер ставки",
        "как считается сумма каждой копии",
        <>
          <Field label="Метод расчёта" hint={SIZING.find((s) => s.id === eff.sizingMode)?.hint}>
            <select
              className={`${inputCls} ${override && value.sizingMode !== undefined ? "border-indigo-500/60" : ""}`}
              value={override ? (value.sizingMode ?? "") : eff.sizingMode}
              onChange={(e) => setKey("sizingMode", (e.target.value || undefined) as SizingMode | undefined)}
            >
              {override && <option value="">по умолчанию ({SIZING.find((s) => s.id === defaults.sizingMode)?.label})</option>}
              {SIZING.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          {SIZING_FIELDS.filter((f) => !f.showFor || f.showFor.includes(eff.sizingMode)).map(renderNum)}
        </>
      )}

      {section(
        "🔍 Фильтры входа",
        "какие сделки кита вообще рассматриваем",
        <>
          {FILTER_FIELDS.map(renderNum)}
          {renderStr("allowedKeywords", "Разрешённые слова", "через запятую; если задано — берём только рынки с этими словами")}
          {renderStr("blockedKeywords", "Стоп-слова", "через запятую; рынки с этими словами пропускаем")}
        </>
      )}

      {section(
        "🚪 Выход из позиции",
        "когда продавать, не дожидаясь резолва",
        <>
          {EXIT_FIELDS.map(renderNum)}
          <div className="sm:col-span-2 lg:col-span-2">{renderBool("copySells", "Выходить вслед за китом", "если кит продал — продаём и мы")}</div>
        </>
      )}

      {section(
        "🤖 ИИ-подтверждение",
        "Вася оценивает каждую сделку перед копированием (нужен включённый ИИ в настройках)",
        <>
          <div className="sm:col-span-2">{renderBool("useAi", "Спрашивать ИИ перед копированием", "SKIP от ИИ отменяет сделку, множитель меняет размер")}</div>
          {renderStr("aiPromptExtra", "Дополнение к промту", "особенности этого трейдера / категории, которые ИИ должен учитывать", true)}
        </>
      )}
    </div>
  );
}
