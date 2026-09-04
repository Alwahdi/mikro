import { randomUUID } from "crypto";
import { decryptSecret, encryptSecret } from "./telegram-crypto";
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
  host: string;
  port: number;
  username: string;
  password_ciphertext: string;
  protocol: "api" | "api-ssl";
  tls_verify: boolean;
  identity?: string | null;
  router_os_version?: string | null;
};

type UMCard = {
  username: string;
  first_profile: string | null;
  first_vlan_id: number | null;
  first_seen_router_time: string | null;
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

const protocolKeyboard = {
  inline_keyboard: [
    [{ text: "🔐 API-SSL", callback_data: "proto_api_ssl" }],
    [{ text: "🔌 API", callback_data: "proto_api" }],
    [{ text: "❌ إلغاء", callback_data: "cancel_setup" }],
  ],
};

function homeText(name?: string) {
  return `🤖 <b>MikroTik Network Bot</b>\n━━━━━━━━━━━━━━━━━━\nأهلاً${name ? ` ${name}` : ""} 👋\n\nأدر شبكتك من تيليجرام فقط. أضف الراوتر مرة واحدة، وبعدها استخدم الأزرار أو الأوامر مباشرة.`;
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

function setState(
  userId: number,
  setup_state: string,
  setup_data: Record<string, unknown> = {},
) {
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
  return `${(value / 1073741824).toFixed(2)} GB`;
}

function parseRouterDate(value: string) {
  const match = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/i.exec(
    value,
  );
  if (!match) return null;

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

  return new Date(
    Date.UTC(
      Number(match[3]),
      months[match[1].toLowerCase()],
      Number(match[2]),
      Number(match[4]) - 3,
      Number(match[5]),
      Number(match[6]),
    ),
  );
}

async function readStatus(network: Network) {
  const client = clientFor(network);
  try {
    const resource = await client.command("/system/resource/print");
    const identity = await client.command("/system/identity/print");
    const online = await client.command("/ip/hotspot/active/print", ["=.proplist=.id"]);

    let ppp: Record<string, string>[] = [];
    try {
      ppp = await client.command("/interface/pppoe-client/print", [
        "=.proplist=name,running,disabled",
      ]);
    } catch {}

    const row = resource[0] || {};
    return {
      identity: identity[0]?.name || network.label,
      version: row.version || network.router_os_version || "-",
      uptime: row.uptime || "-",
      cpu: row["cpu-load"] || "-",
      freeMemory: Number(row["free-memory"] || 0),
      totalMemory: Number(row["total-memory"] || 0),
      online: online.length,
      ppp:
        ppp.find((item) => item.name === "pppoe-out1")?.running === "true"
          ? "🟢 متصل"
          : "⚪ غير متأكد",
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
    const replies = times.length;
    return {
      replies,
      loss: Math.max(0, 100 - replies * 20),
      average: times.length
        ? Math.round(times.reduce((a, b) => a + b, 0) / times.length)
        : null,
    };
  } finally {
    client.close();
  }
}

async function readVlan(network: Network, vlanId: number) {
  const client = clientFor(network);
  try {
    const vlans = await client.command("/interface/vlan/print", [
      "=.proplist=.id,name,vlan-id,disabled,rx-byte,tx-byte",
    ]);
    const vlan = vlans.find(
      (item) => Number(item["vlan-id"]) === vlanId && item.disabled !== "true",
    );
    if (!vlan) return null;

    const rx = Number(vlan["rx-byte"] || 0);
    const tx = Number(vlan["tx-byte"] || 0);
    const prefix = `172.18.${vlanId}.`;
    const active = await client.command("/ip/hotspot/active/print", [
      "=.proplist=address",
    ]);

    return {
      name: vlan.name || String(vlanId),
      rx,
      tx,
      total: rx + tx,
      online: active.filter((item) =>
        String(item.address || "").startsWith(prefix),
      ).length,
    };
  } finally {
    client.close();
  }
}

async function syncAndReadSales(network: Network): Promise<UMCard[]> {
  const client = clientFor(network);
  try {
    let users: Record<string, string>[] = [];
    try {
      users = await client.command("/tool/user-manager/user/print", [
        "=.proplist=username,actual-profile,last-seen",
      ]);
    } catch {
      throw new Error("User Manager غير متاح عبر API في هذا الراوتر");
    }

    for (const user of users) {
      const username = user.username;
      if (!username) continue;

      const existing = await dbGet<{ username: string }>("tg_cards", {
        network_id: `eq.${network.id}`,
        username: `eq.${username}`,
        select: "username",
        limit: "1",
      });
      if (existing.length) continue;

      let sessions: Record<string, string>[] = [];
      try {
        sessions = await client.command("/tool/user-manager/session/print", [
          "=.proplist=user,from-time,user-ip",
          `?user=${username}`,
        ]);
      } catch {
        continue;
      }

      const ordered = sessions
        .map((session) => ({
          session,
          date: parseRouterDate(session["from-time"] || ""),
        }))
        .filter(
          (item): item is { session: Record<string, string>; date: Date } =>
            item.date instanceof Date,
        )
        .sort((a, b) => a.date.getTime() - b.date.getTime());

      if (!ordered.length) continue;

      const first = ordered[0];
      const ip = first.session["user-ip"] || "";
      const vlan = /^172\.18\.(\d+)\./.exec(ip);

      await dbInsert("tg_cards", {
        network_id: network.id,
        username,
        first_seen_at: first.date.toISOString(),
        first_seen_router_time: first.session["from-time"] || null,
        first_profile: user["actual-profile"] || null,
        first_vlan_id: vlan ? Number(vlan[1]) : null,
        last_seen_at: new Date().toISOString(),
        last_profile: user["actual-profile"] || null,
        last_vlan_id: vlan ? Number(vlan[1]) : null,
      });
    }

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    return dbGet<UMCard>("tg_cards", {
      network_id: `eq.${network.id}`,
      and: `(first_seen_at.gte.${start.toISOString()},first_seen_at.lt.${end.toISOString()})`,
      select: "username,first_profile,first_vlan_id,first_seen_router_time",
      order: "first_seen_at.asc",
    });
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

async function processSetup(message: TgMessage, user: BotUser) {
  const chatId = message.chat.id;
  const text = (message.text || "").trim();
  const data = user.setup_data || {};

  if (user.setup_state === "await_label") {
    if (!text) return;
    await setState(user.telegram_user_id, "await_host", { ...data, label: text });
    return send(
      chatId,
      "☁️ أرسل <b>Cloud / DDNS / IP</b> للراوتر.\n\nمثال: <code>xxxx.sn.mynetname.net</code>",
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
      return send(chatId, "⚠️ أرسل رقم Port صحيح بين 1 و 65535.\nمثال: <code>8778</code>");
    }
    await setState(user.telegram_user_id, "await_username", { ...data, port });
    return send(chatId, "👤 أرسل <b>API Username</b> للراوتر.");
  }

  if (user.setup_state === "await_username") {
    if (!text) return;
    await setState(user.telegram_user_id, "await_password", {
      ...data,
      username: text,
    });
    return send(
      chatId,
      "🔑 أرسل <b>API Password</b>.\nسأحذف رسالتك مباشرة بعد استلامها، ولن أعرض كلمة المرور مرة أخرى.",
    );
  }

  if (user.setup_state === "await_password") {
    if (!text) return;
    await deleteMessage(chatId, message.message_id);

    const setup: Record<string, unknown> = { ...data, password: text };
    await setState(user.telegram_user_id, "testing", { ...data });
    await send(
      chatId,
      "🔄 جاري اختبار الاتصال بالراوتر...\n\n☁️ Host\n🔌 API Port\n🔐 Authentication\n📡 RouterOS",
    );

    const temp: Network = {
      id: randomUUID(),
      telegram_user_id: user.telegram_user_id,
      label: String(setup.label),
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
      client.close();

      const saved = await dbInsert<Network>(
        "tg_networks",
        {
          telegram_user_id: user.telegram_user_id,
          label: temp.label,
          host: temp.host,
          port: temp.port,
          username: temp.username,
          password_ciphertext: temp.password_ciphertext,
          protocol: temp.protocol,
          tls_verify: false,
          identity: identity[0]?.name || temp.label,
          router_os_version: resource[0]?.version || null,
          status: "online",
          last_connected_at: new Date().toISOString(),
          last_error: null,
        },
        "*",
      );

      if (!saved[0]) throw new Error("Could not save router");

      await dbPatch(
        "tg_users",
        {
          active_network_id: saved[0].id,
          setup_state: "idle",
          setup_data: {},
          updated_at: new Date().toISOString(),
        },
        { telegram_user_id: `eq.${user.telegram_user_id}` },
      );

      return send(
        chatId,
        `🎉 <b>تم ربط الشبكة بنجاح</b>\n━━━━━━━━━━━━━━━━━━\n📡 ${identity[0]?.name || temp.label}\n🧠 RouterOS ${resource[0]?.version || "-"}\n☁️ ${temp.host}:${temp.port}\n🔌 ${temp.protocol.toUpperCase()}\n\nالبوت جاهز الآن.`,
        mainKeyboard,
      );
    } catch (error) {
      await setState(user.telegram_user_id, "idle", {});
      return send(
        chatId,
        `❌ <b>تعذر الاتصال</b>\n\n${String(error instanceof Error ? error.message : error).slice(0, 350)}\n\nتحقق من Cloud/IP وAPI Port واسم المستخدم وكلمة المرور.`,
        mainKeyboard,
      );
    }
  }

  return false;
}

async function runAction(chatId: number, user: BotUser, action: string) {
  const network = await getActiveNetwork(user);
  if (["status", "sales", "ping"].includes(action) && !network) {
    return send(
      chatId,
      "📭 لا توجد شبكة مرتبطة بعد. اضغط <b>➕ إضافة شبكة</b> أولاً.",
      mainKeyboard,
    );
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
      "⚙️ <b>الإعدادات</b>\nيمكنك إضافة أكثر من شبكة واختيار الشبكة النشطة من «شبكاتي».",
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
      .map(
        (item, index) =>
          `${index + 1}. ${item.id === user.active_network_id ? "🟢" : "⚪"} <b>${item.label}</b>\n   ${item.host}:${item.port} • ${item.protocol.toUpperCase()}`,
      )
      .join("\n\n");

    return send(
      chatId,
      `📡 <b>شبكاتي</b>\n━━━━━━━━━━━━━━━━━━\n${text}\n\nلتغيير الشبكة النشطة استخدم <code>/use رقم</code>.`,
      mainKeyboard,
    );
  }

  if (action === "status" && network) {
    try {
      const status = await readStatus(network);
      const ram = status.totalMemory
        ? Math.round((1 - status.freeMemory / status.totalMemory) * 100)
        : 0;

      await dbPatch(
        "tg_networks",
        {
          status: "online",
          identity: status.identity,
          router_os_version: status.version,
          last_connected_at: new Date().toISOString(),
          last_error: null,
        },
        { id: `eq.${network.id}` },
      );

      return send(
        chatId,
        `📊 <b>${status.identity} • الحالة الآن</b>\n━━━━━━━━━━━━━━━━━━\n🌐 الراوتر: 🟢 متصل\n🔗 PPPoE: ${status.ppp}\n👥 المتصلون: <b>${status.online}</b>\n⚙️ CPU: <b>${status.cpu}%</b>\n🧠 RAM: <b>${ram}%</b>\n⏱ Uptime: ${status.uptime}\n🧩 RouterOS: ${status.version}`,
      );
    } catch (error) {
      return send(
        chatId,
        `🔴 تعذر الاتصال بالشبكة.\n${String(error instanceof Error ? error.message : error).slice(0, 300)}`,
      );
    }
  }

  if (action === "ping" && network) {
    try {
      const ping = await readPing(network);
      return send(
        chatId,
        `🌐 <b>اختبار الإنترنت</b>\n━━━━━━━━━━━━━━━━━━\n📍 8.8.8.8\n✅ الردود: <b>${ping.replies}/5</b>\n📉 الفقد: <b>${ping.loss}%</b>\n⏱ المتوسط: <b>${ping.average ?? "-"} ms</b>`,
      );
    } catch (error) {
      return send(
        chatId,
        `🔴 فشل اختبار Ping.\n${String(error instanceof Error ? error.message : error).slice(0, 300)}`,
      );
    }
  }

  if (action === "sales" && network) {
    try {
      const sales = await syncAndReadSales(network);
      const lines = sales.slice(0, 20).map(
        (item, index) =>
          `${index + 1}. 🎫 <code>${item.username}</code>${item.first_profile ? ` • ${item.first_profile}` : ""}${item.first_vlan_id ? ` • VLAN ${item.first_vlan_id}` : ""}`,
      );

      return send(
        chatId,
        `💰 <b>مبيعات اليوم • أول دخول فقط</b>\n━━━━━━━━━━━━━━━━━━\n🆕 الكروت التي سجلت لأول مرة: <b>${sales.length}</b>\n\n${lines.join("\n") || "لا توجد مبيعات مسجلة حتى الآن."}${sales.length > 20 ? `\n\n… +${sales.length - 20} كرت` : ""}`,
      );
    } catch (error) {
      return send(
        chatId,
        `🔴 تعذر قراءة المبيعات.\n${String(error instanceof Error ? error.message : error).slice(0, 300)}`,
      );
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

    if (action === "add_network") {
      return beginAddNetwork(chatId, user.telegram_user_id);
    }

    if (action === "cancel_setup") {
      await setState(user.telegram_user_id, "idle", {});
      return send(chatId, "✅ تم الإلغاء.", mainKeyboard);
    }

    if (action === "proto_api_ssl" || action === "proto_api") {
      if (user.setup_state !== "await_protocol") return;
      const protocol = action === "proto_api_ssl" ? "api-ssl" : "api";
      const suggestedPort = protocol === "api-ssl" ? 8729 : 8728;
      await setState(user.telegram_user_id, "await_port", {
        ...(user.setup_data || {}),
        protocol,
      });
      return send(
        chatId,
        `🔢 أرسل <b>API Port</b>.\n\nالافتراضي لهذا النوع: <code>${suggestedPort}</code>\nويمكنك إرسال أي Port مخصص مثل <code>8778</code>.`,
      );
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

  if (text === "/start" || text === "/help") {
    return send(message.chat.id, homeText(message.from.first_name), mainKeyboard);
  }
  if (text === "/add") {
    return beginAddNetwork(message.chat.id, user.telegram_user_id);
  }
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

    try {
      const vlan = await readVlan(network, vlanId);
      if (!vlan) return send(message.chat.id, "❌ VLAN غير موجود أو معطل.");
      return send(
        message.chat.id,
        `🧩 <b>VLAN ${vlanId} • ${vlan.name}</b>\n━━━━━━━━━━━━━━━━━━\n📦 الاستهلاك: <b>${formatBytes(vlan.total)}</b>\n⬇️ Download: ${formatBytes(vlan.tx)}\n⬆️ Upload: ${formatBytes(vlan.rx)}\n👥 متصل الآن: <b>${vlan.online}</b>`,
      );
    } catch (error) {
      return send(
        message.chat.id,
        `🔴 تعذر قراءة VLAN.\n${String(error instanceof Error ? error.message : error).slice(0, 300)}`,
      );
    }
  }

  if (text.startsWith("/use ")) {
    const index = Number(text.split(/\s+/)[1]);
    const list = await getNetworks(user.telegram_user_id);
    if (!Number.isInteger(index) || index < 1 || index > list.length) {
      return send(
        message.chat.id,
        "⚠️ استخدم /networks ثم /use رقم الشبكة.",
      );
    }

    await dbPatch(
      "tg_users",
      {
        active_network_id: list[index - 1].id,
        updated_at: new Date().toISOString(),
      },
      { telegram_user_id: `eq.${user.telegram_user_id}` },
    );

    return send(
      message.chat.id,
      `✅ الشبكة النشطة الآن: <b>${list[index - 1].label}</b>`,
      mainKeyboard,
    );
  }

  return send(
    message.chat.id,
    "لم أفهم الأمر. استخدم /help أو الأزرار 👇",
    mainKeyboard,
  );
}
