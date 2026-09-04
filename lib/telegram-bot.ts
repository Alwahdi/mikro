import { decryptSecret, encryptSecret } from "./telegram-crypto";
import { dbGet, dbInsert, dbPatch, dbUpsert } from "./telegram-db";
import { RouterOSClient } from "./routeros-api";
import {
  agentInstallCommand,
  encryptAgentSecret,
  newAgentSecret,
} from "./router-agent";

type TgUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
};

type TgMessage = {
  message_id: number;
  chat: { id: number };
  from?: TgUser;
  text?: string;
};

type TgCallback = {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
};

type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
};

type BotUser = {
  telegram_user_id: number;
  setup_state: string;
  setup_data: Record<string, unknown>;
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
  identity?: string | null;
  router_os_version?: string | null;
  status?: "unknown" | "online" | "offline" | "error";
  last_connected_at?: string | null;
  last_error?: string | null;
  agent_last_seen_at?: string | null;
  capabilities?: Record<string, unknown> | null;
};

type UMCard = {
  username: string;
  first_profile: string | null;
  first_vlan_id: number | null;
  first_seen_router_time: string | null;
};

type AgentCommand = {
  id: string;
};

function botToken() {
  const value = process.env.TELEGRAM_BOT_TOKEN;
  if (!value) throw new Error("TELEGRAM_BOT_TOKEN is missing");
  return value;
}

async function telegram(method: string, payload: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram ${method}: ${result.description || response.status}`);
  return result.result;
}

function send(chatId: number, text: string, reply_markup?: unknown) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup,
  });
}

async function answerCallback(id: string) {
  try {
    await telegram("answerCallbackQuery", { callback_query_id: id });
  } catch {}
}

async function deleteMessage(chatId: number, messageId: number) {
  try {
    await telegram("deleteMessage", { chat_id: chatId, message_id: messageId });
  } catch {}
}

function esc(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const mainKeyboard = {
  inline_keyboard: [
    [
      { text: "➕ إضافة شبكة", callback_data: "add_network" },
      { text: "📡 شبكاتي", callback_data: "networks" },
    ],
    [
      { text: "📊 الحالة", callback_data: "status" },
      { text: "💰 مبيعات اليوم", callback_data: "sales" },
    ],
    [
      { text: "🧩 VLAN", callback_data: "vlan_help" },
      { text: "🌐 Ping", callback_data: "ping" },
    ],
    [
      { text: "⚙️ إعدادات", callback_data: "settings" },
      { text: "❓ مساعدة", callback_data: "help" },
    ],
  ],
};

const connectionKeyboard = {
  inline_keyboard: [
    [
      { text: "⚡ Cloud / DDNS / Public IP", callback_data: "conn_direct" },
    ],
    [
      { text: "🔄 بدون Cloud / خلف CGNAT", callback_data: "conn_agent" },
    ],
    [{ text: "❌ إلغاء", callback_data: "cancel_setup" }],
  ],
};

const protocolKeyboard = {
  inline_keyboard: [
    [{ text: "🔐 API-SSL", callback_data: "proto_api_ssl" }],
    [{ text: "🔌 API", callback_data: "proto_api" }],
    [{ text: "❌ إلغاء", callback_data: "cancel_setup" }],
  ],
};

function homeText(name?: string) {
  return `🤖 <b>MikroTik Network Bot</b>\n━━━━━━━━━━━━━━━━━━\nأهلاً${name ? ` ${esc(name)}` : ""} 👋\n\nإدارة MikroTik من تيليجرام فقط. يدعم الاتصال المباشر، وكذلك الشبكات بدون Cloud/DDNS أو خلف CGNAT.`;
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
    select: "*",
  });
  if (!rows[0]) throw new Error("Could not load Telegram user");
  return rows[0];
}

function setState(userId: number, setup_state: string, setup_data: Record<string, unknown> = {}) {
  return dbPatch(
    "tg_users",
    { setup_state, setup_data, updated_at: new Date().toISOString() },
    { telegram_user_id: `eq.${userId}` },
  );
}

function getNetworks(userId: number) {
  return dbGet<Network>("tg_networks", {
    telegram_user_id: `eq.${userId}`,
    select: "*",
    order: "created_at.asc",
  });
}

async function getActiveNetwork(user: BotUser): Promise<Network | null> {
  if (user.active_network_id) {
    const rows = await dbGet<Network>("tg_networks", {
      id: `eq.${user.active_network_id}`,
      telegram_user_id: `eq.${user.telegram_user_id}`,
      select: "*",
    });
    if (rows[0]) return rows[0];
  }

  const rows = await getNetworks(user.telegram_user_id);
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
    timeoutMs: 12000,
  });
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0.00 GB";
  return `${(value / 1073741824).toFixed(2)} GB`;
}

function parseOffsetMinutes(value?: string) {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(value || "");
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

function parseRouterDate(value: string, offsetMinutes = 0) {
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;

  const old = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/i.exec(value);
  if (old) {
    const months: Record<string, number> = {
      jan: 0,
      feb: 1,
      mar: 2,
      apr: 3,
      may: 4,
      jun: 5,
      jul: 6,
      aug: 7,
      sep: 8,
      oct: 9,
      nov: 10,
      dec: 11,
    };
    year = Number(old[3]);
    month = months[old[1].toLowerCase()];
    day = Number(old[2]);
    hour = Number(old[4]);
    minute = Number(old[5]);
    second = Number(old[6]);
  } else {
    const modern = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(value);
    if (!modern) return null;
    year = Number(modern[1]);
    month = Number(modern[2]) - 1;
    day = Number(modern[3]);
    hour = Number(modern[4]);
    minute = Number(modern[5]);
    second = Number(modern[6]);
  }

  return new Date(Date.UTC(year, month, day, hour, minute, second) - offsetMinutes * 60_000);
}

function routerDateKey(value: string) {
  const old = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\/(\d{2})\/(\d{4})$/i.exec(value);
  if (old) {
    const months: Record<string, string> = {
      jan: "01",
      feb: "02",
      mar: "03",
      apr: "04",
      may: "05",
      jun: "06",
      jul: "07",
      aug: "08",
      sep: "09",
      oct: "10",
      nov: "11",
      dec: "12",
    };
    return `${old[3]}-${months[old[1].toLowerCase()]}-${old[2]}`;
  }
  const modern = /^(\d{4}-\d{2}-\d{2})$/.exec(value);
  return modern?.[1] || value;
}

function localDateKey(date: Date, offsetMinutes: number) {
  const local = new Date(date.getTime() + offsetMinutes * 60_000);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}`;
}

