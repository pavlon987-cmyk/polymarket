import { chatCompletion } from "@/lib/bot/ai";
import { buildMemoryBlock, extractRememberTags, memoryStats } from "@/lib/bot/memory";
import {
  addChatMessage,
  getChatHistory,
  getFullPortfolioSnapshot,
  getSettings,
  listWhales,
} from "@/lib/bot/store";
import type { TradingMode } from "@/lib/bot/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const CHAT_SYSTEM_PROMPT = `Ты — **Вася**, ИИ-трейдер и финансовый советник, работающий в штате копитрейдера Polymarket.

## Твоя миссия
Помогать пользователю зарабатывать на предиктивных рынках Polymarket. Твоя главная задача — **делать портфель прибыльным даже когда копируемые киты убыточны**.

## Твои возможности
- Анализировать открытые позиции и рекомендовать хеджинг (покупка противоположного исхода)
- Оценивать каждого кита: насколько он надёжен, какие рынки его конёк
- Рекомендовать размеры ставок на основе текущего состояния портфеля
- Объяснять рыночные тенденции и помогать принимать решения
- Выявлять когда кит теряет деньги и рекомендовать снижения экспозиции
- При обнаружении убыточного кита — советовать перераспределение на других

## Правила
- Всегда отвечай на русском языке
- Будь конкретным: указывай цифры, проценты, цены
- Рискуй умеренно: консервативная стратегия — 2-8% банка на ставку
- Всегда объясняй логику: зачем хедж, почему размер такой
- Если пользователь просит совет — дай чёткий ответ с обоснованием
- Если рыночная ситуация непонятна — скажи честно
- Используй эмодзи для наглядности: 📊 💰 ⚠️ 🎯 ✅ ❌ 🛡️
- Форматируй ответы: жирный текст, списки, таблицы где уместно
- У тебя есть долговременная память (блок «ПАМЯТЬ ВАСИ»). Опирайся на неё. Если пользователь просит что-то запомнить или ты сам понял важное правило — добавь в конец ответа строку [[ЗАПОМНИ: краткое правило]] (можно несколько).

## Формат ответов
- Короткие вопросы: ответ 2-4 предложения
- Анализ портфеля: подробный с таблицами
- Рекомендации: всегда с рисками и альтернативами
- При ответе на "что делать" — давай конкретный план действий с точными цифрами`;

type Msg = { role: "system" | "user" | "assistant"; content: string };

export async function GET(req: Request) {
  const url = new URL(req.url);
  const clear = url.searchParams.get("clear");
  if (clear === "true") {
    const { clearChatHistory: clearFn } = await import("@/lib/bot/store");
    await clearFn();
    return Response.json({ ok: true, messages: [] });
  }
  const messages = await getChatHistory(60);
  return Response.json({ messages });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { message?: string; mode?: string };
  const message = (body.message ?? "").trim();
  if (!message) return Response.json({ error: "message required" }, { status: 400 });

  const mode: TradingMode = body.mode === "live" ? "live" : "paper";
  const settings = await getSettings();

  // Сохраняем сообщение пользователя
  await addChatMessage("user", message);

  // Собираем контекст
  const history = await getChatHistory(40);
  const isFirstMessage = history.length <= 1;
  const [snapshot, whales, memory, mstats] = await Promise.all([
    getFullPortfolioSnapshot(mode),
    listWhales(),
    settings.aiMemoryEnabled ? buildMemoryBlock({}, 4000) : "",
    memoryStats(),
  ]);

  const systemWithContext = `${CHAT_SYSTEM_PROMPT}

## Текущее состояние системы в реальном времени
Портфель и киты:
\`\`\`json
${snapshot}
\`\`\`

Активные киты:
${whales.map((w) => `- ${w.name} (${w.category}) ${w.enabled ? "✅" : "⏸"}: ${w.notes || "без заметок"}`).join("\n")}

В памяти ${mstats.total} записей.${memory}

## Правила ведения диалога:
- Ты ведешь постоянный живой диалог с пользователем.
${isFirstMessage ? "- Это первое сообщение в диалоге: коротко поздоровайся и представься." : "- Диалог уже идет! КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО здороваться («Привет!», «Здравствуйте») и заново представляться («Я Вася...»). Сразу отвечай на вопрос пользователя по существу."}
- Держи контекст предыдущих реплик пользователя и своих прошлых ответов.`;

  // Собираем все сообщения для API (history уже содержит только что добавленное сообщение пользователя)
  const apiMessages: Msg[] = [
    { role: "system", content: systemWithContext },
    ...history.slice(-30).map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  ];

  try {
    const aiSettings = {
      aiApiUrl: settings.aiApiUrl,
      aiApiKey: settings.aiApiKey,
      aiModel: settings.aiModel,
      aiSystemPrompt: CHAT_SYSTEM_PROMPT,
      aiTemperature: Math.max(settings.aiTemperature, 0.3),
      aiTimeoutMs: 60_000,
    };

    const { content } = await chatCompletion(aiSettings, apiMessages);
    const cleaned = await extractRememberTags(content);
    await addChatMessage("assistant", cleaned);

    return Response.json({ ok: true, reply: cleaned });
  } catch (err) {
    const errorMsg = `⚠️ Ошибка ИИ: ${(err as Error).message}. Проверьте настройки API ключа и URL на странице «Настройки» → ИИ.`;
    await addChatMessage("assistant", errorMsg);
    return Response.json({ ok: false, reply: errorMsg });
  }
}
