import { decryptSecret } from "./telegram-crypto";
import { dbGet, dbInsert, dbPatch, dbUpsert } from "./telegram-db";
import { RouterOSClient } from "./routeros-api";

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

export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
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
  identity?: string | null;
  router_os_version?: string | null;
  agent_last_seen_at?: string | null;
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

function esc(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const enhancedKeyboard = {
  inline_keyboard: [
    [
      { text: "➕ إضافة شبكة", callback_data: "add_network" },
      { text: "📡 شبكاتي", callback_data: "networks" },
    ],
    [
      { text: "📊 الحالة", callback_data: "status" },
      { text: "👥 المتصلون", callback_data: "online" },
    ],
    [
      { text: "💰 مبيعات اليوم", callback_data: "sales" },
      { text: "🧩 VLANs", callback_data: "vlans" },
    ],
    [
      { text: "🌐 Ping", callback_data: "ping" },
      { text: "🛠 الراوتر", callback_data: "router_info" },
    ],
    [
      { text: "⚙️ الإعدادات", callback_data: "settings" },
      { text: "❓ مساعدة", callback_data: "extra_help" },
    ],
  ],
};

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

async function getNetwork(user: BotUser): Promise<Network | null> {
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
    timeoutMs: 12000,
  });
}

async function queueAgent(
  chatId: number,
  user: BotUser,
  network: Network,
  kind: "online" | "vlans" | "router",
) {
  const last = network.agent_last_seen_at ? new Date(network.agent_last_seen_at).getTime() : 0;
  const online = Date.now() - last < 60_000;
  const waiting = await send(
    chatId,
    `${online ? "⏳" : "🟠"} <b>${esc(network.label)}</b>\n${online ? "جاري جلب البيانات عبر Agent..." : "Agent غير ظاهر الآن؛ سأحتفظ بالطلب مؤقتًا."}`,
  );

  await dbInsert(
    "tg_agent_commands",
    {
      network_id: network.id,
      telegram_user_id: user.telegram_user_id,
      chat_id: chatId,
      reply_message_id: waiting.message_id,
      kind,
      payload: {},
      status: "pending",
    },
  );
}

async function directRouterInfo(network: Network) {
  const client = clientFor(network);
  try {
    const [resource, identity] = await Promise.all([
      client.command("/system/resource/print"),
      client.command("/system/identity/print"),
    ]);
    let clock: Record<string, string>[] = [];
    try {
      clock = await client.command("/system/clock/print");
    } catch {}
    const row = resource[0] || {};
    return {
      identity: identity[0]?.name || network.label,
      version: row.version || network.router_os_version || "-",
      board: row["board-name"] || row.platform || "-",
      architecture: row["architecture-name"] || "-",
      cpu: row.cpu || "-",
      cores: row["cpu-count"] || "-",
      frequency: row["cpu-frequency"] || "-",
      uptime: row.uptime || "-",
      timezone: clock[0]?.["time-zone-name"] || clock[0]?.["gmt-offset"] || "-",
    };
  } finally {
    client.close();
  }
}

async function directOnline(network: Network) {
  const client = clientFor(network);
  try {
    return await client.command("/ip/hotspot/active/print", [
      "=.proplist=user,address,mac-address,uptime,server",
    ]);
  } catch {
    return [];
  } finally {
    client.close();
  }
}

async function directVlans(network: Network) {
  const client = clientFor(network);
  try {
    const rows = await client.command("/interface/vlan/print", [
      "=.proplist=name,vlan-id,disabled,running",
    ]);
    return rows
      .filter((row) => row.disabled !== "true")
      .sort((a, b) => Number(a["vlan-id"] || 0) - Number(b["vlan-id"] || 0));
  } finally {
    client.close();
  }
}

function helpText() {
  return `🤖 <b>MikroTik Network Bot</b>\n━━━━━━━━━━━━━━━━━━\n<b>المراقبة:</b>\n/status — حالة الإنترنت والراوتر\n/ping — اختبار 8.8.8.8\n/online — المستخدمون المتصلون\n/vlans — VLANs المفعلة\n/vlan 202 — تفاصيل VLAN محدد\n/router — معلومات الجهاز والإصدار\n/sales — أول دخول للكروت اليوم\n\n<b>الشبكات:</b>\n/add — إضافة شبكة\n/networks — شبكاتي\n/use 1 — اختيار شبكة\n/cancel — إلغاء الإعداد\n\nيدعم Direct API، وAgent HTTPS للشبكات بدون DDNS/Public IP.`;
}