function majorVersion(version?: string | null) {
  const match = /^(\d+)/.exec(version || "");
  return match ? Number(match[1]) : 0;
}

async function detectCapabilities(client: RouterOSClient, version: string) {
  const capabilities: Record<string, unknown> = {
    routeros_major: majorVersion(version),
    api: true,
    hotspot: false,
    vlan: false,
    user_manager: "none",
  };

  try {
    await client.command("/ip/hotspot/active/print", ["=.proplist=.id"]);
    capabilities.hotspot = true;
  } catch {}

  try {
    await client.command("/interface/vlan/print", ["=.proplist=.id"]);
    capabilities.vlan = true;
  } catch {}

  if (majorVersion(version) >= 7) {
    try {
      await client.command("/user-manager/session/print", ["=.proplist=.id"]);
      capabilities.user_manager = "v7";
    } catch {}
  } else {
    try {
      await client.command("/tool/user-manager/session/print", ["=.proplist=.id"]);
      capabilities.user_manager = "v6";
    } catch {}
  }

  return capabilities;
}

async function readStatus(network: Network) {
  const client = clientFor(network);
  try {
    const pingRows = await client.command("/ping", ["=address=8.8.8.8", "=count=3"]);
    const resource = await client.command("/system/resource/print");
    const identity = await client.command("/system/identity/print");

    let online: Record<string, string>[] = [];
    try {
      online = await client.command("/ip/hotspot/active/print", ["=.proplist=.id"]);
    } catch {}

    let ppp: Record<string, string>[] = [];
    try {
      ppp = await client.command("/interface/pppoe-client/print", ["=.proplist=name,running,disabled"]);
    } catch {}

    const row = resource[0] || {};
    const replies = pingRows.length;
    return {
      identity: identity[0]?.name || network.label,
      version: row.version || network.router_os_version || "-",
      uptime: row.uptime || "-",
      cpu: row["cpu-load"] || "-",
      freeMemory: Number(row["free-memory"] || 0),
      totalMemory: Number(row["total-memory"] || 0),
      online: online.length,
      pingReplies: replies,
      pppRunning: ppp.filter((item) => item.running === "true" && item.disabled !== "true").length,
    };
  } finally {
    client.close();
  }
}

