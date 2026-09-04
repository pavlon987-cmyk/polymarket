#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════════════════
 *  POLYMARKET COPY-TRADER — CLI-обёртка над веб-сервером
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  Вся логика теперь живёт в Next.js-приложении (src/lib/bot/*) и хранится в
 *  PostgreSQL. Этот скрипт просто дёргает API запущенного сервера.
 *
 *    node scripts/copytrader.mjs            — включить авто-цикл на сервере и стримить статус
 *    node scripts/copytrader.mjs once       — выполнить один цикл
 *    node scripts/copytrader.mjs status     — показать портфель
 *    node scripts/copytrader.mjs whales     — найти активных трейдеров
 *    node scripts/copytrader.mjs reset      — сбросить портфель (paper)
 *    node scripts/copytrader.mjs stop       — выключить авто-цикл
 *
 *  Адрес сервера: BASE_URL (по умолчанию http://localhost:3000)
 */

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
const cents = (p) => `${(Number(p) * 100).toFixed(0)}¢`;
const short = (s, n = 45) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");

async function call(path, init) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status} ${path}`);
  return data;
}

async function status() {
  const s = await call("/api/bot/status");
  const p = s.portfolio;
  const pct = ((p.equity - p.startingBankUsd) / p.startingBankUsd) * 100;
  console.log("═".repeat(80));
  console.log(`📅 ${new Date().toLocaleString("ru-RU")}  режим: ${s.mode.toUpperCase()}${p.halted ? "   🚨 HALTED" : ""}  авто-цикл: ${s.runner.running ? "ВКЛ" : "ВЫКЛ"}`);
  console.log(`💰 Кэш: ${usd(p.cashUsd)} | В позициях: ${usd(p.inPositions)} | Эквити: ${usd(p.equity)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%) | Реализ. P&L: ${usd(p.realizedPnlUsd)}`);
  console.log("═".repeat(80));
  if (s.open.length) {
    console.log("\n📂 ОТКРЫТЫЕ ПОЗИЦИИ");
    console.table(s.open.map((x) => ({ Рынок: short(x.market), Исход: x.outcome, Вход: cents(x.price), Сейчас: cents(x.lastPrice ?? x.price), Ставка: usd(x.costUsd), "Нереализ.": usd(x.shares * (x.lastPrice ?? x.price) - x.costUsd), Кит: short(x.whaleName, 22) })));
  }
  if (s.closed.length) {
    console.log("\n📁 ЗАКРЫТЫЕ (последние 15)");
    console.table(s.closed.slice(0, 15).map((x) => ({ Рынок: short(x.market), Исход: x.outcome, Вход: cents(x.price), Статус: x.status, Ставка: usd(x.costUsd), "P&L": usd(x.profitUsd) })));
  }
  console.log(`\n🌐 Дашборд: ${BASE}\n`);
}

async function once() {
  console.log("▶ Запускаю цикл…");
  const r = await call("/api/bot/run", { method: "POST" });
  for (const n of r.notes ?? []) console.log(n);
  console.log(`\n${r.ok ? "✅" : "❌"} закрыто ${r.closed}, открыто ${r.opened}, продано ${r.sold}${r.error ? ` — ${r.error}` : ""}`);
}

async function whales() {
  console.log("🔍 Ищу активных трейдеров…");
  const r = await call("/api/whales/discover?limit=500");
  console.table(r.candidates.map((c) => ({ Адрес: c.wallet, Имя: short(c.name, 18), Сделок: c.trades, "Объём $": c.volumeUsd.toFixed(0), "BUY %": (c.buyRatio * 100).toFixed(0), Пример: short(c.markets[0], 35) })));
  if (r.messages?.length) console.log("⚠️ ", r.messages.join("\n   "));
  console.log(`Добавить кита: ${BASE}/whales\n`);
  const w = await call("/api/whales");
  console.log("Проверка текущих китов:");
  for (const x of w.whales) {
    const c = await call(`/api/whales/${x.id}`);
    console.log(`  ${c.count ? "✅" : "❌"} ${x.name}: сделок ${c.count}, последняя: ${c.lastTradeAt ? new Date(c.lastTradeAt).toLocaleString("ru-RU") : "—"}`);
  }
}

async function run() {
  await call("/api/bot/loop", { method: "POST", body: JSON.stringify({ action: "start" }) });
  console.log(`🚀 Авто-цикл включён на сервере ${BASE}. Ctrl+C — выйти (бот продолжит работать; остановить: npm run copytrader -- stop)\n`);
  for (;;) {
    try { await status(); } catch (e) { console.log("⚠️ ", e.message); }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

const cmd = (process.argv[2] ?? "run").toLowerCase();
try {
  switch (cmd) {
    case "status": await status(); break;
    case "once": await once(); break;
    case "whales": await whales(); break;
    case "reset": await call("/api/bot/reset", { method: "POST", body: JSON.stringify({ mode: process.argv[3] ?? "paper" }) }); console.log("🗑️  Портфель сброшен"); break;
    case "stop": await call("/api/bot/loop", { method: "POST", body: JSON.stringify({ action: "stop" }) }); console.log("⏹ Авто-цикл выключен"); break;
    case "run": await run(); break;
    default: console.log(`Неизвестная команда "${cmd}". Доступно: run | once | status | whales | reset | stop`); process.exit(1);
  }
} catch (err) {
  console.error(`❌ ${err.message}\n   Сервер запущен? (${BASE})  →  npm run dev  или  npm run build && npm start`);
  process.exit(1);
}
