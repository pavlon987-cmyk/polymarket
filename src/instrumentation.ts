/**
 * instrumentation.ts — запускается Next.js при старте сервера.
 * Защита от двойного запуска (dev-режим перезагружает модули, edge-runtime тоже вызывает register()).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const g = globalThis as typeof globalThis & { __pmBooted?: boolean };
  if (g.__pmBooted) return;
  g.__pmBooted = true;

  const { bootAutorun } = await import("./lib/bot/runner");
  const { realtime } = await import("./lib/bot/realtime");
  const { reconcilePortfolio } = await import("./lib/bot/ledger");
  const { getSettings } = await import("./lib/bot/store");

  try {
    const s = await getSettings();
    // 1) сверка леджера при старте — любые «деньги из воздуха» видны сразу в журнале
    await reconcilePortfolio("paper").catch(() => {});
    if (s.tradingMode === "live") await reconcilePortfolio("live").catch(() => {});
    // 2) WebSocket цен по открытым позициям
    if (s.wsEnabled !== false) await realtime.start().catch((e) => console.error("realtime:", e));
    // 3) авто-цикл, если был включён
    await bootAutorun();
  } catch (err) {
    console.error("instrumentation:", (err as Error).message);
  }
}
