function base() {
  const value = process.env.SUPABASE_URL;
  if (!value) throw new Error("SUPABASE_URL is missing");
  return `${value.replace(/\/$/, "")}/rest/v1`;
}

function publishableKey() {
  const value = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!value) throw new Error("SUPABASE_PUBLISHABLE_KEY is missing");
  return value;
}

function backendSecret() {
  const value = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!value) throw new Error("TELEGRAM_WEBHOOK_SECRET is missing");
  return value;
}

function query(params: Record<string, string | undefined>) {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) result.set(key, value);
  }
  return result.toString();
}

async function request(path: string, init: RequestInit = {}) {
  const key = publishableKey();
  const response = await fetch(`${base()}/${path}`, {
    ...init,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "x-bot-secret": backendSecret(),
      "content-type": "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  }
  if (response.status === 204) return [];
  const text = await response.text();
  return text ? JSON.parse(text) : [];
}

export function dbGet<T>(table: string, params: Record<string, string>): Promise<T[]> {
  return request(`${table}?${query(params)}`, { method: "GET" });
}

export function dbInsert<T = unknown>(table: string, body: unknown, select?: string): Promise<T[]> {
  const suffix = select ? `?select=${encodeURIComponent(select)}` : "";
  return request(`${table}${suffix}`, {
    method: "POST",
    headers: { Prefer: select ? "return=representation" : "return=minimal" },
    body: JSON.stringify(body),
  });
}

export function dbUpsert(table: string, body: unknown, onConflict: string) {
  return request(`${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(body),
  });
}

export function dbPatch(table: string, body: unknown, filters: Record<string, string>) {
  return request(`${table}?${query(filters)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
}
