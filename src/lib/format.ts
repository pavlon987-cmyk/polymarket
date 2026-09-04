export const usd = (n: number | null | undefined) => {
  const v = n ?? 0;
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;
};
export const cents = (p: number | null | undefined) => `${((p ?? 0) * 100).toFixed(0)}¢`;
export const when = (d?: string | Date | null) => (d ? new Date(d).toLocaleString("ru-RU") : "—");
export const ago = (d?: string | Date | null) => {
  if (!d) return "—";
  const s = Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 1000));
  if (s < 60) return `${s} с назад`;
  if (s < 3600) return `${Math.round(s / 60)} мин назад`;
  if (s < 86400) return `${Math.round(s / 3600)} ч назад`;
  return `${Math.round(s / 86400)} дн назад`;
};
export const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

export async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}
