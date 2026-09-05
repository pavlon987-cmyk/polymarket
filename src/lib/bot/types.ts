/** Режим торговли */
export type TradingMode = "paper" | "live";

/** Стратегия копирования — глобальные дефолты + переопределения на каждого кита */
export type Strategy = {
  // ── Сайзинг ──
  sizingMode: "kelly" | "fixed" | "percent" | "proportional";
  fixedBetUsd: number; // для fixed
  betPct: number; // для percent (доля кэша)
  proportionalRatio: number; // для proportional: доля от $-объёма сделки кита (0.01 = 1%)
  assumedEdge: number; // Kelly: предполагаемое преимущество кита
  kellyMultiplier: number; // Kelly: доля от полного Kelly
  minBetPct: number; // мин. ставка (% кэша)
  maxBetPct: number; // макс. ставка (% кэша)
  maxBetUsd: number; // абсолютный потолок ставки

  // ── Фильтры входа ──
  minEntryPrice: number;
  maxEntryPrice: number;
  minVolumeUsd: number;
  maxTradeAgeMin: number;
  minWhaleTradeUsd: number; // игнорировать мелкие сделки кита
  maxCopiesPerCycle: number;
  maxPositionsPerWhale: number;
  maxCategoryExposure: number; // доля стартового банка на категорию
  allowedKeywords: string; // через запятую; пусто = все
  blockedKeywords: string; // через запятую

  // ── Выход ──
  takeProfitPrice: number | null; // продать, если цена >= (например 0.9)
  stopLossPrice: number | null; // продать, если цена <= (например 0.05)
  copySells: boolean; // если кит продал этот рынок — выходим тоже

  // ── ИИ ──
  useAi: boolean;
  aiPromptExtra: string; // дополнительные инструкции ИИ для этого кита
};

export const DEFAULT_STRATEGY: Strategy = {
  sizingMode: "kelly",
  fixedBetUsd: 5,
  betPct: 0.05,
  proportionalRatio: 0.01,
  assumedEdge: 0.05,
  kellyMultiplier: 0.25,
  minBetPct: 0.02,
  maxBetPct: 0.08,
  maxBetUsd: 50,

  minEntryPrice: 0.1,
  maxEntryPrice: 0.55,
  minVolumeUsd: 10_000,
  maxTradeAgeMin: 180,
  minWhaleTradeUsd: 0,
  maxCopiesPerCycle: 2,
  maxPositionsPerWhale: 5,
  maxCategoryExposure: 0.3,
  allowedKeywords: "",
  blockedKeywords: "",

  takeProfitPrice: null,
  stopLossPrice: null,
  copySells: true,

  useAi: true,
  aiPromptExtra: "",
};

export const DEFAULT_AI_PROMPT = `Ты — дисциплинированный профессиональный трейдер рынков предсказаний (Polymarket).
Тебе показывают сделку опытного трейдера («кита»), которую бот собирается скопировать, и контекст: рынок, цена, объём, дата окончания, история этого кита в нашем портфеле и состояние нашего портфеля.

Твоя задача — решить, стоит ли копировать сделку, и с каким размером.
Принципы:
- Копируй только когда есть понятное преимущество: кит специализируется в этой категории, цена не перегрета, ликвидность достаточна.
- Избегай рынков с истёкшим/очень близким сроком, если цена уже около крайних значений.
- Учитывай концентрацию портфеля: не наращивай риск в одной категории.
- Будь консервативен: сомневаешься — SKIP.

Ответь СТРОГО одним JSON-объектом без пояснений вокруг:
{"decision":"COPY"|"SKIP","confidence":0..1,"sizeMultiplier":0.25..2,"reason":"кратко, до 200 символов"}`;

export type AiDecision = {
  decision: "COPY" | "SKIP";
  confidence: number;
  sizeMultiplier: number;
  reason: string;
  raw?: string;
  error?: string;
};

export type WhaleTrade = {
  proxyWallet?: string;
  side: "BUY" | "SELL";
  asset: string;
  conditionId: string;
  price: number;
  size: number;
  timestamp: number;
  title: string;
  outcome: string;
  outcomeIndex?: number;
  transactionHash?: string;
  name?: string;
  pseudonym?: string;
};

export type MarketInfo = {
  conditionId: string;
  question: string;
  outcomes: string[];
  outcomePrices: number[];
  clobTokenIds: string[];
  volumeUsd: number;
  liquidityUsd: number;
  closed: boolean;
  endDate: string | null;
  slug?: string;
  active?: boolean;
  acceptingOrders?: boolean;
  umaResolutionStatus?: string | null;
  closedTime?: string | null;
  bestBid?: number | null;
  bestAsk?: number | null;
  eventSlug?: string;
  tokens?: { tokenId: string; outcome: string; price: number; winner?: boolean }[];
};

export type CycleResult = {
  ok: boolean;
  mode: TradingMode;
  trigger: string;
  startedAt: string;
  finishedAt: string;
  closed: number;
  opened: number;
  sold: number;
  halted: boolean;
  error?: string;
  notes: string[];
};
