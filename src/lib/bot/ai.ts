import type { Settings } from "@/db/schema";
import type { AiDecision, Strategy } from "./types";
import type { ToolDef } from "./tools";

export type AiSettings = Pick<Settings, "aiApiUrl" | "aiApiKey" | "aiModel" | "aiSystemPrompt" | "aiTemperature" | "aiTimeoutMs">;

/** Нормализуем URL: можно указать базу (…/v1) или полный путь до chat/completions */
export function resolveChatUrl(url: string): string {
  const u = url.trim().replace(/\/$/, "");
  if (/\/chat\/completions$/.test(u)) return u;
  if (/\/v1\/?$/.test(u)) return `${u}/chat/completions`;
  if (/\/api\/?$/.test(u)) return `${u}/chat/completions`;
  if (/\/v1\//.test(u)) return u.replace(/\/v1\/.*$/, "/v1/chat/completions");
  if (u.includes("/v1")) return `${u}/chat/completions`;
  return `${u}/v1/chat/completions`;
}

export type ChatMsg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type TradeContext = {
  whale: { name: string; category: string; notes: string; strategy: Strategy };
  trade: { title: string; outcome: string; price: number; whaleUsd: number; ageMin: number };
  market: { question: string; volumeUsd: number; liquidityUsd: number; endDate: string | null; outcomes: string[]; outcomePrices: number[]; hoursToEnd: number | null };
  portfolio: { cashUsd: number; equityUsd: number; openCount: number; categoryExposureUsd: number; categoryBudgetUsd: number; proposedBetUsd: number; overdraft: boolean };
  whaleStats: unknown;
  memory: string;
};

/** Один вызов OpenAI-совместимого chat/completions. Поддерживает tools (function calling). */
export async function chatCompletion(
  s: AiSettings,
  messages: ChatMsg[],
  opts: { tools?: ToolDef[]; toolChoice?: "auto" | "none"; jsonMode?: boolean } = {}
): Promise<{ content: string; toolCalls: ToolCall[]; raw: unknown }> {
  if (!s.aiApiUrl) throw new Error("Не задан URL ИИ API");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), s.aiTimeoutMs || 60_000);
  try {
    const body: Record<string, unknown> = { model: s.aiModel, temperature: s.aiTemperature, messages };
    if (opts.tools?.length) {
      body.tools = opts.tools;
      body.tool_choice = opts.toolChoice ?? "auto";
    }
    if (opts.jsonMode) body.response_format = { type: "json_object" };
    const res = await fetch(resolveChatUrl(s.aiApiUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(s.aiApiKey ? { Authorization: `Bearer ${s.aiApiKey}` } : {}), "HTTP-Referer": "https://github.com/pavlon987-cmyk/polymarket", "X-Title": "Polymarket Copy-Trader" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`ИИ HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[] };
    const msg = json.choices?.[0]?.message;
    return { content: msg?.content ?? "", toolCalls: msg?.tool_calls ?? [], raw: json };
  } finally {
    clearTimeout(timer);
  }
}

/** Решение COPY/SKIP по сделке кита */
export async function askAi(settings: Settings, ctx: TradeContext): Promise<AiDecision> {
  const user = `Сделка кита для копирования:\n${JSON.stringify({ ...ctx, memory: undefined }, null, 1)}\n${ctx.memory ? `\nПАМЯТЬ:\n${ctx.memory}` : ""}\n\nОтветь одним JSON: {"decision":"COPY"|"SKIP","confidence":0..1,"sizeMultiplier":0.25..2,"reason":"до 200 символов"}`;
  try {
    const { content, raw } = await chatCompletion(settings, [{ role: "system", content: settings.aiSystemPrompt }, { role: "user", content: user }], { jsonMode: true });
    const cleaned = content.replace(/```(?:json)?/gi, "").trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : cleaned) as Partial<AiDecision>;
    return {
      decision: parsed.decision === "COPY" ? "COPY" : "SKIP",
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0))),
      sizeMultiplier: Math.max(0.25, Math.min(2, Number(parsed.sizeMultiplier ?? 1))),
      reason: String(parsed.reason ?? "").slice(0, 300),
      raw: JSON.stringify(raw).slice(0, 2000),
    };
  } catch (err) {
    return { decision: "SKIP", confidence: 0, sizeMultiplier: 1, reason: `ошибка ИИ: ${(err as Error).message}`, error: (err as Error).message };
  }
}

export function extractJson(raw: string): unknown {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const m = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  return JSON.parse(m ? m[0] : cleaned);
}
