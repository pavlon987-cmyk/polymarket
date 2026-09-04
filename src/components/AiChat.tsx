"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/format";
import { Badge, Btn, Spinner, textareaCls } from "./ui";

type Msg = { role: "user" | "assistant"; content: string; pending?: boolean };

const QUICK = [
  "📊 Проанализируй портфель и скажи, что делать",
  "🐋 Какие киты и стратегии убыточны? Что с ними делать?",
  "🛡️ Какие позиции стоит хеджировать или закрыть?",
  "🧠 Что ты запомнил? Какие у тебя принципы?",
  "💰 Как распределить кэш на ближайшую неделю?",
];

// ── Мини-markdown ───────────────────────────────────────────────────────────

function inline(text: string, key: number): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <span key={key}>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          <strong key={i} className="font-semibold text-white">
            {p.slice(2, -2)}
          </strong>
        ) : p.startsWith("`") && p.endsWith("`") ? (
          <code key={i} className="rounded bg-slate-950/70 px-1 py-0.5 font-mono text-[12px] text-indigo-200">
            {p.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </span>
  );
}

function Md({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  const isTable = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const isUl = (l: string) => /^\s*[-*•]\s+/.test(l);
  const isOl = (l: string) => /^\s*\d+[.)]\s+/.test(l);

  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(
        <pre key={k++} className="my-2 overflow-x-auto rounded-lg bg-slate-950/80 p-3 font-mono text-[12px] text-slate-300">
          {buf.join("\n")}
        </pre>
      );
      continue;
    }
    if (isTable(l)) {
      const rows: string[][] = [];
      while (i < lines.length && isTable(lines[i])) {
        const cells = lines[i].trim().slice(1, -1).split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      out.push(
        <div key={k++} className="my-2 overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr>
                {head?.map((c, j) => (
                  <th key={j} className="border-b border-slate-700 px-2 py-1 text-left font-semibold text-slate-200">
                    {inline(c, j)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri} className="border-b border-slate-800/60">
                  {r.map((c, j) => (
                    <td key={j} className="px-2 py-1 text-slate-300">
                      {inline(c, j)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }
    if (isUl(l)) {
      const items: string[] = [];
      while (i < lines.length && isUl(lines[i])) items.push(lines[i++].replace(/^\s*[-*•]\s+/, ""));
      out.push(
        <ul key={k++} className="my-1.5 list-disc space-y-0.5 pl-5">
          {items.map((t, j) => (
            <li key={j}>{inline(t, j)}</li>
          ))}
        </ul>
      );
      continue;
    }
    if (isOl(l)) {
      const items: string[] = [];
      while (i < lines.length && isOl(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      out.push(
        <ol key={k++} className="my-1.5 list-decimal space-y-0.5 pl-5">
          {items.map((t, j) => (
            <li key={j}>{inline(t, j)}</li>
          ))}
        </ol>
      );
      continue;
    }
    const h = l.match(/^\s*(#{1,4})\s+(.*)$/);
    if (h) {
      out.push(
        <p key={k++} className={`mt-2 font-semibold text-white ${h[1].length <= 2 ? "text-base" : "text-sm"}`}>
          {inline(h[2], 0)}
        </p>
      );
      i++;
      continue;
    }
    if (l.trim() === "") {
      i++;
      continue;
    }
    out.push(
      <p key={k++} className="my-1">
        {inline(l, 0)}
      </p>
    );
    i++;
  }
  return <div className="text-sm leading-relaxed">{out}</div>;
}

// ── Чат ─────────────────────────────────────────────────────────────────────

export function AiChat() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"paper" | "live">("paper");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [aiEnabled, setAiEnabled] = useState<boolean | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ messages: Msg[] }>("/api/ai/chat");
      setMessages(r.messages);
    } catch {
      /* пусто */
    } finally {
      setLoaded(true);
    }
    api<{ settings: { aiEnabled: boolean; tradingMode: string } }>("/api/settings")
      .then((r) => {
        setAiEnabled(r.settings.aiEnabled);
        if (r.settings.tradingMode === "live") setMode("live");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  const send = async (text?: string) => {
    const message = (text ?? input).trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", content: message }, { role: "assistant", content: "", pending: true }]);
    try {
      const r = await api<{ ok: boolean; reply: string }>("/api/ai/chat", { method: "POST", body: JSON.stringify({ message, mode }) });
      setMessages((m) => [...m.filter((x) => !x.pending), { role: "assistant", content: r.reply }]);
    } catch (e) {
      setMessages((m) => [...m.filter((x) => !x.pending), { role: "assistant", content: `⚠️ ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
      taRef.current?.focus();
    }
  };

  const clear = async () => {
    if (!confirm("Очистить историю чата? Память Васи при этом сохранится.")) return;
    await api("/api/ai/chat?clear=true");
    setMessages([]);
  };

  return (
    <div className="flex h-[calc(100vh-7.5rem)] flex-col">
      {/* Шапка */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-white">
            🤖 Чат с Васей
            {aiEnabled === false && <Badge tone="amber">ИИ выключен</Badge>}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Вася видит портфель, китов, стратегии и свою память. Скажи «запомни: …» — и он запомнит навсегда.{" "}
            <Link href="/memory" className="text-indigo-400 hover:underline">
              Что он помнит →
            </Link>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-slate-700 p-0.5 text-xs">
            {(["paper", "live"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-md px-2.5 py-1 transition ${mode === m ? (m === "live" ? "bg-rose-600/80 text-white" : "bg-slate-700 text-white") : "text-slate-400 hover:text-slate-200"}`}
              >
                {m.toUpperCase()}
              </button>
            ))}
          </div>
          <Btn size="sm" variant="ghost" onClick={clear} disabled={!messages.length}>
            🗑 очистить
          </Btn>
        </div>
      </div>

      {aiEnabled === false && (
        <div className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
          ИИ выключен — чат работать не будет.{" "}
          <Link href="/settings#ai" className="underline">
            Включить в настройках →
          </Link>
        </div>
      )}

      {/* Сообщения */}
      <div className="flex-1 space-y-4 overflow-y-auto rounded-2xl border border-slate-800/80 bg-slate-900/40 p-4">
        {!loaded ? (
          <p className="py-10 text-center text-slate-500">Загрузка…</p>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="text-5xl">🐋</div>
            <p className="mt-3 text-slate-300">Привет! Я Вася. Спроси про портфель, китов, стратегии — или дай указание.</p>
            <div className="mt-5 flex max-w-xl flex-wrap justify-center gap-2">
              {QUICK.map((q) => (
                <button key={q} onClick={() => send(q)} className="rounded-full border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-xs text-slate-300 transition hover:border-indigo-500/60 hover:text-white">
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              {m.role === "assistant" && <div className="mr-2 mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-sm">🐋</div>}
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2.5 ${
                  m.role === "user" ? "rounded-br-md bg-indigo-600 text-white" : "rounded-bl-md border border-slate-800 bg-slate-900/80 text-slate-200"
                }`}
              >
                {m.pending ? (
                  <span className="flex items-center gap-2 text-sm text-slate-400">
                    <Spinner /> Вася думает…
                  </span>
                ) : m.role === "user" ? (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">{m.content}</p>
                ) : (
                  <Md text={m.content} />
                )}
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Быстрые вопросы (когда история уже есть) */}
      {messages.length > 0 && (
        <div className="flex gap-2 overflow-x-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {QUICK.map((q) => (
            <button key={q} onClick={() => send(q)} disabled={busy} className="shrink-0 rounded-full border border-slate-800 bg-slate-900/60 px-3 py-1 text-[11px] text-slate-400 transition hover:border-indigo-500/60 hover:text-white disabled:opacity-50">
              {q}
            </button>
          ))}
        </div>
      )}

      {/* Ввод */}
      <div className="mt-2 flex items-end gap-2">
        <textarea
          ref={taRef}
          className={`${textareaCls} min-h-[52px] max-h-40 font-sans text-sm`}
          placeholder="Напиши Васе… (Enter — отправить, Shift+Enter — новая строка)"
          value={input}
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <Btn variant="primary" size="lg" onClick={() => send()} loading={busy} disabled={!input.trim()}>
          ➤
        </Btn>
      </div>
    </div>
  );
}
