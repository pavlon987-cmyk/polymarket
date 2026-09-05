import { runCycle, isCycleRunning } from "./engine";
import { addLog, getSettings, updateSettings } from "./store";
import type { CycleResult } from "./types";
import { startRiskWorker, stopRiskWorker } from "./risk-worker";

type RunnerState = {
  running: boolean;
  timer: NodeJS.Timeout | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastResult: CycleResult | null;
  startedAt: string | null;
};

const g = globalThis as typeof globalThis & { __copytraderRunner?: RunnerState };
function state(): RunnerState {
  if (!g.__copytraderRunner) {
    g.__copytraderRunner = { running: false, timer: null, lastRunAt: null, nextRunAt: null, lastResult: null, startedAt: null };
  }
  return g.__copytraderRunner;
}

export function getRunnerState() {
  const s = state();
  return {
    running: s.running,
    cycleInProgress: isCycleRunning(),
    lastRunAt: s.lastRunAt,
    nextRunAt: s.nextRunAt,
    startedAt: s.startedAt,
    lastResult: s.lastResult,
  };
}

async function tick() {
  const s = state();
  if (!s.running) return;
  s.lastRunAt = new Date().toISOString();
  try {
    s.lastResult = await runCycle("auto");
  } catch (err) {
    await addLog("error", `Раннер: ${(err as Error).message}`);
  }
  if (!s.running) return;
  const settings = await getSettings().catch(() => null);
  const intervalMs = Math.max(30, settings?.checkIntervalSec ?? 120) * 1000;
  s.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
  s.timer = setTimeout(() => void tick(), intervalMs);
  s.timer.unref?.();
}

export async function startLoop(persist = true, initialDelayMs = 0) {
  const s = state();
  if (s.running) return getRunnerState();
  s.running = true;
  s.startedAt = new Date().toISOString();
  s.nextRunAt = new Date(Date.now() + initialDelayMs).toISOString();
  if (persist) await updateSettings({ autorun: true });
  await addLog("info", "🟢 Авто-цикл запущен");
  startRiskWorker();
  s.timer = setTimeout(() => void tick(), initialDelayMs);
  s.timer.unref?.();
  return getRunnerState();
}

export async function stopLoop(persist = true) {
  const s = state();
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
  s.running = false;
  s.nextRunAt = null;
  stopRiskWorker();
  if (persist) await updateSettings({ autorun: false });
  await addLog("info", "⏹ Авто-цикл остановлен");
  return getRunnerState();
}

/** Вызывается при старте сервера (instrumentation.ts) */
export async function bootAutorun() {
  try {
    const settings = await getSettings();
    if (settings.autorun && !state().running) {
      await startLoop(false, 8_000);
    }
  } catch (err) {
    console.error("bootAutorun:", (err as Error).message);
  }
}