async function runExtra(chatId: number, user: BotUser, kind: "online" | "vlans" | "router") {
  const network = await getNetwork(user);
  if (!network) {
    return send(chatId, "📭 لا توجد شبكة مرتبطة بعد. اضغط <b>➕ إضافة شبكة</b>.", enhancedKeyboard);
  }

  if (network.connection_mode === "agent") {
    return queueAgent(chatId, user, network, kind);
  }

  try {
    if (kind === "router") {
      const info = await directRouterInfo(network);
      return send(
        chatId,
        `🛠 <b>${esc(info.identity)} • معلومات الراوتر</b>\n━━━━━━━━━━━━━━━━━━\n🧩 RouterOS: <b>${esc(info.version)}</b>\n📦 الجهاز: ${esc(info.board)}\n🏗 Architecture: ${esc(info.architecture)}\n🧠 CPU: ${esc(info.cpu)} • ${esc(info.cores)} Core\n⚡ Frequency: ${esc(info.frequency)} MHz\n⏱ Uptime: ${esc(info.uptime)}\n🕐 Timezone: ${esc(info.timezone)}\n\n🔗 الاتصال: Direct ${network.protocol.toUpperCase()}`,
      );
    }

    if (kind === "online") {
      const rows = await directOnline(network);
      const visible = rows.slice(0, 30);
      const lines = visible.map((row, index) => {
        const userName = row.user || "-";
        return `${index + 1}. 👤 <code>${esc(userName)}</code> • ${esc(row.address || "-")}\n   📍 ${esc(row.server || "-")} • ⏱ ${esc(row.uptime || "-")}`;
      });
      return send(
        chatId,
        `👥 <b>${esc(network.identity || network.label)} • المتصلون الآن</b>\n━━━━━━━━━━━━━━━━━━\n🟢 العدد: <b>${rows.length}</b>\n\n${lines.join("\n") || "لا يوجد مستخدمون متصلون الآن."}${rows.length > visible.length ? `\n\n… +${rows.length - visible.length} مستخدم` : ""}`,
      );
    }

    const rows = await directVlans(network);
    const visible = rows.slice(0, 80);
    const lines = visible.map(
      (row) => `• <b>VLAN ${esc(row["vlan-id"] || "-")}</b> — ${esc(row.name || "-")}${row.running === "false" ? " ⚠️" : ""}`,
    );
    return send(
      chatId,
      `🧩 <b>${esc(network.identity || network.label)} • VLANs المفعلة</b>\n━━━━━━━━━━━━━━━━━━\n✅ العدد: <b>${rows.length}</b>\n🚫 المعطلة: مستبعدة\n\n${lines.join("\n") || "لا توجد VLANs مفعلة."}${rows.length > visible.length ? `\n\n… +${rows.length - visible.length} VLAN` : ""}\n\nللتفاصيل: <code>/vlan 202</code>`,
    );
  } catch (error) {
    await dbPatch(
      "tg_networks",
      { status: "error", last_error: String(error), updated_at: new Date().toISOString() },
      { id: `eq.${network.id}` },
    );
    return send(
      chatId,
      `🔴 تعذر جلب البيانات.\n<code>${esc(String(error instanceof Error ? error.message : error).slice(0, 300))}</code>`,
    );
  }
}

export async function handleTelegramExtra(update: TgUpdate): Promise<boolean> {
  const callback = update.callback_query;
  if (callback?.from) {
    const action = callback.data || "";
    if (!["online", "vlans", "router_info", "extra_help"].includes(action)) return false;
    await answerCallback(callback.id);
    const user = await ensureUser(callback.from);
    const chatId = callback.message?.chat.id ?? callback.from.id;

    if (action === "extra_help") {
      await send(chatId, helpText(), enhancedKeyboard);
      return true;
    }
    if (action === "online") await runExtra(chatId, user, "online");
    if (action === "vlans") await runExtra(chatId, user, "vlans");
    if (action === "router_info") await runExtra(chatId, user, "router");
    return true;
  }

  const message = update.message;
  if (!message?.from || !message.text) return false;
  const text = message.text.trim();

  if (text === "/start") {
    await ensureUser(message.from);
    await send(
      message.chat.id,
      `🤖 <b>MikroTik Network Bot</b>\n━━━━━━━━━━━━━━━━━━\nأهلاً ${esc(message.from.first_name || "")} 👋\n\nمراقبة وإدارة شبكتك من Telegram فقط. اختر من القائمة 👇`,
      enhancedKeyboard,
    );
    return true;
  }

  if (text === "/help") {
    await ensureUser(message.from);
    await send(message.chat.id, helpText(), enhancedKeyboard);
    return true;
  }

  const map: Record<string, "online" | "vlans" | "router"> = {
    "/online": "online",
    "/vlans": "vlans",
    "/router": "router",
    "/info": "router",
  };
  const kind = map[text];
  if (!kind) return false;

  const user = await ensureUser(message.from);
  await runExtra(message.chat.id, user, kind);
  return true;
}
