export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  try {
    const { bootAutorun } = await import("@/lib/bot/runner");
    // даём БД подняться, затем восстанавливаем авто-цикл, если он был включён
    setTimeout(() => void bootAutorun(), 3_000).unref?.();
  } catch (err) {
    console.error("instrumentation:", (err as Error).message);
  }
}