async function readPing(network: Network) {
  const client = clientFor(network);
  try {
    const rows = await client.command("/ping", ["=address=8.8.8.8", "=count=5"]);
    const times = rows
      .map((row) => parseFloat(String(row.time || "").replace("ms", "")))
      .filter(Number.isFinite);
    const replies = rows.length;
    return {
      replies,
      loss: Math.max(0, 100 - replies * 20),
      average: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
    };
  } finally {
    client.close();
  }
}

async function readVlan(network: Network, vlanId: number) {
  const client = clientFor(network);
  try {
    const vlans = await client.command("/interface/vlan/print", ["=.proplist=.id,name,vlan-id,disabled"]);
    const vlan = vlans.find((item) => Number(item["vlan-id"]) === vlanId && item.disabled !== "true");
    if (!vlan) return null;

    const stats = await client.command("/interface/print", ["=.proplist=name,rx-byte,tx-byte", `?name=${vlan.name}`]);
    const rx = Number(stats[0]?.["rx-byte"] || 0);
    const tx = Number(stats[0]?.["tx-byte"] || 0);

    let active: Record<string, string>[] = [];
    try {
      active = await client.command("/ip/hotspot/active/print", ["=.proplist=server,address"]);
    } catch {}

    let online = active.filter((item) => item.server === vlan.name).length;
    if (online === 0 && active.length) {
      try {
        const addresses = await client.command("/ip/address/print", ["=.proplist=address,interface", `?interface=${vlan.name}`]);
        const cidr = addresses[0]?.address || "";
        const match = /^(\d+\.\d+\.\d+)\.\d+\/24$/.exec(cidr);
        if (match) online = active.filter((item) => String(item.address || "").startsWith(`${match[1]}.`)).length;
      } catch {}
    }

    return {
      name: vlan.name || String(vlanId),
      rx,
      tx,
      total: rx + tx,
      online,
    };
  } finally {
    client.close();
  }
}

