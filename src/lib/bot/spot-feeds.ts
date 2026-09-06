import { EventEmitter } from "node:events";

import Bottleneck from "bottleneck";
import WebSocket, { type RawData } from "ws";

type SpotTick = {
  venue: "binance" | "bybit";
  symbol: string;
  price: number;
  ts: number;
};

type FeedOptions = {
  symbol: string;
  heartbeatMs: number;
};

class BaseSpotFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private limiter = new Bottleneck({ minTime: 25 });

  constructor(
    private readonly venue: "binance" | "bybit",
    private readonly urlBuilder: (symbol: string) => string,
    private readonly parser: (raw: string) => number | null,
    private readonly options: FeedOptions,
  ) {
    super();
  }

  start() {
    const url = this.urlBuilder(this.options.symbol);
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.emit("status", { venue: this.venue, status: "connected" });
      this.startHeartbeat();

      if (this.venue === "bybit" && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            op: "subscribe",
            args: [`tickers.${this.options.symbol}`],
          }),
        );
      }
    });

    this.ws.on("message", (payload: RawData) => {
      void this.limiter.schedule(async () => {
        const raw = payload.toString();
        const price = this.parser(raw);
        if (price === null) return;

        const tick: SpotTick = {
          venue: this.venue,
          symbol: this.options.symbol,
          price,
          ts: Date.now(),
        };

        this.emit("tick", tick);
      });
    });

    this.ws.on("close", () => {
      this.emit("status", { venue: this.venue, status: "disconnected" });
      this.stopHeartbeat();
      this.scheduleReconnect();
    });

    this.ws.on("error", (error: Error) => {
      this.emit("status", {
        venue: this.venue,
        status: "error",
        message: error.message,
      });
      this.ws?.close();
    });
  }

  stop() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, this.options.heartbeatMs);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, 1500);
  }
}

export class SpotPriceAggregator {
  private lastTicks = new Map<string, SpotTick>();

  readonly binance: BaseSpotFeed;
  readonly bybit: BaseSpotFeed;

  constructor(symbol = "btcusdt") {
    this.binance = new BaseSpotFeed(
      "binance",
      (pair) => `${process.env.BINANCE_WS ?? "wss://stream.binance.com:9443/ws"}/${pair}@trade`,
      (raw) => {
        const msg = JSON.parse(raw) as { p?: string };
        const value = Number(msg.p);
        return Number.isFinite(value) ? value : null;
      },
      { symbol, heartbeatMs: 12_000 },
    );

    this.bybit = new BaseSpotFeed(
      "bybit",
      () => process.env.BYBIT_WS ?? "wss://stream.bybit.com/v5/public/spot",
      (raw) => {
        const msg = JSON.parse(raw) as { data?: { lastPrice?: string } | Array<{ lastPrice?: string }> };

        if (Array.isArray(msg.data)) {
          const value = Number(msg.data[0]?.lastPrice);
          return Number.isFinite(value) ? value : null;
        }

        const value = Number(msg.data?.lastPrice);
        return Number.isFinite(value) ? value : null;
      },
      { symbol: symbol.toUpperCase(), heartbeatMs: 12_000 },
    );

    const onTick = (tick: SpotTick) => {
      this.lastTicks.set(tick.venue, tick);
    };

    this.binance.on("tick", onTick);
    this.bybit.on("tick", onTick);

    this.binance.start();
    this.bybit.start();
  }

  getSnapshot() {
    const binance = this.lastTicks.get("binance");
    const bybit = this.lastTicks.get("bybit");

    const primary = binance ?? bybit;
    const fallback = bybit ?? binance;

    if (!primary) {
      return {
        ok: false,
        reason: "no-ticks",
      };
    }

    const divergenceBps = fallback
      ? Math.abs(((primary.price - fallback.price) / primary.price) * 10_000)
      : 0;

    return {
      ok: true,
      price: primary.price,
      primaryVenue: primary.venue,
      fallbackVenue: fallback?.venue,
      divergenceBps,
      isDivergenceHigh: divergenceBps > 25,
      ts: primary.ts,
    };
  }

  async getSnapshotOrWait(maxWaitMs = 1500) {
    const snap = this.getSnapshot();
    if (snap.ok) return snap;

    return new Promise<ReturnType<SpotPriceAggregator["getSnapshot"]>>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(this.getSnapshot());
      }, maxWaitMs);

      const onTick = () => {
        const s = this.getSnapshot();
        if (s.ok) {
          cleanup();
          resolve(s);
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.binance.off("tick", onTick);
        this.bybit.off("tick", onTick);
      };

      this.binance.on("tick", onTick);
      this.bybit.on("tick", onTick);
    });
  }
}


const globalAggregators = globalThis as typeof globalThis & {
  __spotBtcAggregator?: SpotPriceAggregator;
  __spotEthAggregator?: SpotPriceAggregator;
  __spotSolAggregator?: SpotPriceAggregator;
};

export function getSpotAggregator(asset: string = 'BTC'): SpotPriceAggregator {
  const norm = asset.toUpperCase();
  if (norm === 'ETH') {
    return (globalAggregators.__spotEthAggregator ??= new SpotPriceAggregator('ethusdt'));
  }
  if (norm === 'SOL') {
    return (globalAggregators.__spotSolAggregator ??= new SpotPriceAggregator('solusdt'));
  }
  return (globalAggregators.__spotBtcAggregator ??= new SpotPriceAggregator('btcusdt'));
}
