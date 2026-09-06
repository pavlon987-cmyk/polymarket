
import { db } from "@/db";
import { newsEvents } from "@/db/schema";
import { getSettings } from "./store";

type NormalizedNews = {
  source: string;
  sourceEventId?: string;
  title: string;
  url?: string;
  symbols: string[];
  publishedAt: Date;
  direction: "up" | "down" | "neutral";
  materiality: number;
  summary: string;
  rawPayload: Record<string, unknown>;
};

function scoreNewsHeuristic(title: string): { direction: "up" | "down" | "neutral"; materiality: number } {
  const lower = title.toLowerCase();

  const upWords = ["approval", "adoption", "partnership", "etf inflow", "upgrade", "surge"];
  const downWords = ["hack", "exploit", "lawsuit", "ban", "liquidation", "outage", "drop"];

  const upHit = upWords.some((word) => lower.includes(word));
  const downHit = downWords.some((word) => lower.includes(word));

  if (upHit && !downHit) return { direction: "up", materiality: 70 };
  if (downHit && !upHit) return { direction: "down", materiality: 70 };
  if (upHit && downHit) return { direction: "neutral", materiality: 40 };

  return { direction: "neutral", materiality: 20 };
}

export async function fetchAndNormalizeNews(): Promise<NormalizedNews[]> {
  const out: NormalizedNews[] = [];
  const settings = await getSettings().catch(() => null);
  const cpToken = process.env.CRYPTOPANIC_TOKEN || settings?.cryptoPanicToken;
  const newsApiKey = process.env.NEWSAPI_KEY || settings?.newsApiKey;

  if (cpToken) {
    const url = `https://cryptopanic.com/api/free/v1/posts/?auth_token=${cpToken}&public=true`;
    const response = await fetch(url, { cache: "no-store" }).catch(() => null);

    if (response?.ok) {
      const payload = (await response.json()) as { results?: Array<{ id?: number; title?: string; url?: string; published_at?: string; currencies?: Array<{ code?: string }> }> };
      for (const item of payload.results ?? []) {
        const title = item.title ?? "";
        const scored = scoreNewsHeuristic(title);
        out.push({
          source: "cryptopanic",
          sourceEventId: item.id ? String(item.id) : undefined,
          title,
          url: item.url,
          symbols: (item.currencies ?? []).map((x) => x.code ?? "").filter(Boolean),
          publishedAt: item.published_at ? new Date(item.published_at) : new Date(),
          direction: scored.direction,
          materiality: scored.materiality,
          summary: title,
          rawPayload: item as unknown as Record<string, unknown>,
        });
      }
    }
  }

  if (newsApiKey) {
    const url = `https://newsapi.org/v2/everything?q=(bitcoin OR ethereum OR solana)&sortBy=publishedAt&pageSize=20&apiKey=${newsApiKey}`;
    const response = await fetch(url, { cache: "no-store" }).catch(() => null);

    if (response?.ok) {
      const payload = (await response.json()) as { articles?: Array<{ title?: string; url?: string; publishedAt?: string; source?: { name?: string } }> };
      for (const item of payload.articles ?? []) {
        const title = item.title ?? "";
        const scored = scoreNewsHeuristic(title);
        out.push({
          source: item.source?.name ? `newsapi:${item.source.name}` : "newsapi",
          title,
          url: item.url,
          symbols: ["BTC", "ETH", "SOL"],
          publishedAt: item.publishedAt ? new Date(item.publishedAt) : new Date(),
          direction: scored.direction,
          materiality: scored.materiality,
          summary: title,
          rawPayload: item as unknown as Record<string, unknown>,
        });
      }
    }
  }

  return out;
}

export async function persistNewsEvents(events: NormalizedNews[]) {
  if (!events.length) {
    return { inserted: 0 };
  }

  await db.insert(newsEvents).values(
    events.map((item) => ({
      source: item.source,
      sourceEventId: item.sourceEventId,
      title: item.title,
      url: item.url,
      symbols: item.symbols,
      publishedAt: item.publishedAt,
      direction: item.direction,
      materiality: item.materiality,
      summary: item.summary,
      rawPayload: item.rawPayload,
    })),
  );

  return { inserted: events.length };
}

import { desc, gte } from "drizzle-orm";

export async function getRecentNews(lookbackSeconds: number = 86400) {
  try {
    const since = new Date(Date.now() - lookbackSeconds * 1000);
    const rows = await db
      .select()
      .from(newsEvents)
      .where(gte(newsEvents.publishedAt, since))
      .orderBy(desc(newsEvents.publishedAt))
      .limit(30);
    if (rows.length > 0) return rows;
    return await db
      .select()
      .from(newsEvents)
      .orderBy(desc(newsEvents.publishedAt))
      .limit(20);
  } catch {
    return [];
  }
}