async function loadKnownCards(networkId: string) {
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

async function syncAndReadSales(network: Network): Promise<UMCard[]> {
  const client = clientFor(network);
  try {
    const resource = await client.command("/system/resource/print", ["=.proplist=version"]);
    const version = resource[0]?.version || network.router_os_version || "";
    const clock = await client.command("/system/clock/print", ["=.proplist=date,time,gmt-offset,time-zone-name"]);
    const offsetMinutes = parseOffsetMinutes(clock[0]?.["gmt-offset"]);
    const todayKey = routerDateKey(clock[0]?.date || "");

    let sessions: Record<string, string>[] = [];
    const profileByUser = new Map<string, string>();

    if (majorVersion(version) >= 7) {
      try {
        sessions = await client.command("/user-manager/session/print", ["=.proplist=user,started,user-address"]);
      } catch {
        throw new Error("User Manager v7 غير متاح أو غير مفعّل");
      }

      try {
        const profiles = await client.command("/user-manager/user-profile/print", ["=.proplist=user,profile,state"]);
        for (const item of profiles) {
          if (!item.user || !item.profile) continue;
          if (!profileByUser.has(item.user) || String(item.state || "").includes("active")) {
            profileByUser.set(item.user, item.profile);
          }
        }
      } catch {}
    } else {
      try {
        sessions = await client.command("/tool/user-manager/session/print", ["=.proplist=user,from-time,user-ip"]);
      } catch {
        throw new Error("User Manager v6 غير متاح أو غير مفعّل");
      }

      try {
        const users = await client.command("/tool/user-manager/user/print", ["=.proplist=username,actual-profile"]);
        for (const item of users) if (item.username) profileByUser.set(item.username, item["actual-profile"] || "");
      } catch {}
    }

    const firstByUser = new Map<string, { date: Date; routerTime: string; ip: string }>();
    for (const session of sessions) {
      const username = session.user;
      if (!username) continue;
      const routerTime = majorVersion(version) >= 7 ? session.started || "" : session["from-time"] || "";
      const date = parseRouterDate(routerTime, offsetMinutes);
      if (!date) continue;
      const previous = firstByUser.get(username);
      if (!previous || date.getTime() < previous.date.getTime()) {
        firstByUser.set(username, {
          date,
          routerTime,
          ip: majorVersion(version) >= 7 ? session["user-address"] || "" : session["user-ip"] || "",
        });
      }
    }

    const known = await loadKnownCards(network.id);
    const inserts: Record<string, unknown>[] = [];
    for (const [username, first] of firstByUser) {
      if (known.has(username)) continue;
      const vlanMatch = /^(?:\d+\.){2}(\d+)\./.exec(first.ip);
      inserts.push({
        network_id: network.id,
        username,
        first_seen_at: first.date.toISOString(),
        first_seen_router_time: first.routerTime,
        first_profile: profileByUser.get(username) || null,
        first_vlan_id: vlanMatch ? Number(vlanMatch[1]) : null,
        last_seen_at: new Date().toISOString(),
        last_profile: profileByUser.get(username) || null,
        last_vlan_id: vlanMatch ? Number(vlanMatch[1]) : null,
      });
    }

    for (let i = 0; i < inserts.length; i += 200) {
      await dbInsert("tg_cards", inserts.slice(i, i + 200));
    }

    const allToday: UMCard[] = [];
    for (const [username, first] of firstByUser) {
      if (localDateKey(first.date, offsetMinutes) !== todayKey) continue;
      const vlanMatch = /^(?:\d+\.){2}(\d+)\./.exec(first.ip);
      allToday.push({
        username,
        first_profile: profileByUser.get(username) || null,
        first_vlan_id: vlanMatch ? Number(vlanMatch[1]) : null,
        first_seen_router_time: first.routerTime,
      });
    }

    allToday.sort((a, b) => String(a.first_seen_router_time).localeCompare(String(b.first_seen_router_time)));
    return allToday;
  } finally {
    client.close();
  }
}

async function beginAddNetwork(chatId: number, userId: number) {
  await setState(userId, "await_label", {});
  return send(
    chatId,
    "➕ <b>إضافة شبكة جديدة</b>\n━━━━━━━━━━━━━━━━━━\nأرسل اسم الشبكة الذي تريد ظهوره داخل البوت.\n\nمثال: <code>PRONET</code>",
  );
}

async function createAgentNetwork(chatId: number, user: BotUser) {
  const label = String(user.setup_data?.label || "MikroTik");
  const secret = newAgentSecret();

  try {
    const saved = await dbInsert<Network>(
      "tg_networks",
      {
        telegram_user_id: user.telegram_user_id,
        label,
        connection_mode: "agent",
        host: null,
        port: null,
        username: null,
        password_ciphertext: null,
        protocol: "api",
        tls_verify: false,
        agent_secret_ciphertext: encryptAgentSecret(secret),
        status: "unknown",
        capabilities: { transport: "https-fetch", minimum_routeros: "6.43" },
      },
      "*",
    );
    const network = saved[0];
    if (!network) throw new Error("Could not save Agent network");

    await dbPatch(
      "tg_users",
      { active_network_id: network.id, setup_state: "idle", setup_data: {}, updated_at: new Date().toISOString() },
      { telegram_user_id: `eq.${user.telegram_user_id}` },
    );

    const command = agentInstallCommand(network.id, secret);
    return send(
      chatId,
      `🔄 <b>ربط بدون Cloud / DDNS</b>\n━━━━━━━━━━━━━━━━━━\nلا تحتاج Public IP ولا فتح Port، ويعمل خلف CGNAT.\n\nانسخ هذا الأمر والصقه مرة واحدة في Terminal الراوتر:\n\n<code>${esc(command)}</code>\n\nبعد ظهور <code>MT-TG Agent installed successfully</code> اضغط «فحص الاتصال».\n\nℹ️ Agent Mode يحتاج RouterOS 6.43+ أو أي RouterOS 7.x.`,
      {
        inline_keyboard: [
          [{ text: "✅ فحص الاتصال", callback_data: `agent_check:${network.id}` }],
          [{ text: "🏠 الرئيسية", callback_data: "help" }],
        ],
      },
    );
  } catch (error) {
    await setState(user.telegram_user_id, "idle", {});
    return send(
      chatId,
      `❌ تعذر إنشاء الشبكة.\n${esc(error instanceof Error ? error.message : error)}`,
      mainKeyboard,
    );
  }
}

async function processSetup(message: TgMessage, user: BotUser) {
  const chatId = message.chat.id;
  const text = (message.text || "").trim();
  const data = user.setup_data || {};

  if (user.setup_state === "await_label") {
    if (!text) return;
    await setState(user.telegram_user_id, "await_connection", { ...data, label: text });
    return send(
      chatId,
      "🔗 <b>كيف تريد ربط الراوتر؟</b>\n\n⚡ إذا عندك Cloud/DDNS/Public IP اختر الاتصال المباشر.\n🔄 إذا ما عندك أو أنت خلف CGNAT اختر Agent Mode.",
      connectionKeyboard,
    );
  }

  if (user.setup_state === "await_host") {
    if (!text || /[\s/]/.test(text)) {
      return send(chatId, "⚠️ أرسل Host أو IP فقط بدون http:// أو مسافات.");
    }
    await setState(user.telegram_user_id, "await_protocol", { ...data, host: text });
    return send(chatId, "🔌 اختر نوع MikroTik API:", protocolKeyboard);
  }

  if (user.setup_state === "await_port") {
    const port = Number(text);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return send(chatId, "⚠️ أرسل رقم Port صحيح بين 1 و 65535.\nمثال: <code>8728</code>");
    }
    await setState(user.telegram_user_id, "await_username", { ...data, port });
    return send(chatId, "👤 أرسل <b>API Username</b> للراوتر.");
  }

  if (user.setup_state === "await_username") {
    if (!text) return;
    await setState(user.telegram_user_id, "await_password", { ...data, username: text });
    return send(
      chatId,
      "🔑 أرسل <b>API Password</b>.\nسيتم حذف رسالتك مباشرة بعد استلامها ولن تُعرض مرة أخرى.",
    );
  }

  if (user.setup_state === "await_password") {
    if (!text) return;
    await deleteMessage(chatId, message.message_id);

    const setup: Record<string, unknown> = { ...data, password: text };
    await setState(user.telegram_user_id, "testing", { ...data });
    await send(chatId, "🔄 جاري اختبار الاتصال واكتشاف إمكانيات الراوتر...\n\n🌐 Reachability\n🔐 Authentication\n🧠 RouterOS\n🎟 User Manager\n🧩 VLAN / Hotspot");

    const temp: Network = {
      id: "temporary",
      telegram_user_id: user.telegram_user_id,
      label: String(setup.label),
      connection_mode: "direct",
      host: String(setup.host),
      port: Number(setup.port),
      username: String(setup.username),
      password_ciphertext: encryptSecret(String(setup.password)),
      protocol: setup.protocol as "api" | "api-ssl",
      tls_verify: false,
    };

    try {
      const client = clientFor(temp);
      const identity = await client.command("/system/identity/print");
      const resource = await client.command("/system/resource/print");
      const version = resource[0]?.version || "";
      const capabilities = await detectCapabilities(client, version);
      client.close();

      const saved = await dbInsert<Network>(
        "tg_networks",
        {
          telegram_user_id: user.telegram_user_id,
          label: temp.label,
          connection_mode: "direct",
          host: temp.host,
          port: temp.port,
          username: temp.username,
          password_ciphertext: temp.password_ciphertext,
          protocol: temp.protocol,
          tls_verify: false,
          identity: identity[0]?.name || temp.label,
          router_os_version: version || null,
          status: "online",
          capabilities,
          last_connected_at: new Date().toISOString(),
          last_error: null,
        },
        "*",
      );

      if (!saved[0]) throw new Error("Could not save router");

      await dbPatch(
        "tg_users",
        { active_network_id: saved[0].id, setup_state: "idle", setup_data: {}, updated_at: new Date().toISOString() },
        { telegram_user_id: `eq.${user.telegram_user_id}` },
      );

      return send(
        chatId,
        `🎉 <b>تم ربط الشبكة بنجاح</b>\n━━━━━━━━━━━━━━━━━━\n📡 ${esc(identity[0]?.name || temp.label)}\n🧠 RouterOS ${esc(version || "-")}\n🔗 Direct ${temp.protocol.toUpperCase()} • ${esc(temp.host)}:${temp.port}\n🎟 User Manager: <b>${esc(capabilities.user_manager || "none")}</b>\n🧩 VLAN: ${capabilities.vlan ? "✅" : "—"} • Hotspot: ${capabilities.hotspot ? "✅" : "—"}\n\nالبوت جاهز الآن.`,
        mainKeyboard,
      );
    } catch (error) {
      await setState(user.telegram_user_id, "idle", {});
      return send(
        chatId,
        `❌ <b>تعذر الاتصال</b>\n\n${esc(String(error instanceof Error ? error.message : error).slice(0, 350))}\n\nتحقق من Cloud/IP وAPI Port واسم المستخدم وكلمة المرور، أو استخدم Agent Mode إذا لم يكن الراوتر قابلاً للوصول من الإنترنت.`,
        mainKeyboard,
      );
    }
  }

  return false;
}

