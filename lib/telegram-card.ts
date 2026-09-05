import { decryptSecret } from "./telegram-crypto";
import { dbGet } from "./telegram-db";
import { RouterOSClient } from "./routeros-api";
import type { TgUpdate } from "./telegram-extra";

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
};

function token() {
  const value = process.env.TELEGRAM_BOT_TOKEN;
  if (!value) throw new Error("TELEGRAM_BOT_TOKEN is missing");
  return value;
}

function esc(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function send(chatId: number, text: string) {
  const response = await fetch(`https://api.telegram.org/bot${token()}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.slice(0, 4000),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
    cache: "no-store",
  });
  const json = await response.json();
  if (!json.ok) throw new Error(json.description || `Telegram ${response.status}`);
  return json.result;
}

function clientFor(network: Network) {
  if (!network.host || !network.port || !network.username || !network.password_ciphertext) {
    throw new Error("بيانات Direct API غير مكتملة");
  }
  return new RouterOSClient({
    host: network.host,
    port: network.port,
    username: network.username,
    password: decryptSecret(network.password_ciphertext),
    tls: network.protocol === "api-ssl",
    rejectUnauthorized: network.tls_verify,
    timeoutMs: 16000,
  });
}

function n(value: unknown) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(2)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(2)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function startOf(row: Record<string, string>) {
  return row["from-time"] || row.started || row.start || row["start-time"] || "";
}

async function getContext(userId: number) {
  const users = await dbGet<BotUser>("tg_users", {
    telegram_user_id: `eq.${userId}`,
    select: "telegram_user_id,active_network_id",
    limit: "1",
  });
  const user = users[0];
  if (!user?.active_network_id) return null;
  const networks = await dbGet<Network>("tg_networks", {
    id: `eq.${user.active_network_id}`,
    telegram_user_id: `eq.${userId}`,
    select: "*",
    limit: "1",
  });
  return networks[0] ?? null;
}

async function inspectDirect(network: Network, username: string) {
  const client = clientFor(network);
  try {
    const major = Number(/^\d+/.exec(network.router_os_version || "")?.[0] || 0);
    const candidates = major >= 7
      ? [
          ["/user-manager/user/print", "/user-manager/session/print", "User Manager v7"],
          ["/tool/user-manager/user/print", "/tool/user-manager/session/print", "User Manager v6"],
        ]
      : [
          ["/tool/user-manager/user/print", "/tool/user-manager/session/print", "User Manager v6"],
          ["/user-manager/user/print", "/user-manager/session/print", "User Manager v7"],
        ];

    let userRow: Record<string, string> | null = null;
    let sessions: Record<string, string>[] = [];
    let source = "Hotspot";
    for (const [userPath, sessionPath, label] of candidates) {
      try {
        let rows = await client.command(userPath, [`?username=${username}`]);
        if (!rows.length) rows = await client.command(userPath, [`?name=${username}`]);
        const history = await client.command(sessionPath, [`?user=${username}`]);
        if (rows.length || history.length) {
          userRow = rows[0] || null;
          sessions = history;
          source = label;
          break;
        }
      } catch {}
    }

    let current: Record<string, string> | null = null;
    try {
      const active = await client.command("/ip/hotspot/active/print", [
        "=.proplist=user,address,mac-address,uptime,server,bytes-in,bytes-out,session-time-left,login-by",
        `?user=${username}`,
      ]);
      current = active[0] || null;
    } catch {}

    let localUser: Record<string, string> | null = null;
    try {
      const local = await client.command("/ip/hotspot/user/print", [`?name=${username}`]);
      localUser = local[0] || null;
    } catch {}

    const ordered = [...sessions].sort((a, b) => startOf(a).localeCompare(startOf(b)));
    const download = sessions.reduce((sum, row) => sum + n(row.download || row["download-bytes"] || row["bytes-out"]), 0);
    const upload = sessions.reduce((sum, row) => sum + n(row.upload || row["upload-bytes"] || row["bytes-in"]), 0);
    const causes = new Map<string, number>();
    for (const row of sessions) {
      const cause = row["terminate-cause"] || row["terminate-reason"] || row.cause || "unknown";
      causes.set(cause, (causes.get(cause) || 0) + 1);
    }

    return {
      found: Boolean(userRow || localUser || current || sessions.length),
      source,
      profile: userRow?.["actual-profile"] || userRow?.profile || localUser?.profile || "-",
      disabled: (userRow?.disabled || localUser?.disabled) === "true",
      lastSeen: userRow?.["last-seen"] || "-",
      current,
      sessions: ordered,
      download,
      upload,
      causes,
    };
  } finally {
    client.close();
  }
}

export async function handleTelegramCard(update: TgUpdate): Promise<boolean> {
  const message = update.message;
  if (!message?.from || !message.text) return false;
  const text = message.text.trim();
  const match = /^\/card(?:@\w+)?\s+([^\s]+)$/i.exec(text);
  if (!match) return false;

  const username = match[1].trim();
  const network = await getContext(message.from.id);
  if (!network) {
    await send(message.chat.id, "📭 لا توجد شبكة نشطة. استخدم /add أولاً.");
    return true;
  }

  if (network.connection_mode === "agent") {
    await send(
      message.chat.id,
      "🟠 فحص الكرت التفصيلي يحتاج إصدار Agent الأحدث. الشبكة متصلة، لكن هذا النوع من الفحص لم يُفعّل على الـAgent الحالي بعد.",
    );
    return true;
  }

  await send(message.chat.id, `🔎 جاري فحص الكرت <code>${esc(username)}</code> وسجل جلساته...`);

  try {
    const report = await inspectDirect(network, username);
    if (!report.found) {
      await send(message.chat.id, `❌ لم أجد الكرت <code>${esc(username)}</code> في User Manager أو Hotspot.`);
      return true;
    }

    const current = report.current;
    const newest = [...report.sessions].reverse().slice(0, 8);
    const causeText = [...report.causes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([cause, count]) => `• ${esc(cause)}: <b>${count}</b>`)
      .join("\n");

    let body = `🎫 <b>فحص الكرت ${esc(username)}</b>\n━━━━━━━━━━━━━━━━━━\n`;
    body += `📌 المصدر: ${esc(report.source)}\n`;
    body += `🏷 الفئة: <b>${esc(report.profile)}</b>\n`;
    body += `🚦 الحالة: ${current ? "🟢 متصل الآن" : "⚪ غير متصل الآن"}${report.disabled ? " • 🔴 معطل" : ""}\n`;
    body += `🧾 عدد الجلسات: <b>${report.sessions.length}</b>\n`;
    body += `🕐 أول جلسة: ${esc(report.sessions[0] ? startOf(report.sessions[0]) : "-")}\n`;
    body += `🕐 آخر جلسة: ${esc(report.sessions.length ? startOf(report.sessions[report.sessions.length - 1]) : report.lastSeen)}\n`;
    body += `⬇️ إجمالي التحميل: <b>${bytes(report.download)}</b>\n`;
    body += `⬆️ إجمالي الرفع: <b>${bytes(report.upload)}</b>\n`;

    if (current) {
      body += `\n📱 <b>الجلسة الحالية</b>\n`;
      body += `IP: <code>${esc(current.address || "-")}</code>\n`;
      body += `MAC: <code>${esc(current["mac-address"] || "-")}</code>\n`;
      body += `Hotspot: ${esc(current.server || "-")}\n`;
      body += `Uptime: ${esc(current.uptime || "-")}\n`;
      body += `Login by: ${esc(current["login-by"] || "-")}\n`;
      if (current["session-time-left"]) body += `الوقت المتبقي: ${esc(current["session-time-left"])}\n`;
    }

    if (causeText) body += `\n⚠️ <b>أسباب انتهاء الجلسات</b>\n${causeText}\n`;

    await send(message.chat.id, body);

    if (newest.length) {
      let sessionBody = `🗂 <b>آخر ${newest.length} جلسات</b>\n━━━━━━━━━━━━━━━━━━\n`;
      newest.forEach((row, index) => {
        sessionBody += `\n<b>${index + 1}.</b> ${esc(startOf(row) || "-")}\n`;
        sessionBody += `⏱ ${esc(row.uptime || "-")} • IP ${esc(row["user-ip"] || row.address || "-")}\n`;
        sessionBody += `⬇️ ${bytes(n(row.download || row["download-bytes"] || row["bytes-out"]))} • ⬆️ ${bytes(n(row.upload || row["upload-bytes"] || row["bytes-in"]))}\n`;
        const cause = row["terminate-cause"] || row["terminate-reason"] || row.cause;
        if (cause) sessionBody += `سبب الانتهاء: ${esc(cause)}\n`;
      });
      await send(message.chat.id, sessionBody);
    }
  } catch (error) {
    await send(
      message.chat.id,
      `🔴 تعذر فحص الكرت.\n<code>${esc(String(error instanceof Error ? error.message : error).slice(0, 300))}</code>`,
    );
  }

  return true;
}
