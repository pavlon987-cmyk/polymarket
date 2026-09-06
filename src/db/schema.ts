import { boolean, doublePrecision, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { AiDecision, Strategy } from "@/lib/bot/types";
import { DEFAULT_AI_PROMPT, DEFAULT_STRATEGY } from "@/lib/bot/types";

/** Глобальные настройки (одна строка, id = 1) */
export const settings = pgTable("settings", {
  id: integer("id").primaryKey().default(1),

  // режим
  tradingMode: text("trading_mode").notNull().default("paper"), // paper | live
  liveArmed: boolean("live_armed").notNull().default(false),
  autorun: boolean("autorun").notNull().default(false),
  checkIntervalSec: integer("check_interval_sec").notNull().default(120),
  requestDelayMs: integer("request_delay_ms").notNull().default(1200),

  // банк / риск
  paperStartingBankUsd: doublePrecision("paper_starting_bank_usd").notNull().default(100),
  liveMaxBankUsd: doublePrecision("live_max_bank_usd").notNull().default(50),
  stopLossPercent: doublePrecision("stop_loss_percent").notNull().default(0.2),
  maxOpenPositions: integer("max_open_positions").notNull().default(10),
  defaultStrategy: jsonb("default_strategy").$type<Strategy>().notNull().default(DEFAULT_STRATEGY),
  maxDaysToEnd: integer("max_days_to_end").notNull().default(30),
  minHoursToEnd: integer("min_hours_to_end").notNull().default(6),
  aiAutoCut: boolean("ai_auto_cut").notNull().default(false),
  aiAutoHedge: boolean("ai_auto_hedge").notNull().default(false),
  paperFeeBps: integer("paper_fee_bps").notNull().default(0),
  wsEnabled: boolean("ws_enabled").notNull().default(true),
  maxSlippageCents: integer("max_slippage_cents").notNull().default(3),

  // сеть / API
  dataApiUrl: text("data_api_url").notNull().default("https://data-api.polymarket.com"),
  gammaApiUrl: text("gamma_api_url").notNull().default("https://gamma-api.polymarket.com"),
  clobApiUrl: text("clob_api_url").notNull().default("https://clob.polymarket.com"),
  httpProxyUrl: text("http_proxy_url").notNull().default(""),
  extraHeadersJson: text("extra_headers_json").notNull().default(""),

  // ИИ
  aiEnabled: boolean("ai_enabled").notNull().default(false),
  aiApiUrl: text("ai_api_url").notNull().default("https://api.openai.com/v1/chat/completions"),
  aiApiKey: text("ai_api_key").notNull().default(""),
  aiModel: text("ai_model").notNull().default("gpt-4o-mini"),
  aiSystemPrompt: text("ai_system_prompt").notNull().default(DEFAULT_AI_PROMPT),
  aiTemperature: doublePrecision("ai_temperature").notNull().default(0.2),
  aiMinConfidence: doublePrecision("ai_min_confidence").notNull().default(0.6),
  aiTimeoutMs: integer("ai_timeout_ms").notNull().default(30_000),

  // память и обучение Васи
  aiMemoryEnabled: boolean("ai_memory_enabled").notNull().default(true),
  aiReflectEnabled: boolean("ai_reflect_enabled").notNull().default(true),
  aiObserveWhales: boolean("ai_observe_whales").notNull().default(true),
  aiMemoryMaxItems: integer("ai_memory_max_items").notNull().default(300),

  // уведомления
  telegramBotToken: text("telegram_bot_token").notNull().default(""),
  telegramChatId: text("telegram_chat_id").notNull().default(""),

  // верификация кошельков (используется авто-разведкой)
  walletVerifyEnabled: boolean("wallet_verify_enabled").notNull().default(true),
  walletMinScore: doublePrecision("wallet_min_score").notNull().default(60),
  walletMinTrades: integer("wallet_min_trades").notNull().default(20),
  walletMinWinRate: doublePrecision("wallet_min_win_rate").notNull().default(0.5),
  walletMinVolumeUsd: doublePrecision("wallet_min_volume_usd").notNull().default(5000),
  walletMaxDrawdownPct: doublePrecision("wallet_max_drawdown_pct").notNull().default(0.3),

  // внешние фиды и новости
  binanceFeedEnabled: boolean("binance_feed_enabled").notNull().default(true),
  bybitFeedEnabled: boolean("bybit_feed_enabled").notNull().default(true),
  cryptoPanicToken: text("crypto_panic_token").notNull().default(""),
  newsApiKey: text("news_api_key").notNull().default(""),
  kalshiApiKeyId: text("kalshi_api_key_id").notNull().default(""),
  kalshiPrivateKey: text("kalshi_private_key").notNull().default(""),
  kellyFraction: doublePrecision("kelly_fraction").notNull().default(0.25),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Киты и их персональные стратегии */
export const whales = pgTable("whales", {
  id: serial("id").primaryKey(),
  address: text("address").notNull().unique(),
  name: text("name").notNull(),
  category: text("category").notNull().default("Other"),
  enabled: boolean("enabled").notNull().default(true),
  strategy: jsonb("strategy").$type<Partial<Strategy>>().notNull().default({}),
  notes: text("notes").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Портфель на каждый режим (paper / live) */
export const portfolios = pgTable("portfolios", {
  mode: text("mode").primaryKey(),
  startingBankUsd: doublePrecision("starting_bank_usd").notNull(),
  cashUsd: doublePrecision("cash_usd").notNull(),
  realizedPnlUsd: doublePrecision("realized_pnl_usd").notNull().default(0),
  totalInvestedUsd: doublePrecision("total_invested_usd").notNull().default(0),
  halted: boolean("halted").notNull().default(false),
  cyclesRun: integer("cycles_run").notNull().default(0),
  lastCycleAt: timestamp("last_cycle_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).notNull().defaultNow(),
});

/** Все позиции — копирование и любые стратегии (поле source) */
export const positions = pgTable("positions", {
  id: serial("id").primaryKey(),
  mode: text("mode").notNull(),
  source: text("source").notNull().default("copy"), // copy | arb_yes_no | free_swim | momentum | ...
  whaleId: integer("whale_id"),
  whaleName: text("whale_name").notNull(),
  whaleAddress: text("whale_address").notNull().default(""),
  category: text("category").notNull().default("Other"),
  conditionId: text("condition_id").notNull(),
  tokenId: text("token_id").notNull(),
  market: text("market").notNull(),
  outcome: text("outcome").notNull(),
  outcomeIndex: integer("outcome_index").notNull().default(0),
  price: doublePrecision("price").notNull(),
  lastPrice: doublePrecision("last_price"),
  shares: doublePrecision("shares").notNull(),
  costUsd: doublePrecision("cost_usd").notNull(),
  status: text("status").notNull().default("OPEN"), // OPEN | WON | LOST | SOLD
  payoutUsd: doublePrecision("payout_usd"),
  profitUsd: doublePrecision("profit_usd"),
  closeReason: text("close_reason"),
  whaleTradeHash: text("whale_trade_hash"),
  whaleSizeShares: doublePrecision("whale_size_shares"),
  aiDecision: jsonb("ai_decision").$type<AiDecision | null>(),
  liveOrderId: text("live_order_id"),
  marketEndAt: timestamp("market_end_at", { withTimezone: true }),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
},
  (t) => [
    uniqueIndex("positions_one_open_per_token").on(t.mode, t.tokenId).where(sql`${t.status} = 'OPEN'`),
    index("positions_open_by_condition").on(t.mode, t.conditionId).where(sql`${t.status} = 'OPEN'`),
  ]
);

export const cashAdjustments = pgTable("cash_adjustments", {
  id: serial("id").primaryKey(),
  mode: text("mode").notNull(),
  amountUsd: doublePrecision("amount_usd").notNull(),
  reason: text("reason").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cycleLocks = pgTable("cycle_locks", {
  name: text("name").primaryKey(),
  lockedBy: text("locked_by").notNull(),
  lockedAt: timestamp("locked_at", { withTimezone: true }).notNull().defaultNow(),
});

export const liveFills = pgTable("live_fills", {
  id: serial("id").primaryKey(),
  orderId: text("order_id"),
  tradeId: text("trade_id").unique(),
  tokenId: text("token_id").notNull(),
  side: text("side").notNull(),
  price: doublePrecision("price").notNull(),
  size: doublePrecision("size").notNull(),
  status: text("status").notNull(),
  raw: jsonb("raw"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const seenTrades = pgTable("seen_trades", {
  hash: text("hash").primaryKey(),
  whaleId: integer("whale_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const botLogs = pgTable("bot_logs", {
  id: serial("id").primaryKey(),
  level: text("level").notNull().default("info"), // info | warn | error | trade
  message: text("message").notNull(),
  meta: jsonb("meta"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aiDecisions = pgTable("ai_decisions", {
  id: serial("id").primaryKey(),
  mode: text("mode").notNull(),
  whaleName: text("whale_name").notNull(),
  market: text("market").notNull(),
  outcome: text("outcome").notNull(),
  price: doublePrecision("price").notNull(),
  decision: text("decision").notNull(),
  confidence: doublePrecision("confidence").notNull().default(0),
  sizeMultiplier: doublePrecision("size_multiplier").notNull().default(1),
  reason: text("reason").notNull().default(""),
  applied: boolean("applied").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** История чата с Васей */
export const aiChatMessages = pgTable("ai_chat_messages", {
  id: serial("id").primaryKey(),
  role: text("role").notNull(), // user | assistant
  content: text("content").notNull(),
  meta: jsonb("meta"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Снимки цен (для импульса/контртренда/хеджа) */
export const marketSnapshots = pgTable("market_snapshots", {
  tokenId: text("token_id").primaryKey(),
  conditionId: text("condition_id").notNull().default(""),
  market: text("market").notNull().default(""),
  outcome: text("outcome").notNull().default(""),
  lastPrice: doublePrecision("last_price"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Верифицированные кошельки */
export const verifiedWallets = pgTable("verified_wallets", {
  id: serial("id").primaryKey(),
  address: text("address").notNull().unique(),
  name: text("name").notNull().default(""),
  score: doublePrecision("score").notNull().default(0),
  totalTrades: integer("total_trades").notNull().default(0),
  winRate: doublePrecision("win_rate").notNull().default(0),
  totalVolumeUsd: doublePrecision("total_volume_usd").notNull().default(0),
  avgTradeSizeUsd: doublePrecision("avg_trade_size_usd").notNull().default(0),
  avgPrice: doublePrecision("avg_price").notNull().default(0),
  profitableDays: integer("profitable_days").notNull().default(0),
  totalDays: integer("total_days").notNull().default(0),
  maxDrawdownPct: doublePrecision("max_drawdown_pct").notNull().default(0),
  verified: boolean("verified").notNull().default(false),
  category: text("category").notNull().default("General"),
  notes: text("notes").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Долговременная память Васи */
export const aiMemory = pgTable("ai_memory", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(), // lesson | whale_insight | observation | market_note | strategy_result | principle | user_note
  subject: text("subject").notNull().default(""),
  content: text("content").notNull(),
  importance: doublePrecision("importance").notNull().default(0.5),
  outcome: text("outcome"),
  pnlUsd: doublePrecision("pnl_usd"),
  meta: jsonb("meta"),
  usedCount: integer("used_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Конфиг каждой стратегии: кнопка вкл/выкл, бюджет, параметры */
export const strategyConfigs = pgTable("strategy_configs", {
  id: text("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  maxBetUsd: doublePrecision("max_bet_usd").notNull().default(10),
  maxPositions: integer("max_positions").notNull().default(3),
  params: jsonb("params").$type<Record<string, number | string | boolean>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** События новостей (CryptoPanic / NewsAPI) */
export const newsEvents = pgTable(
  "news_events",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(),
    sourceEventId: text("source_event_id"),
    title: text("title").notNull(),
    url: text("url"),
    symbols: jsonb("symbols").$type<string[]>().notNull().default([]),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
    direction: text("direction").notNull().default("neutral"),
    materiality: integer("materiality").notNull().default(0),
    summary: text("summary"),
    rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("news_events_published_at_idx").on(t.publishedAt),
    index("news_events_source_idx").on(t.source),
  ]
);

/** Связка рынков Polymarket и Kalshi для арбитража */
export const marketMapping = pgTable(
  "market_mapping",
  {
    id: serial("id").primaryKey(),
    eventKey: text("event_key").notNull().unique(),
    baseAsset: text("base_asset").notNull(),
    timeframe: text("timeframe").notNull(),
    polymarketMarketId: text("polymarket_market_id"),
    kalshiMarketId: text("kalshi_market_id"),
    strike: doublePrecision("strike"),
    settlementSource: text("settlement_source"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("market_mapping_event_key_unique").on(t.eventKey),
    index("market_mapping_base_asset_idx").on(t.baseAsset),
  ]
);

export type NewsEventRow = typeof newsEvents.$inferSelect;
export type MarketMappingRow = typeof marketMapping.$inferSelect;
export type Settings = typeof settings.$inferSelect;
export type Whale = typeof whales.$inferSelect;
export type PortfolioRow = typeof portfolios.$inferSelect;
export type PositionRow = typeof positions.$inferSelect;
export type BotLog = typeof botLogs.$inferSelect;
export type AiDecisionRow = typeof aiDecisions.$inferSelect;
export type AiChatMessage = typeof aiChatMessages.$inferSelect;
export type MarketSnapshot = typeof marketSnapshots.$inferSelect;
export type VerifiedWallet = typeof verifiedWallets.$inferSelect;
export type AiMemoryRow = typeof aiMemory.$inferSelect;
export type StrategyConfigRow = typeof strategyConfigs.$inferSelect;
export type CashAdjustment = typeof cashAdjustments.$inferSelect;
export type CycleLock = typeof cycleLocks.$inferSelect;
export type LiveFill = typeof liveFills.$inferSelect;