async function queueAgentAction(
  chatId: number,
  user: BotUser,
  network: Network,
  kind: "status" | "ping" | "vlan" | "sales",
  payload: Record<string, unknown> = {},
) {
  const lastSeen = network.agent_last_seen_at ? new Date(network.agent_last_seen_at).getTime() : 0;
  const online = Date.now() - lastSeen < 60_000;
  const waiting = await send(
    chatId,
    `${online ? "⏳" : "🟠"} <b>${esc(network.label)}</b>\n${online ? "جاري تنفيذ الطلب عبر Agent..." : "Agent غير ظاهر الآن؛ تم وضع الطلب في الانتظار لمدة قصيرة."}`,
  );

  await dbInsert<AgentCommand>(
    "tg_agent_commands",
    {
      network_id: network.id,
      telegram_user_id: user.telegram_user_id,
      chat_id: chatId,
      reply_message_id: waiting.message_id,
      kind,
      payload,
      status: "pending",
    },
    "id",
  );
}

async function runAction(chatId: number, user: BotUser, action: string) {
  const network = await getActiveNetwork(user);
  if (["status", "sales", "ping"].includes(action) && !network) {
    return send(chatId, "📭 لا توجد شبكة مرتبطة بعد. اضغط <b>➕ إضافة شبكة</b> أولاً.", mainKeyboard);
  }

  if (action === "help") {
    return send(
      chatId,
      `${homeText()}\n\n<b>الأوامر:</b>\n/start\n/add\n/status\n/sales\n/ping\n/vlan 202\n/networks\n/use 1\n/cancel`,
      mainKeyboard,
    );
  }

  if (action === "settings") {
    return send(
      chatId,
      "⚙️ <b>الإعدادات</b>\n━━━━━━━━━━━━━━━━━━\n• يدعم أكثر من شبكة لكل حساب Telegram.\n• Direct API للإصدارات القديمة والجديدة.\n• Agent HTTPS للشبكات بدون Cloud/DDNS أو خلف CGNAT (RouterOS 6.43+).\n• كلمة مرور API تُخزن مشفرة ولا تُعرض بعد إدخالها.",
      mainKeyboard,
    );
  }

  if (action === "vlan_help") {
    return send(chatId, "🧩 لمعرفة VLAN محدد أرسل مثلاً:\n<code>/vlan 202</code>");
  }

  if (action === "networks") {
    const list = await getNetworks(user.telegram_user_id);
    if (!list.length) return send(chatId, "📭 لا توجد شبكات بعد.", mainKeyboard);

    const text = list
      .map((item, index) => {
        const selected = item.id === user.active_network_id ? "🟢" : "⚪";
        const transport = item.connection_mode === "agent"
          ? `Agent HTTPS${item.agent_last_seen_at && Date.now() - new Date(item.agent_last_seen_at).getTime() < 60_000 ? " • متصل" : " • غير ظاهر"}`
          : `${item.protocol.toUpperCase()} • ${item.host}:${item.port}`;
        return `${index + 1}. ${selected} <b>${esc(item.label)}</b>\n   ${esc(transport)}${item.router_os_version ? ` • ROS ${esc(item.router_os_version)}` : ""}`;
      })
      .join("\n\n");

    return send(chatId, `📡 <b>شبكاتي</b>\n━━━━━━━━━━━━━━━━━━\n${text}\n\nلتغيير الشبكة النشطة استخدم <code>/use رقم</code>.`, mainKeyboard);
  }

  if (!network) return;

  if (network.connection_mode === "agent" && ["status", "ping", "sales"].includes(action)) {
    return queueAgentAction(chatId, user, network, action as "status" | "ping" | "sales");
  }

  if (action === "status") {
    try {
      const status = await readStatus(network);
      const ram = status.totalMemory ? Math.round((1 - status.freeMemory / status.totalMemory) * 100) : 0;

      await dbPatch(
        "tg_networks",
        {
          status: "online",
          identity: status.identity,
          router_os_version: status.version,
          last_connected_at: new Date().toISOString(),
          last_error: null,
          updated_at: new Date().toISOString(),
        },
        { id: `eq.${network.id}` },
      );

      return send(
        chatId,
        `📊 <b>${esc(status.identity)} • الحالة الآن</b>\n━━━━━━━━━━━━━━━━━━\n🌐 الإنترنت: ${status.pingReplies > 0 ? "🟢 متصل" : "🔴 غير متصل"}\n📍 Ping: <b>${status.pingReplies}/3</b>\n🔗 PPPoE نشط: <b>${status.pppRunning}</b>\n👥 المتصلون: <b>${status.online}</b>\n⚙️ CPU: <b>${esc(status.cpu)}%</b>\n🧠 RAM: <b>${ram}%</b>\n⏱ Uptime: ${esc(status.uptime)}\n🧩 RouterOS: ${esc(status.version)}\n\n⚡ الاتصال: Direct API`,
      );
    } catch (error) {
      await dbPatch(
        "tg_networks",
        { status: "error", last_error: String(error), updated_at: new Date().toISOString() },
        { id: `eq.${network.id}` },
      );
      return send(chatId, `🔴 تعذر الاتصال بالشبكة.\n${esc(String(error instanceof Error ? error.message : error).slice(0, 300))}`);
    }
  }

  if (action === "ping") {
    try {
      const ping = await readPing(network);
      return send(
        chatId,
        `🌐 <b>اختبار الإنترنت</b>\n━━━━━━━━━━━━━━━━━━\n📍 8.8.8.8\n✅ الردود: <b>${ping.replies}/5</b>\n📉 الفقد: <b>${ping.loss}%</b>\n⏱ المتوسط: <b>${ping.average ?? "-"} ms</b>`,
      );
    } catch (error) {
      return send(chatId, `🔴 فشل اختبار Ping.\n${esc(String(error instanceof Error ? error.message : error).slice(0, 300))}`);
    }
  }

  if (action === "sales") {
    try {
      const sales = await syncAndReadSales(network);
      const lines = sales.slice(0, 30).map(
        (item, index) => `${index + 1}. 🎫 <code>${esc(item.username)}</code>${item.first_profile ? ` • ${esc(item.first_profile)}` : ""}${item.first_vlan_id ? ` • VLAN ${item.first_vlan_id}` : ""}`,
      );

      return send(
        chatId,
        `💰 <b>مبيعات اليوم • أول دخول فقط</b>\n━━━━━━━━━━━━━━━━━━\n🆕 الكروت التي كانت أول جلسة في تاريخها اليوم: <b>${sales.length}</b>\n\n${lines.join("\n") || "لا توجد مبيعات مسجلة حتى الآن."}${sales.length > 30 ? `\n\n… +${sales.length - 30} كرت` : ""}`,
      );
    } catch (error) {
      return send(chatId, `🔴 تعذر قراءة المبيعات.\n${esc(String(error instanceof Error ? error.message : error).slice(0, 300))}`);
    }
  }
}

