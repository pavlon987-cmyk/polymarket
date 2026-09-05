/**
 * РЕАЛЬНОЕ ВРЕМЯ.
 *
 * 1) CLOB WebSocket (market-канал): цены по всем токенам открытых позиций обновляются
 *    мгновенно, а не раз в 2 минуты. Дополнительно — user-канал в live-режиме: подтверждения
 *    ордеров и фактические исполнения (fills) пишутся в live_fills.
 * 2) Внутренняя шина событий → SSE (/api/stream) → дашборд и чат Васи без перезагрузки.
 *
 * Документация: https://docs.polymarket.com/developers/CLOB/websocket/wss-overview
 *   wss://ws-subscriptions-clob.polymarket.com/ws/market   { assets_ids: [...], type: "market" }
 *   wss://ws-subscriptions-clob.polymarket.com/ws/user     { auth: {apiKey, secret, passphrase}, markets: [...], type: "user" }
 */
import { EventEmitter } from "node:events";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { positions } from "@/db/schema";
import { and, eq } from "drizzle-orm";

type WsLike = { send(d: string): void; close(): void; readyState: number; on(ev: string, cb: (...a: unknown[]) => void): void };

export type RealtimeEvent =
  | { type: "price"; data: { tokenId: string; price: number; positionId?: number } }
  | { type: "book"; data: { tokenId: string; bestBid: number; bestAsk: number; spread: number } }
  | { type: "position"; data: { action: "opened" | "closed"; position: unknown } }
  | { type: "cycle"; data: unknown }
  | { type: "fill"; data: unknown }
  | { type: "log"; data: { level: string; message: string } }
  | { type: "chat"; data: { role: string; content: string; tool?: string } };

class Realtime extends EventEmitter {
  private ws: WsLike | null = null;
  private userWs: WsLike | null = null;
  private subscribed = new Set<string>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastPrices = new Map<string, number>();
  public wsUrl = process.env.POLYMARKET_WS_URL ?? "wss://ws-subscriptions-clob.polymarket.com/ws";

  publish<T extends RealtimeEvent["type"]>(type: T, data: Extract<RealtimeEvent, { type: T }>["data"]) {
    this.emit("event", { type, data, ts: Date.now() });
  }

  price(tokenId: string) {
    return this.lastPrices.get(tokenId) ?? null;
  }

