"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const links = [
  { href: "/", label: "Дашборд", icon: "📊" },
  { href: "/strategies", label: "Стратегии", icon: "🧩" },
  { href: "/whales", label: "Киты", icon: "🐋" },
  { href: "/chat", label: "Чат", icon: "🤖" },
  { href: "/memory", label: "Память", icon: "🧠" },
  { href: "/settings", label: "Настройки", icon: "⚙️" },
  { href: "/logs", label: "Журнал", icon: "📜" },
];

type Runner = { running: boolean; cycleInProgress: boolean; nextRunAt: string | null };

export function Nav() {
  const pathname = usePathname();
  const [runner, setRunner] = useState<Runner | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/bot/loop", { cache: "no-store" })
        .then((r) => r.json())
        .then((d: Runner) => alive && setRunner(d))
        .catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pathname]);

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <header className="sticky top-0 z-40 border-b border-slate-800/80 bg-slate-950/85 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2 py-3 font-semibold text-white">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-base shadow-lg shadow-indigo-500/20">🐋</span>
          <span className="hidden sm:inline">
            Вася <span className="font-normal text-slate-500">· Copy-Trader</span>
          </span>
        </Link>

        <nav className="flex flex-1 items-center gap-1 overflow-x-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition ${
                isActive(l.href) ? "bg-slate-800 text-white shadow-inner" : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
              }`}
            >
              <span className="mr-1">{l.icon}</span>
              {l.label}
            </Link>
          ))}
        </nav>

        {runner && (
          <Link
            href="/"
            title={runner.running && runner.nextRunAt ? `Следующий цикл: ${new Date(runner.nextRunAt).toLocaleTimeString("ru-RU")}` : "Авто-цикл выключен"}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-slate-800 bg-slate-900/70 px-2.5 py-1 text-[11px] text-slate-400 hover:border-slate-700"
          >
            <span className={`h-2 w-2 rounded-full ${runner.cycleInProgress ? "animate-pulse bg-amber-400" : runner.running ? "bg-emerald-400" : "bg-slate-600"}`} />
            <span className="hidden md:inline">{runner.cycleInProgress ? "цикл идёт" : runner.running ? "авто-цикл" : "остановлен"}</span>
          </Link>
        )}
      </div>
    </header>
  );
}
