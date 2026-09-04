import type { Settings } from "@/db/schema";

export async function sendTelegram(s: Pick<Settings, "telegramBotToken" | "telegramChatId">, text: string): Promise<boolean> {
  if (!s.telegramBotToken || !s.telegramChatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${s.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: s.telegramChatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