  /** Подписаться на токен (вызывается при открытии позиции и при старте) */
  subscribeToken(tokenId: string) {
    if (!tokenId || this.subscribed.has(tokenId)) return;
    this.subscribed.add(tokenId);
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ assets_ids: [tokenId], type: "market", operation: "subscribe" }));
    }
  }

  /** Старт: подписка на все открытые позиции (paper + live) */
  async start() {
    if (this.ws) return;
    const rows = await db.select({ tokenId: positions.tokenId }).from(positions).where(eq(positions.status, "OPEN"));
    for (const r of rows) this.subscribed.add(r.tokenId);
    await this.connectMarket();
    this.pingTimer = setInterval(() => this.ws?.readyState === 1 && this.ws.send("PING"), 10_000);
    this.pingTimer.unref?.();
  }

  private async connectMarket() {
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`${this.wsUrl}/market`) as unknown as WsLike;
    this.ws = ws;
    ws.on("open", () => {
      if (this.subscribed.size) ws.send(JSON.stringify({ assets_ids: [...this.subscribed], type: "market" }));
      this.publish("log", { level: "info", message: `📡 WS market подключён (${this.subscribed.size} токенов)` });
    });
    ws.on("message", (raw: unknown) => this.onMarketMessage(String(raw)));
    ws.on("close", () => this.scheduleReconnect());
    ws.on("error", () => this.scheduleReconnect());
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.ws = null;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectMarket();
    }, 5_000);
    this.reconnectTimer.unref?.();
  }

  private onMarketMessage(raw: string) {
    if (raw === "PONG") return;
    let msgs: unknown;
    try {
      msgs = JSON.parse(raw);
    } catch {
      return;
    }
    for (const m of Array.isArray(msgs) ? msgs : [msgs]) {
      const ev = m as Record<string, unknown>;
      const tokenId = String(ev.asset_id ?? "");
      if (ev.event_type === "book" && Array.isArray(ev.bids) && Array.isArray(ev.asks)) {
        const bestBid = Math.max(0, ...(ev.bids as { price: string }[]).map((b) => Number(b.price)));
        const bestAsk = Math.min(1, ...(ev.asks as { price: string }[]).map((a) => Number(a.price)));
        if (bestBid > 0 && bestAsk < 1) {
          const mid = (bestBid + bestAsk) / 2;
          this.lastPrices.set(tokenId, mid);
          this.publish("book", { tokenId, bestBid, bestAsk, spread: bestAsk - bestBid });
          this.publish("price", { tokenId, price: mid });
          void this.persistPrice(tokenId, mid);
        }
      } else if (ev.event_type === "price_change" && Array.isArray(ev.changes)) {
        for (const c of ev.changes as { asset_id: string; price: string; best_bid?: string; best_ask?: string }[]) {
          const bb = Number(c.best_bid), ba = Number(c.best_ask);
          const mid = Number.isFinite(bb) && Number.isFinite(ba) && bb > 0 ? (bb + ba) / 2 : Number(c.price);
          if (!Number.isFinite(mid)) continue;
          this.lastPrices.set(c.asset_id, mid);
          this.publish("price", { tokenId: c.asset_id, price: mid });
          void this.persistPrice(c.asset_id, mid);
        }
      } else if (ev.event_type === "last_trade_price") {
        const p = Number(ev.price);
        if (Number.isFinite(p)) {
          this.lastPrices.set(tokenId, p);
          this.publish("price", { tokenId, price: p });
        }
      }
    }
  }

  private persistTimers = new Map<string, NodeJS.Timeout>();
  /** lastPrice в БД обновляем не чаще раза в 3 с на токен (дебаунс) */
  private persistPrice(tokenId: string, price: number) {
    if (this.persistTimers.has(tokenId)) return;
    const t = setTimeout(async () => {
      this.persistTimers.delete(tokenId);
      await db.update(positions).set({ lastPrice: price, updatedAt: new Date() }).where(and(eq(positions.tokenId, tokenId), eq(positions.status, "OPEN"))).catch(() => {});
    }, 3_000);
    t.unref?.();
    this.persistTimers.set(tokenId, t);
  }

  /** User-канал (live): подтверждения ордеров и исполнения */
  async startUserChannel(creds: { key: string; secret: string; passphrase: string }, conditionIds: string[]) {
    if (this.userWs) return;
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`${this.wsUrl}/user`) as unknown as WsLike;
    this.userWs = ws;
    ws.on("open", () => ws.send(JSON.stringify({ auth: { apiKey: creds.key, secret: creds.secret, passphrase: creds.passphrase }, markets: conditionIds, type: "user" })));
    ws.on("message", async (raw: unknown) => {
      try {
        const ev = JSON.parse(String(raw)) as Record<string, unknown>;
        if (ev.event_type === "trade") {
          await db.execute(sql`insert into live_fills (order_id, trade_id, token_id, side, price, size, status, raw)
            values (${String(ev.taker_order_id ?? "")}, ${String(ev.id ?? "")}, ${String(ev.asset_id ?? "")}, ${String(ev.side ?? "")}, ${Number(ev.price ?? 0)}, ${Number(ev.size ?? 0)}, ${String(ev.status ?? "")}, ${JSON.stringify(ev)}::jsonb)
            on conflict (trade_id) do update set status = excluded.status, raw = excluded.raw`);
        }
        this.publish("fill", ev);
      } catch {
        /* ignore */
      }
    });
    ws.on("close", () => (this.userWs = null));
  }
}

const g = globalThis as typeof globalThis & { __pmRealtime?: Realtime };
export const realtime: Realtime = g.__pmRealtime ?? (g.__pmRealtime = new Realtime());