export async function handleTelegramUpdate(update: TgUpdate) {
  const callback = update.callback_query;

  if (callback?.from) {
    const user = await ensureUser(callback.from);
    const chatId = callback.message?.chat.id ?? callback.from.id;
    const action = callback.data || "";
    await answerCallback(callback.id);

    if (action === "add_network") return beginAddNetwork(chatId, user.telegram_user_id);

    if (action === "cancel_setup") {
      await setState(user.telegram_user_id, "idle", {});
      return send(chatId, "✅ تم الإلغاء.", mainKeyboard);
    }

    if (action === "conn_direct") {
      if (user.setup_state !== "await_connection") return;
      await setState(user.telegram_user_id, "await_host", { ...(user.setup_data || {}), connection_mode: "direct" });
      return send(chatId, "☁️ أرسل <b>Cloud / DDNS / Public IP</b> للراوتر.\n\nمثال: <code>xxxx.sn.mynetname.net</code>");
    }

    if (action === "conn_agent") {
      if (user.setup_state !== "await_connection") return;
      return createAgentNetwork(chatId, user);
    }

    if (action === "proto_api_ssl" || action === "proto_api") {
      if (user.setup_state !== "await_protocol") return;
      const protocol = action === "proto_api_ssl" ? "api-ssl" : "api";
      const suggestedPort = protocol === "api-ssl" ? 8729 : 8728;
      await setState(user.telegram_user_id, "await_port", { ...(user.setup_data || {}), protocol });
      return send(chatId, `🔢 أرسل <b>API Port</b>.\n\nالافتراضي: <code>${suggestedPort}</code>\nويمكنك إرسال Port مخصص.`);
    }

    if (action.startsWith("agent_check:")) {
      const networkId = action.slice("agent_check:".length);
      const rows = await dbGet<Network>("tg_networks", {
        id: `eq.${networkId}`,
        telegram_user_id: `eq.${user.telegram_user_id}`,
        connection_mode: "eq.agent",
        select: "*",
        limit: "1",
      });
      const network = rows[0];
      if (!network) return send(chatId, "❌ لم أجد هذه الشبكة.");
      const seen = network.agent_last_seen_at ? new Date(network.agent_last_seen_at).getTime() : 0;
      if (Date.now() - seen > 60_000) {
        return send(
          chatId,
          "🟠 لم يصل Agent إلى السيرفر حتى الآن.\nتأكد أن الراوتر لديه إنترنت وأن أمر التثبيت ظهر في نهايته: <code>MT-TG Agent installed successfully</code>.",
        );
      }
      await send(chatId, "✅ <b>Agent متصل بالسحابة بنجاح</b>\nأجري الآن فحص الحالة والإصدار...");
      const refreshed = await ensureUser(callback.from);
      return runAction(chatId, refreshed, "status");
    }

    return runAction(chatId, user, action);
  }

  const message = update.message;
  if (!message?.from || !message.text) return;

  const user = await ensureUser(message.from);
  const text = message.text.trim();

  if (user.setup_state !== "idle" && text !== "/cancel") {
    const handled = await processSetup(message, user);
    if (handled !== false) return;
  }

  if (text === "/start" || text === "/help") return send(message.chat.id, homeText(message.from.first_name), mainKeyboard);
  if (text === "/add") return beginAddNetwork(message.chat.id, user.telegram_user_id);
  if (text === "/cancel") {
    await setState(user.telegram_user_id, "idle", {});
    return send(message.chat.id, "✅ تم الإلغاء.", mainKeyboard);
  }
  if (text === "/status") return runAction(message.chat.id, user, "status");
  if (text === "/sales") return runAction(message.chat.id, user, "sales");
  if (text === "/ping") return runAction(message.chat.id, user, "ping");
  if (text === "/networks") return runAction(message.chat.id, user, "networks");

  if (text.startsWith("/vlan ")) {
    const vlanId = Number(text.split(/\s+/)[1]);
    if (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094) {
      return send(message.chat.id, "⚠️ مثال صحيح: <code>/vlan 202</code>");
    }

    const network = await getActiveNetwork(user);
    if (!network) return send(message.chat.id, "📭 أضف شبكة أولاً.", mainKeyboard);

    if (network.connection_mode === "agent") {
      return queueAgentAction(message.chat.id, user, network, "vlan", { vlan_id: vlanId });
    }

    try {
      const vlan = await readVlan(network, vlanId);
      if (!vlan) return send(message.chat.id, "❌ VLAN غير موجود أو معطل.");
      return send(
        message.chat.id,
        `🧩 <b>VLAN ${vlanId} • ${esc(vlan.name)}</b>\n━━━━━━━━━━━━━━━━━━\n📦 الاستهلاك: <b>${formatBytes(vlan.total)}</b>\n⬇️ Download: ${formatBytes(vlan.tx)}\n⬆️ Upload: ${formatBytes(vlan.rx)}\n👥 متصل الآن: <b>${vlan.online}</b>`,
      );
    } catch (error) {
      return send(message.chat.id, `🔴 تعذر قراءة VLAN.\n${esc(String(error instanceof Error ? error.message : error).slice(0, 300))}`);
    }
  }

  if (text.startsWith("/use ")) {
    const index = Number(text.split(/\s+/)[1]);
    const list = await getNetworks(user.telegram_user_id);
    if (!Number.isInteger(index) || index < 1 || index > list.length) {
      return send(message.chat.id, "⚠️ استخدم /networks ثم /use رقم الشبكة.");
    }

    await dbPatch(
      "tg_users",
      { active_network_id: list[index - 1].id, updated_at: new Date().toISOString() },
      { telegram_user_id: `eq.${user.telegram_user_id}` },
    );

    return send(message.chat.id, `✅ الشبكة النشطة الآن: <b>${esc(list[index - 1].label)}</b>`, mainKeyboard);
  }

  return send(message.chat.id, "لم أفهم الأمر. استخدم /help أو الأزرار 👇", mainKeyboard);
}
