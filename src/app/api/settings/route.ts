import { getSettings, updateSettings } from "@/lib/bot/store";
import { liveReadiness } from "@/lib/bot/executor";
import { DEFAULT_AI_PROMPT, DEFAULT_STRATEGY } from "@/lib/bot/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function mask(s: Awaited<ReturnType<typeof getSettings>>) {
  return {
    ...s,
    aiApiKey: s.aiApiKey ? `${s.aiApiKey.slice(0, 4)}…${s.aiApiKey.slice(-4)}` : "",
    aiApiKeySet: Boolean(s.aiApiKey),
    telegramBotToken: s.telegramBotToken ? "••••••" : "",
    telegramBotTokenSet: Boolean(s.telegramBotToken),
    httpProxyUrl: s.httpProxyUrl.replace(/\/\/([^:@]+):([^@]+)@/, "//$1:••••@"),
    httpProxyUrlSet: Boolean(s.httpProxyUrl),
  };
}

export async function GET() {
  const s = await getSettings();
  return Response.json({
    settings: mask(s),
    liveReadiness: liveReadiness(s),
    defaults: { strategy: DEFAULT_STRATEGY, aiPrompt: DEFAULT_AI_PROMPT },
  });
}

const SECRET_KEYS = ["aiApiKey", "telegramBotToken", "httpProxyUrl"] as const;

export async function PUT(req: Request) {
  const body = (await req.json()) as Record<string, unknown>;
  const patch: Record<string, unknown> = { ...body };
  // секреты: пустая строка или маска = не менять; "__clear__" = очистить
  for (const k of SECRET_KEYS) {
    const v = patch[k];
    if (v === undefined) continue;
    if (v === "__clear__") patch[k] = "";
    else if (typeof v !== "string" || v === "" || v.includes("•") || /^.{4}…/.test(v)) delete patch[k];
  }
  if (patch.tradingMode !== undefined && patch.tradingMode !== "live") patch.tradingMode = "paper";
  if (patch.tradingMode === "paper") patch.liveArmed = false;
  delete patch.aiApiKeySet;
  delete patch.telegramBotTokenSet;
  delete patch.httpProxyUrlSet;
  delete patch.updatedAt;
  const s = await updateSettings(patch);
  return Response.json({ settings: mask(s), liveReadiness: liveReadiness(s) });
}
