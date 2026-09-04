"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

// ── Базовые классы ──────────────────────────────────────────────────────────

export const inputCls =
  "w-full rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/25 disabled:cursor-not-allowed disabled:opacity-50";
export const textareaCls = `${inputCls} min-h-24 resize-y font-mono text-xs leading-relaxed`;

export type Tone = "slate" | "green" | "red" | "amber" | "violet" | "sky" | "indigo";

const toneBorder: Record<Tone, string> = {
  slate: "border-slate-700 bg-slate-800/70 text-slate-300",
  green: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  red: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  amber: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  violet: "border-violet-500/30 bg-violet-500/10 text-violet-300",
  sky: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  indigo: "border-indigo-500/30 bg-indigo-500/10 text-indigo-300",
};

// ── Badge ───────────────────────────────────────────────────────────────────

export function Badge({ children, tone = "slate", className = "", title }: { children: ReactNode; tone?: Tone; className?: string; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap ${toneBorder[tone]} ${className}`}>
      {children}
    </span>
  );
}

export function ModeBadge({ mode }: { mode: string }) {
  return mode === "live" ? <Badge tone="red">🔴 LIVE</Badge> : <Badge tone="sky">📝 PAPER</Badge>;
}

// ── Spinner ─────────────────────────────────────────────────────────────────

export function Spinner({ className = "" }: { className?: string }) {
  return <span className={`inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} />;
}

// ── Button ──────────────────────────────────────────────────────────────────

type BtnVariant = "default" | "primary" | "ghost" | "danger" | "success";
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm" | "md" | "lg"; loading?: boolean };

const btnVariant: Record<BtnVariant, string> = {
  default: "border-slate-700 bg-slate-800/80 text-slate-200 hover:border-slate-600 hover:bg-slate-700/80",
  primary: "border-indigo-500/60 bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 hover:bg-indigo-500",
  success: "border-emerald-500/60 bg-emerald-600 text-white shadow-lg shadow-emerald-600/20 hover:bg-emerald-500",
  danger: "border-rose-500/40 bg-rose-600/20 text-rose-200 hover:bg-rose-600/35",
  ghost: "border-transparent bg-transparent text-slate-400 hover:bg-slate-800/70 hover:text-slate-200",
};
const btnSize = { sm: "px-2.5 py-1 text-xs", md: "px-3.5 py-2 text-sm", lg: "px-5 py-2.5 text-base" };

export function Btn({ variant = "default", size = "md", loading = false, className = "", children, disabled, type = "button", ...rest }: BtnProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium whitespace-nowrap transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 ${btnVariant[variant]} ${btnSize[size]} ${className}`}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

// ── Card ────────────────────────────────────────────────────────────────────

export function Card({ id, title, right, children, className = "", padded = true }: { id?: string; title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section id={id} className={`scroll-mt-20 rounded-2xl border border-slate-800/80 bg-slate-900/50 shadow-sm ${className}`}>
      {(title || right) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/70 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
          {right && <div className="flex items-center gap-2">{right}</div>}
        </header>
      )}
      <div className={padded ? "p-4" : ""}>{children}</div>
    </section>
  );
}

// ── Field ───────────────────────────────────────────────────────────────────

export function Field({ label, hint, children, className = "" }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`block ${className}`}>
      <span className="mb-1 block text-xs font-medium text-slate-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-500">{hint}</span>}
    </div>
  );
}

// ── Toggle ──────────────────────────────────────────────────────────────────

export function Toggle({ checked, onChange, label, disabled, hint }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; hint?: ReactNode }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`group flex items-center gap-2.5 text-left ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <span className={`relative h-5 w-9 shrink-0 rounded-full transition ${checked ? "bg-emerald-500" : "bg-slate-700 group-hover:bg-slate-600"}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? "left-[18px]" : "left-0.5"}`} />
      </span>
      {(label || hint) && (
        <span className="flex flex-col">
          {label && <span className="text-sm text-slate-300">{label}</span>}
          {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
        </span>
      )}
    </button>
  );
}

// ── P&L ─────────────────────────────────────────────────────────────────────

