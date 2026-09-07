const SUPABASE_URL = "https://hzmhzsggybuaauukjdjs.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_HBwN7mGU6t_EaSUD6Z173A_my4JI02r";

function base() {
  return `${SUPABASE_URL}/rest/v1`;
}

function backendSecret() {
  const value = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!value) throw new Error("TELEGRAM_WEBHOOK_SECRET is missing");
  return value;
}

function query(params: Record<string, string | undefined>) {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    // Internal callers may use suffixes such as first_seen_at.1 to express
    // repeated PostgREST filters on the same real column. URLSearchParams
    // must append those values rather than overwrite the first one.
    const actualKey = key.replace(/\.\d+$/, "");
    result.append(actualKey, value);
  }
  return result.toString();
}

type RequestOptions = {
  retry?: boolean;
  timeoutMs?: number;
};

const TRANSIENT_STATUS = new Set([429, 502, 503, 504, 520, 521, 522, 523, 524]);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path: string, init: RequestInit = {}, options: RequestOptions = {}) {
  const attempts = options.retry ? 3 : 1;
  const timeoutMs = options.timeoutMs ?? 8000;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${base()}/${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
          "x-bot-secret": backendSecret(),
          "content-type": "application/json",
          ...(init.headers || {}),
        },
        cache: "no-store",
      });

      if (!response.ok) {
        const body = await response.text();
        const error = new Error(`Supabase ${response.status}: ${body}`);
        if (options.retry && TRANSIENT_STATUS.has(response.status) && attempt < attempts - 1) {
          lastError = error;
          await sleep(attempt === 0 ? 250 : 750);
          continue;
        }
        throw error;
      }

      if (response.status === 204) return [];
      const text = await response.text();
      return text ? JSON.parse(text) : [];
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      lastError = normalized;
      if (!options.retry || attempt >= attempts - 1) throw normalized;
      await sleep(attempt === 0 ? 250 : 750);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("Supabase request failed");
}

export function dbGet<T>(table: string, params: Record<string, string>): Promise<T[]> {
  return request(`${table}?${query(params)}`, { method: "GET" }, { retry: true });
}

export function dbInsert<T = unknown>(table: string, body: unknown, select?: string): Promise<T[]> {
  const suffix = select ? `?select=${encodeURIComponent(select)}` : "";
  // Generic inserts are not retried automatically because a timed-out response
  // could still have committed on the server and repeating it may duplicate data.
  return request(`${table}${suffix}`, {
    method: "POST",
    headers: { Prefer: select ? "return=representation" : "return=minimal" },
    body: JSON.stringify(body),
  });
}

export function dbUpsert(table: string, body: unknown, onConflict: string) {
  // Upserts are safe to retry because the conflict key makes the operation idempotent.
  return request(`${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(body),
  }, { retry: true });
}

export function dbPatch(table: string, body: unknown, filters: Record<string, string>) {
  // Re-applying the same PATCH body to the same filters is idempotent for our callers.
  return request(`${table}?${query(filters)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(body),
  }, { retry: true });
}
