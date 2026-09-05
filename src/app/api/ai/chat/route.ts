import { chatCompletion, type ChatMsg } from "@/lib/bot/ai";
import { computeLedger } from "@/lib/bot/ledger";
import { buildMemoryBlock, extractRememberTags, memoryStats } from "@/lib/bot/memory";
import { realtime } from "@/lib/bot/realtime";
import { getRunnerState } from "@/lib/bot/runner";
import { addChatMessage, clearChatHistory, getChatHistory, getSettings, listWhales, openPositions } from "@/lib/bot/store";
import { runTool, TOOLS } from "@/lib/bot/tools";
import type { TradingMode } from "@/lib/bot/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 180;

const SYSTEM = `Ты — **Вася**, ИИ-трейдер и операционный ассистент копитрейдера Polymarket. У тебя есть ИНСТРУМЕНТЫ — ты не «советуешь», а ДЕЛАЕШЬ.

## Как работать
1. Любой вопрос о деньгах/позициях → сначала вызови get_portfolio / list_positions (не отвечай по памяти).
2. Просьба «купи/продай/закрой/запусти/включи/выключи/поменяй» → вызови соответствующий инструмент, затем кратко отчитайся результатом инструмента (id позиции, цена, новый кэш).
3. Если инструмент вернул needsConfirm — опиши действие одной строкой и спроси «Подтверждаешь?». После «да» — повтори вызов с confirm=true.
4. Если инструмент вернул error — объясни причину человеческим языком и предложи, что сделать.
5. Никогда не выдумывай числа: цитируй значения из ответов инструментов.

## Правила про деньги (леджер)
- Эквити = кэш + стоимость открытых = стартовый банк + реализованный P&L + нереализованный P&L. Если get_portfolio показывает cashDriftUsd ≠ 0 или overdraft=true — сообщи об этом первым делом и предложи reconcile.
- Деньги «извне» появляются только через cash_adjustment с причиной.
- Одна открытая позиция на рынок. Если пользователь просит купить рынок, который уже есть — скажи об этом.

## Стиль
- Русский язык, конкретные цифры, эмодзи 📊 💰 ⚠️ 🎯 ✅ ❌ 🛡️, короткие таблицы.
- Не здоровайся повторно в идущем диалоге.
- Чтобы что-то запомнить надолго, вызови remember (или добавь [[ЗАПОМНИ: …]]).`;

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("clear") === "true") {
    await clearChatHistory();
    return Response.json({ ok: true, messages: [] });
  }
  if (url.searchParams.get("tools") === "true") return Response.json({ tools: TOOLS.map((t) => ({ name: t.function.name, description: t.function.description })) });
  return Response.json({ messages: await getChatHistory(80) });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { message?: string; mode?: string };
  const message = (body.message ?? "").trim();
  if (!message) return Response.json({ error: "message required" }, { status: 400 });
  const settings = await getSettings();
  const mode: TradingMode = (body.mode === "live" || body.mode === "paper")
    ? body.mode
    : (settings.tradingMode === "live" ? "live" : "paper");

  await addChatMessage("user", message);
  const history = await getChatHistory(40);
  const [ledger, open, whales, memory, mstats] = await Promise.all([
    computeLedger(mode).catch(() => null),
    openPositions(mode),
    listWhales(),
    settings.aiMemoryEnabled ? buildMemoryBlock({}, 3500) : "",
    memoryStats(),
  ]);
  const runner = getRunnerState();

  const system = `${SYSTEM}

## Снимок (режим ${mode.toUpperCase()}, ${new Date().toLocaleString("ru-RU")})
Леджер: ${JSON.stringify(ledger)}
Открытых позиций: ${open.length} → ${open.slice(0, 20).map((p) => `#${p.id} ${p.market.slice(0, 40)} [${p.outcome}] ${Math.round(p.price * 100)}¢→${Math.round((p.lastPrice ?? p.price) * 100)}¢ $${p.costUsd.toFixed(2)}`).join("; ")}
Авто-цикл: ${runner.running ? "включён" : "выключен"}, цикл идёт: ${runner.cycleInProgress}
Киты: ${whales.map((w) => `${w.name}${w.enabled ? "" : " (выкл)"}`).join(", ")}
Память: ${mstats.total} записей.${memory}`;

  const msgs: ChatMsg[] = [{ role: "system", content: system }, ...history.slice(-30).map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))];
  const aiSettings = { aiApiUrl: settings.aiApiUrl, aiApiKey: settings.aiApiKey, aiModel: settings.aiModel, aiSystemPrompt: SYSTEM, aiTemperature: Math.max(settings.aiTemperature, 0.2), aiTimeoutMs: 90_000 };
  const toolLog: { name: string; args: unknown; result: unknown }[] = [];

  try {
    // Цикл инструментов: модель может вызвать несколько подряд (до 8 раундов)
    let reply = "";
    for (let round = 0; round < 8; round++) {
      const { content, toolCalls } = await chatCompletion(aiSettings, msgs, { tools: TOOLS });
      if (!toolCalls.length) {
        reply = content;
        break;
      }
      msgs.push({ role: "assistant", content: content || null, tool_calls: toolCalls });
      for (const tc of toolCalls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* пустые аргументы */ }
        realtime.publish("chat", { role: "tool_call", content: `${tc.function.name}(${JSON.stringify(args)})`, tool: tc.function.name });
        const result = await runTool(tc.function.name, args, mode);
        toolLog.push({ name: tc.function.name, args, result });
        msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 12_000) });
      }
      if (round === 7) reply = "Слишком длинная цепочка действий — остановился. Что сделано: " + toolLog.map((t) => t.name).join(" → ");
    }
    const cleaned = await extractRememberTags(reply || "(пустой ответ модели)");
    await addChatMessage("assistant", cleaned, { tools: toolLog.map((t) => ({ name: t.name, args: t.args })) });
    realtime.publish("chat", { role: "assistant", content: cleaned });
    return Response.json({ ok: true, reply: cleaned, tools: toolLog });
  } catch (err) {
    const errorMsg = `⚠️ Ошибка ИИ: ${(err as Error).message}. Проверь URL/ключ/модель в Настройках → ИИ (модель должна поддерживать function calling: gpt-4o-mini, deepseek-chat, llama-3.3-70b, qwen2.5 и т.п.).`;
    await addChatMessage("assistant", errorMsg);
    return Response.json({ ok: false, reply: errorMsg, tools: toolLog });
  }
}