export function Pnl({ value, pct, className = "" }: { value: number | null | undefined; pct?: number | null; className?: string }) {
  const v = value ?? 0;
  const tone = v > 0.005 ? "text-emerald-400" : v < -0.005 ? "text-rose-400" : "text-slate-400";
  return (
    <span className={`font-medium tabular-nums ${tone} ${className}`}>
      {v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(2)}
      {pct !== undefined && pct !== null && Number.isFinite(pct) && (
        <span className="ml-1 text-[11px] opacity-80">
          ({pct >= 0 ? "+" : ""}
          {pct.toFixed(1)}%)
        </span>
      )}
    </span>
  );
}

// ── Stat ────────────────────────────────────────────────────────────────────

const statRing: Record<Tone, string> = {
  slate: "",
  green: "border-emerald-500/30",
  red: "border-rose-500/30",
  amber: "border-amber-500/30",
  violet: "border-violet-500/30",
  sky: "border-sky-500/30",
  indigo: "border-indigo-500/30",
};

export function Stat({ label, value, sub, tone = "slate", icon }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone; icon?: string }) {
  return (
    <div className={`rounded-2xl border border-slate-800/80 bg-slate-900/50 p-4 ${statRing[tone]}`}>
      <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-slate-500">
        <span>{label}</span>
        {icon && <span className="text-base">{icon}</span>}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

// ── Table ───────────────────────────────────────────────────────────────────

export function Table({ head, rows, empty = "Пусто", minWidth = 560 }: { head: ReactNode[]; rows: ReactNode[][]; empty?: string; minWidth?: number }) {
  if (!rows.length) return <p className="py-6 text-center text-sm text-slate-500">{empty}</p>;
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth }}>
        <thead>
          <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
            {head.map((h, i) => (
              <th key={i} className="px-2 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/70">
          {rows.map((r, i) => (
            <tr key={i} className="transition hover:bg-slate-800/30">
              {r.map((c, j) => (
                <td key={j} className="px-2 py-2 align-top text-slate-300">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Alert / Empty ───────────────────────────────────────────────────────────

const alertTone: Record<Tone, string> = {
  slate: "border-slate-700 bg-slate-800/40 text-slate-300",
  green: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  red: "border-rose-500/30 bg-rose-500/10 text-rose-200",
  amber: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  violet: "border-violet-500/30 bg-violet-500/10 text-violet-200",
  sky: "border-sky-500/30 bg-sky-500/10 text-sky-200",
  indigo: "border-indigo-500/30 bg-indigo-500/10 text-indigo-200",
};

export function Alert({ tone = "amber", title, children, right }: { tone?: Tone; title?: ReactNode; children?: ReactNode; right?: ReactNode }) {
  return (
    <div className={`flex items-start justify-between gap-3 rounded-xl border p-3 text-sm ${alertTone[tone]}`}>
      <div>
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={title ? "mt-1 opacity-90" : ""}>{children}</div>}
      </div>
      {right}
    </div>
  );
}

export function Empty({ children, icon = "📭" }: { children: ReactNode; icon?: string }) {
  return (
    <div className="py-8 text-center">
      <div className="text-3xl">{icon}</div>
      <p className="mt-2 text-sm text-slate-500">{children}</p>
    </div>
  );
}

// ── Подписи источников (стратегий) для позиций ──────────────────────────────

export const SOURCE_LABELS: Record<string, string> = {
  copy: "🐋 Копирование",
  arb_yes_no: "⚖️ Арбитраж Yes+No",
  crypto_threshold: "₿ Крипто-порог",
  favorite_finish: "🏁 Фаворит на финише",
  momentum: "🚀 Импульс",
  contrarian: "🔄 Контртренд",
  consensus: "🤝 Консенсус китов",
  cheap_longshot: "🎲 Аутсайдеры",
  free_swim: "🎯 Свободное плавание",
  hedge: "🛡️ Хедж",
  auto_scout: "🔎 Авто-разведка",
};
export const sourceLabel = (id: string) => SOURCE_LABELS[id] ?? id;

export const statusTone = (status: string): Tone => (status === "WON" ? "green" : status === "LOST" ? "red" : status === "SOLD" ? "amber" : "sky");
