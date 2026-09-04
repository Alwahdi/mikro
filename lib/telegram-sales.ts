import { decryptSecret } from "./telegram-crypto";
import { dbGet, dbInsert, dbPatch, dbUpsert } from "./telegram-db";
import { RouterOSClient } from "./routeros-api";
import type { TgUpdate } from "./telegram-extra";

type TgUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
};

type BotUser = {
  telegram_user_id: number;
  active_network_id?: string | null;
};

type Network = {
  id: string;
  telegram_user_id: number;
  label: string;
  connection_mode: "direct" | "agent";
  host?: string | null;
  port?: number | null;
  username?: string | null;
  password_ciphertext?: string | null;
  protocol: "api" | "api-ssl";
  tls_verify: boolean;
  router_os_version?: string | null;
  agent_last_seen_at?: string | null;
  sales_initialized_at?: string | null;
};

type Card = {
  username: string;
  first_seen_at: string;
  first_seen_router_time?: string | null;
  first_profile?: string | null;
  first_vlan_id?: number | null;
};

type SessionPoint = {
  username: string;
  routerTime: string;
  date: Date;
  ip: string;
};

function botToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing");
  return token;
}

async function telegram(method: string, payload: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const json = await response.json();
  if (!json.ok) throw new Error(json.description || `Telegram ${response.status}`);
  return json.result;
}

function send(chatId: number, text: string) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

async function edit(chatId: number, messageId: number, text: string) {
  try {
    return await telegram("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch {
    return send(chatId, text);
  }
}

async function answerCallback(id: string) {
  try {
    await telegram("answerCallbackQuery", { callback_query_id: id });
  } catch {}
}

function esc(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function ensureUser(user: TgUser): Promise<BotUser> {
  await dbUpsert(
    "tg_users",
    {
      telegram_user_id: user.id,
      username: user.username ?? null,
      first_name: user.first_name ?? null,
      last_name: user.last_name ?? null,
      language_code: user.language_code ?? null,
      updated_at: new Date().toISOString(),
    },
    "telegram_user_id",
  );
  const rows = await dbGet<BotUser>("tg_users", {
    telegram_user_id: `eq.${user.id}`,
    select: "telegram_user_id,active_network_id",
    limit: "1",
  });
  if (!rows[0]) throw new Error("Telegram user not found");
  return rows[0];
}

async function activeNetwork(user: BotUser) {
  if (user.active_network_id) {
    const rows = await dbGet<Network>("tg_networks", {
      id: `eq.${user.active_network_id}`,
      telegram_user_id: `eq.${user.telegram_user_id}`,
      select: "*",
      limit: "1",
    });
    if (rows[0]) return rows[0];
  }
  const rows = await dbGet<Network>("tg_networks", {
    telegram_user_id: `eq.${user.telegram_user_id}`,
    select: "*",
    order: "created_at.asc",
    limit: "1",
  });
  return rows[0] ?? null;
}

function clientFor(network: Network) {
  if (
    network.connection_mode !== "direct" ||
    !network.host ||
    !network.port ||
    !network.username ||
    !network.password_ciphertext
  ) {
    throw new Error("Direct API credentials are incomplete");
  }
  return new RouterOSClient({
    host: network.host,
    port: network.port,
    username: network.username,
    password: decryptSecret(network.password_ciphertext),
    tls: network.protocol === "api-ssl",
    rejectUnauthorized: network.tls_verify,
    timeoutMs: 20000,
  });
}

function major(version: string) {
  return Number(/^(\d+)/.exec(version)?.[1] || 0);
}

const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function parseOffsetMinutes(raw?: string) {
  const value = String(raw || "").trim();
  const hhmm = /^([+-]?)(\d{1,2}):(\d{2})$/.exec(value);
  if (hhmm) {
    const sign = hhmm[1] === "-" ? -1 : 1;
    return sign * (Number(hhmm[2]) * 60 + Number(hhmm[3]));
  }
  if (/^[+-]?\d+$/.test(value)) {
    const seconds = Number(value);
    if (Math.abs(seconds) <= 86400) return Math.trunc(seconds / 60);
  }
  return 0;
}

function parseClockDay(value: string) {
  const old = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\/(\d{1,2})\/(\d{4})$/i.exec(value);
  if (old) {
    return {
      style: "old" as const,
      date: new Date(Date.UTC(Number(old[3]), months.indexOf(old[1].toLowerCase()), Number(old[2]))),
    };
  }
  const modern = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (modern) {
    return {
      style: "modern" as const,
      date: new Date(Date.UTC(Number(modern[1]), Number(modern[2]) - 1, Number(modern[3]))),
    };
  }
  throw new Error(`Unsupported RouterOS date format: ${value}`);
}

function formatRouterDay(date: Date, style: "old" | "modern") {
  if (style === "modern") {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }
  return `${months[date.getUTCMonth()]}/${String(date.getUTCDate()).padStart(2, "0")}/${date.getUTCFullYear()}`;
}

function parseRouterDateTime(value: string, offsetMinutes: number) {
  const old = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/i.exec(value);
  if (old) {
    return new Date(
      Date.UTC(
        Number(old[3]),
        months.indexOf(old[1].toLowerCase()),
        Number(old[2]),
        Number(old[4]),
        Number(old[5]),
        Number(old[6]),
      ) - offsetMinutes * 60000,
    );
  }
  const modern = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})/.exec(value);
  if (!modern) return null;
  return new Date(
    Date.UTC(
      Number(modern[1]),
      Number(modern[2]) - 1,
      Number(modern[3]),
      Number(modern[4]),
      Number(modern[5]),
      Number(modern[6]),
    ) - offsetMinutes * 60000,
  );
}

