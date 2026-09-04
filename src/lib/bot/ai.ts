import type { Settings } from "@/db/schema";
import type { AiDecision } from "./types";

export type AiSettings = Pick<
  Settings,
  "aiApiUrl" | "aiApiKey" | "aiModel" | "aiSystemPrompt" | "aiTemperature" | "aiTimeoutMs"
>;

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

export function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

export async function chatCompletion(
  ai: AiSettings,
  messages: { role: "system" | "user" | "assistant"; content: string }[]
): Promise<{ content: string; raw: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ai.aiTimeoutMs || 30_000);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (ai.aiApiKey) {
      headers.Authorization = `Bearer ${ai.aiApiKey}`;
      headers["x-api-key"] = ai.aiApiKey;
    }
    headers["HTTP-Referer"] = "https://polymarket-copytrader.local";
    headers["X-Title"] = "Polymarket Copy-Trader";

    const res = await fetch(resolveChatUrl(ai.aiApiUrl), {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({ model: ai.aiModel, temperature: ai.aiTemperature, messages }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`AI HTTP ${res.status}: ${text.slice(0, 300)}`);
    const json = JSON.parse(text);
    const content: string =
      json?.choices?.[0]?.message?.content ??
      json?.message?.content ?? // Ollama native
      json?.content?.[0]?.text ?? // Anthropic-style
      "";
    if (!content) throw new Error("Пустой ответ модели");
    return { content, raw: json };
  } finally {
    clearTimeout(timer);
  }
}

export type TradeContext = {
  whale: { name: string; category: string; address: string; notes: string; promptExtra: string };
  whaleStats: { copied: number; wins: number; losses: number; pnlUsd: number };
  trade: { side: string; outcome: string; price: number; sizeShares: number; sizeUsd: number; ageMin: number };
  market: {
    question: string;
    outcomes: string[];
    outcomePrices: number[];
    volumeUsd: number;
    liquidityUsd: number;
    endDate: string | null;
    hoursToEnd: number | null;
  };
  portfolio: {
    mode: string;
    cashUsd: number;
    equityUsd: number;
    openPositions: number;
    categoryExposureUsd: number;
    categoryBudgetUsd: number;
    proposedBetUsd: number;
  };
  /** блок памяти Васи (подмешивается в system) */
  memory?: string;
};

export async function askAi(ai: AiSettings, ctx: TradeContext): Promise<AiDecision> {
  const system = [
    ai.aiSystemPrompt,
    ctx.whale.promptExtra && `\nДополнительно про этого трейдера:\n${ctx.whale.promptExtra}`,
    ctx.memory,
  ]
    .filter(Boolean)
    .join("\n");
  const ctxForUser: Partial<TradeContext> = { ...ctx };
  delete ctxForUser.memory;
  const user = `Контекст сделки (JSON):\n${JSON.stringify(ctxForUser, null, 2)}\n\nОтветь одним JSON-объектом.`;

  try {
    const { content } = await chatCompletion(ai, [
      { role: "system", content: system },
      { role: "user", content: user },
    ]);
    const parsed = extractJson(content);
    if (!parsed) {
      return { decision: "SKIP", confidence: 0, sizeMultiplier: 1, reason: "Ответ ИИ не распарсился", raw: content, error: "parse" };
    }
    const decision = String(parsed.decision ?? "SKIP").toUpperCase() === "COPY" ? "COPY" : "SKIP";
    const confidence = clamp(Number(parsed.confidence ?? 0), 0, 1);
    const sizeMultiplier = clamp(Number(parsed.sizeMultiplier ?? 1) || 1, 0.25, 2);
    const reason = String(parsed.reason ?? "").slice(0, 400);
    return { decision, confidence, sizeMultiplier, reason, raw: content };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { decision: "SKIP", confidence: 0, sizeMultiplier: 1, reason: `Ошибка ИИ: ${message}`, error: message };
  }
}

function clamp(n: number, lo: number, hi: number) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