function vlanFromIp(ip: string) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const third = Number(parts[2]);
  return Number.isInteger(third) ? third : null;
}

async function loadKnown(networkId: string) {
  const known = new Set<string>();
  let offset = 0;
  while (true) {
    const rows = await dbGet<{ username: string }>("tg_cards", {
      network_id: `eq.${networkId}`,
      select: "username",
      order: "username.asc",
      limit: "1000",
      offset: String(offset),
    });
    for (const row of rows) known.add(row.username);
    if (rows.length < 1000) break;
    offset += rows.length;
  }
  return known;
}

async function insertCards(rows: Record<string, unknown>[]) {
  for (let i = 0; i < rows.length; i += 150) {
    try {
      await dbInsert("tg_cards", rows.slice(i, i + 150));
    } catch (error) {
      // A concurrent duplicate should not make the whole report fail. Retry
      // individually so unique rows are still persisted.
      for (const row of rows.slice(i, i + 150)) {
        try {
          await dbInsert("tg_cards", row);
        } catch {}
      }
    }
  }
}

function earliestByUser(
  sessions: Record<string, string>[],
  version: string,
  offsetMinutes: number,
) {
  const result = new Map<string, SessionPoint>();
  const v7 = major(version) >= 7;
  for (const session of sessions) {
    const username = session.user || "";
    const routerTime = v7 ? session.started || "" : session["from-time"] || "";
    const date = parseRouterDateTime(routerTime, offsetMinutes);
    if (!username || !date) continue;
    const ip = v7 ? session["user-address"] || "" : session["user-ip"] || "";
    const current = result.get(username);
    if (!current || date.getTime() < current.date.getTime()) {
      result.set(username, { username, routerTime, date, ip });
    }
  }
  return result;
}

async function fetchProfile(client: RouterOSClient, version: string, username: string) {
  try {
    if (major(version) >= 7) {
      const rows = await client.command("/user-manager/user-profile/print", [
        "=.proplist=user,profile,state",
        `?user=${username}`,
      ]);
      const active = rows.find((row) => String(row.state || "").includes("active")) || rows.find((row) => row.state === "running") || rows[0];
      return active?.profile || null;
    }
    const rows = await client.command("/tool/user-manager/user/print", [
      "=.proplist=username,actual-profile",
      `?username=${username}`,
    ]);
    return rows[0]?.["actual-profile"] || null;
  } catch {
    return null;
  }
}

async function initializeHistory(
  client: RouterOSClient,
  network: Network,
  version: string,
  offsetMinutes: number,
  todayStartMs: number,
  todayEndMs: number,
) {
  const v7 = major(version) >= 7;
  const path = v7 ? "/user-manager/session/print" : "/tool/user-manager/session/print";
  const proplist = v7 ? "=.proplist=user,started,user-address" : "=.proplist=user,from-time,user-ip";
  const sessions = await client.command(path, [proplist]);
  const earliest = earliestByUser(sessions, version, offsetMinutes);
  const known = await loadKnown(network.id);
  const inserts: Record<string, unknown>[] = [];

  for (const point of earliest.values()) {
    if (known.has(point.username)) continue;
    const isToday = point.date.getTime() >= todayStartMs && point.date.getTime() < todayEndMs;
    const profile = isToday ? await fetchProfile(client, version, point.username) : null;
    inserts.push({
      network_id: network.id,
      username: point.username,
      first_seen_at: point.date.toISOString(),
      first_seen_router_time: point.routerTime,
      first_profile: profile,
      first_vlan_id: vlanFromIp(point.ip),
      last_seen_at: new Date().toISOString(),
      last_profile: profile,
      last_vlan_id: vlanFromIp(point.ip),
    });
  }

  await insertCards(inserts);
  await dbPatch(
    "tg_networks",
    { sales_initialized_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { id: `eq.${network.id}` },
  );
  return sessions.length;
}

async function syncToday(
  client: RouterOSClient,
  network: Network,
  version: string,
  offsetMinutes: number,
  todayRouter: string,
  tomorrowRouter: string,
) {
  const v7 = major(version) >= 7;
  const path = v7 ? "/user-manager/session/print" : "/tool/user-manager/session/print";
  const timeField = v7 ? "started" : "from-time";
  const proplist = v7 ? "=.proplist=user,started,user-address" : "=.proplist=user,from-time,user-ip";

  // RouterOS API query words support typed greater-than/less-than filters.
  // This avoids downloading the full session database on normal daily checks.
  const sessions = await client.command(path, [
    proplist,
    `?>${timeField}=${todayRouter} 00:00:00`,
    `?<${timeField}=${tomorrowRouter} 00:00:00`,
  ]);

  const candidates = earliestByUser(sessions, version, offsetMinutes);
  const known = await loadKnown(network.id);
  const inserts: Record<string, unknown>[] = [];

  for (const candidate of candidates.values()) {
    if (known.has(candidate.username)) continue;

    // Unknown candidate after the baseline: inspect only this user's history.
    // If an old session exists, store its actual earliest time and do not count
    // it as a new sale today.
    const userSessions = await client.command(path, [proplist, `?user=${candidate.username}`]);
    const first = earliestByUser(userSessions, version, offsetMinutes).get(candidate.username) || candidate;
    const profile = await fetchProfile(client, version, candidate.username);
    inserts.push({
      network_id: network.id,
      username: candidate.username,
      first_seen_at: first.date.toISOString(),
      first_seen_router_time: first.routerTime,
      first_profile: profile,
      first_vlan_id: vlanFromIp(first.ip),
      last_seen_at: new Date().toISOString(),
      last_profile: profile,
      last_vlan_id: vlanFromIp(candidate.ip),
    });
  }

  await insertCards(inserts);
  return sessions.length;
}

async function todaySales(networkId: string, startIso: string, endIso: string) {
  return dbGet<Card>("tg_cards", {
    network_id: `eq.${networkId}`,
    first_seen_at: `gte.${startIso}`,
    "first_seen_at.1": `lt.${endIso}`,
    select: "username,first_seen_at,first_seen_router_time,first_profile,first_vlan_id",
    order: "first_seen_at.asc",
    limit: "1000",
  });
}

async function queueAgentSales(chatId: number, user: BotUser, network: Network) {
  const last = network.agent_last_seen_at ? new Date(network.agent_last_seen_at).getTime() : 0;
  const online = Date.now() - last < 60_000;
  const waiting = await send(
    chatId,
    `${online ? "⏳" : "🟠"} <b>${esc(network.label)}</b>\n${online ? "جاري حساب أول دخول للكروت عبر Agent..." : "Agent غير ظاهر الآن؛ تم وضع الطلب في الانتظار."}`,
  );
  await dbInsert("tg_agent_commands", {
    network_id: network.id,
    telegram_user_id: user.telegram_user_id,
    chat_id: chatId,
    reply_message_id: waiting.message_id,
    kind: "sales",
    payload: {},
    status: "pending",
  });
}

async function runDirectSales(chatId: number, network: Network) {
  const waiting = await send(
    chatId,
    `⏳ <b>${esc(network.label)} • مبيعات اليوم</b>\nجاري مزامنة أول دخول للكروت...`,
  );

  const client = clientFor(network);
  try {
    const resource = await client.command("/system/resource/print", ["=.proplist=version"]);
    const clock = await client.command("/system/clock/print", ["=.proplist=date,time,gmt-offset,time-zone-name"]);
    const version = resource[0]?.version || network.router_os_version || "";
    if (!version) throw new Error("تعذر معرفة إصدار RouterOS");

    const clockDate = clock[0]?.date || "";
    const day = parseClockDay(clockDate);
    const tomorrowDate = new Date(day.date.getTime() + 86400000);
    const todayRouter = formatRouterDay(day.date, day.style);
    const tomorrowRouter = formatRouterDay(tomorrowDate, day.style);
    const offsetMinutes = parseOffsetMinutes(clock[0]?.["gmt-offset"]);
    const startMs = day.date.getTime() - offsetMinutes * 60000;
    const endMs = startMs + 86400000;

    let scanned = 0;
    let initializedNow = false;
    if (!network.sales_initialized_at) {
      initializedNow = true;
      scanned = await initializeHistory(client, network, version, offsetMinutes, startMs, endMs);
    } else {
      scanned = await syncToday(client, network, version, offsetMinutes, todayRouter, tomorrowRouter);
    }

    const sales = await todaySales(network.id, new Date(startMs).toISOString(), new Date(endMs).toISOString());
    const shown = sales.slice(0, 35);
    const lines = shown.map((card, index) => {
      const profile = card.first_profile ? ` • ${esc(card.first_profile)}` : "";
      const vlan = card.first_vlan_id ? ` • VLAN ${card.first_vlan_id}` : "";
      return `${index + 1}. 🎫 <code>${esc(card.username)}</code>${profile}${vlan}`;
    });

    await dbPatch(
      "tg_networks",
      {
        status: "online",
        router_os_version: version,
        last_connected_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      { id: `eq.${network.id}` },
    );

    return edit(
      chatId,
      waiting.message_id,
      `💰 <b>${esc(network.label)} • مبيعات اليوم</b>\n━━━━━━━━━━━━━━━━━━\n🆕 كروت أول دخول: <b>${sales.length}</b>\n📅 ${esc(todayRouter)}\n\n${lines.join("\n") || "لا توجد كروت سجلت أول دخول لها اليوم."}${sales.length > shown.length ? `\n\n… +${sales.length - shown.length} كرت` : ""}\n\n${initializedNow ? `✅ تم إنشاء خط الأساس من ${scanned} جلسة مسجلة.\n` : `⚡ تمت مراجعة ${scanned} جلسة من جلسات اليوم فقط.\n`}☁️ أول دخول محفوظ سحابيًا لمنع تكرار المبيعات بعد حذف Session History.`,
    );
  } catch (error) {
    await dbPatch(
      "tg_networks",
      { status: "error", last_error: String(error), updated_at: new Date().toISOString() },
      { id: `eq.${network.id}` },
    );
    return edit(
      chatId,
      waiting.message_id,
      `🔴 <b>تعذر حساب المبيعات</b>\n${esc(String(error instanceof Error ? error.message : error).slice(0, 450))}`,
    );
  } finally {
    client.close();
  }
}

export async function handleTelegramSales(update: TgUpdate): Promise<boolean> {
  const callback = update.callback_query;
  const message = update.message;
  const isCallback = callback?.data === "sales";
  const isCommand = message?.text?.trim() === "/sales";
  if (!isCallback && !isCommand) return false;

  const sourceUser = callback?.from || message?.from;
  if (!sourceUser) return false;
  if (callback) await answerCallback(callback.id);

  const chatId = callback?.message?.chat.id ?? message?.chat.id ?? sourceUser.id;
  const user = await ensureUser(sourceUser);
  const network = await activeNetwork(user);
  if (!network) {
    await send(chatId, "📭 لا توجد شبكة مرتبطة بعد. استخدم /add أولاً.");
    return true;
  }

  if (network.connection_mode === "agent") {
    await queueAgentSales(chatId, user, network);
  } else {
    await runDirectSales(chatId, network);
  }
  return true;
}
