import { decryptSecret, encryptSecret } from "./telegram-crypto";
import { dbGet, dbInsert, dbPatch } from "./telegram-db";
import { RouterOSClient } from "./routeros-api";
import { normalizeLocalText } from "./telegram-nlu-v2";
import { handleTelegramCardUniversal } from "./telegram-card-universal";
import type { TgUpdate } from "./telegram-extra";

type Source = "hotspot" | "user-manager-v6" | "user-manager-v7";
type Operation = "change_profile" | "change_password" | "delete_user";

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

type BotUser = { telegram_user_id: number; active_network_id?: string | null };

type AdminSession = {
  id: string;
  telegram_user_id: number;
  chat_id: number;
  network_id: string;
  operation: Operation;
  username: string;
  source?: Source | null;
  profiles: string[];
  selected_profile?: string | null;
  password_ciphertext?: string | null;
  step: string;
  expires_at: string;
  created_at: string;
};

type PendingAction = {
  id: string;
  telegram_user_id: number;
  chat_id: number;
  network_id: string;
  action_type: string;
  target_type: string;
  target_value: string;
  preview: Record<string, unknown>;
  status: string;
  expires_at: string;
};

type UserResolved = {
  source: Source;
  entry: Record<string, string>;
  active: Record<string, string>[];
  profiles: string[];
  version: string;
  customer?: string | null;
};

function botToken() {
  const value = process.env.TELEGRAM_BOT_TOKEN;
  if (!value) throw new Error("TELEGRAM_BOT_TOKEN missing");
  return value;
}

function esc(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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

async function edit(chatId: number, messageId: number, text: string, reply_markup?: unknown) {
  try {
    return await telegram("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup,
    });
  } catch {
    return null;
  }
}

async function answer(callbackId: string, text?: string, alert = false) {
  try {
    await telegram("answerCallbackQuery", {
      callback_query_id: callbackId,
      text,
      show_alert: alert,
    });
  } catch {}
}

async function deleteMessage(chatId: number, messageId: number) {
  try {
    await telegram("deleteMessage", { chat_id: chatId, message_id: messageId });
  } catch {}
}

async function activeNetwork(userId: number) {
  const users = await dbGet<BotUser>("tg_users", {
    telegram_user_id: `eq.${userId}`,
    select: "telegram_user_id,active_network_id",
    limit: "1",
  });
  const networkId = users[0]?.active_network_id;
  if (!networkId) return null;
  const networks = await dbGet<Network>("tg_networks", {
    id: `eq.${networkId}`,
    telegram_user_id: `eq.${userId}`,
    select: "*",
    limit: "1",
  });
  return networks[0] ?? null;
}

async function exactNetwork(userId: number, networkId: string) {
  const rows = await dbGet<Network>("tg_networks", {
    id: `eq.${networkId}`,
    telegram_user_id: `eq.${userId}`,
    select: "*",
    limit: "1",
  });
  return rows[0] ?? null;
}

function routerClient(network: Network) {
  if (
    network.connection_mode !== "direct" ||
    !network.host ||
    !network.port ||
    !network.username ||
    !network.password_ciphertext
  ) {
    throw new Error("هذه العملية تحتاج Direct API أو Privileged Agent مفعّل.");
  }
  return new RouterOSClient({
    host: network.host,
    port: network.port,
    username: network.username,
    password: decryptSecret(network.password_ciphertext),
    tls: network.protocol === "api-ssl",
    rejectUnauthorized: network.tls_verify,
    timeoutMs: 25000,
  });
}

function isDisabled(value?: string) {
  return value === "true" || value === "yes";
}

function sourceLabel(source: Source) {
  if (source === "hotspot") return "Hotspot Local User";
  if (source === "user-manager-v6") return "User Manager v6";
  return "User Manager v7";
}

function currentProfile(user: UserResolved) {
  return user.entry.profile || user.entry["actual-profile"] || user.entry.group || "-";
}

async function audit(params: {
  telegram_user_id: number;
  chat_id: number;
  network_id: string;
  pending_action_id?: string | null;
  action_type: string;
  target_value: string;
  phase: string;
  details?: Record<string, unknown>;
}) {
  await dbInsert("tg_action_audit", {
    telegram_user_id: params.telegram_user_id,
    chat_id: params.chat_id,
    network_id: params.network_id,
    pending_action_id: params.pending_action_id || null,
    action_type: params.action_type,
    target_type: "user",
    target_value: params.target_value,
    phase: params.phase,
    details: params.details || {},
  });
}

async function resolveUser(client: RouterOSClient, username: string): Promise<UserResolved | null> {
  const active = await client.command("/ip/hotspot/active/print", [
    "=.proplist=.id,user,address,mac-address,server,uptime,bytes-in,bytes-out",
    `?user=${username}`,
  ]);

  const resources = await client.command("/system/resource/print", ["=.proplist=version"]);
  const version = resources[0]?.version || "";
  const major = Number(/^\d+/.exec(version)?.[0] || 0);

  const hotspotUsers = await client.command("/ip/hotspot/user/print", [
    "=.proplist=.id,name,profile,disabled,comment",
    `?name=${username}`,
  ]);
  if (hotspotUsers[0]) {
    const profiles = await client.command("/ip/hotspot/user/profile/print", ["=.proplist=name"]);
    return {
      source: "hotspot",
      entry: hotspotUsers[0],
      active,
      profiles: profiles.map((row) => row.name).filter(Boolean),
      version,
    };
  }

  if (major >= 7) {
    try {
      const users = await client.command("/user-manager/user/print", [
        "=.proplist=.id,name,group,disabled,comment",
        `?name=${username}`,
      ]);
      if (users[0]) {
        const profiles = await client.command("/user-manager/profile/print", ["=.proplist=name"]);
        try {
          const monitor = await client.command("/user-manager/user/monitor", [`=numbers=${username}`]);
          const actual = monitor[0]?.["actual-profile"];
          if (actual) users[0]["actual-profile"] = actual;
        } catch {}
        return {
          source: "user-manager-v7",
          entry: users[0],
          active,
          profiles: profiles.map((row) => row.name).filter(Boolean),
          version,
        };
      }
    } catch {}
  } else {
    try {
      const users = await client.command("/tool/user-manager/user/print", [
        "=.proplist=.id,username,actual-profile,disabled,customer",
        `?username=${username}`,
      ]);
      if (users[0]) {
        const profiles = await client.command("/tool/user-manager/profile/print", ["=.proplist=name"]);
        let customer = users[0].customer || "";
        if (!customer) {
          try {
            const customers = await client.command("/tool/user-manager/customer/print");
            customer = customers[0]?.login || customers[0]?.name || customers[0]?.username || "admin";
          } catch {
            customer = "admin";
          }
        }
        return {
          source: "user-manager-v6",
          entry: users[0],
          active,
          profiles: profiles.map((row) => row.name).filter(Boolean),
          version,
          customer,
        };
      }
    } catch {}
  }

  return null;
}

function cleanUsername(value?: string | null) {
  if (!value) return null;
  const cleaned = value.trim().replace(/^["'«]+|["'»،,.!?]+$/g, "");
  if (!/^[\p{L}\p{N}_.@:+-]{2,128}$/u.test(cleaned)) return null;
  return cleaned;
}

function usernameFrom(raw: string) {
  const quoted = cleanUsername(raw.match(/["'«]([^"'»]{2,128})["'»]/u)?.[1]);
  if (quoted) return quoted;
  const noun = raw.match(
    /(?:مستخدم|المستخدم|يوزر|اليوزر|كرت|الكرت|مشترك|user|card|account)\s*(?:رقم|اسم|اسمه|name|number)?\s*[:#-]?\s*([\p{L}\p{N}_.@:+-]{2,128})/iu,
  )?.[1];
  return cleanUsername(noun);
}

function profileHint(raw: string, username: string) {
  const index = raw.toLowerCase().indexOf(username.toLowerCase());
  if (index < 0) return null;
  const after = raw.slice(index + username.length);
  return (
    after.match(
      /(?:الى|إلى|الي|على|لباقة|لباقه|to|profile|plan)\s*[:#-]?\s*([\p{L}\p{N}_.@:+-]{1,128})/iu,
    )?.[1]?.trim() || null
  );
}

function parseRequest(raw: string): { operation: Operation; username: string; profile_hint?: string | null } | null {
  const normalized = normalizeLocalText(raw);
  const parts = raw.trim().split(/\s+/);
  let operation: Operation | null = null;

  if (
    /(?:احذف|حذف|امسح|مسح|شيل|ازل|remove|delete)\s*(?:لي\s*)?(?:المستخدم|مستخدم|اليوزر|يوزر|الكرت|كرت|user|card|account)/iu.test(normalized) ||
    /^\/(?:deleteuser|deluser|removeuser)\b/i.test(raw) ||
    /^\/user\s+(?:delete|remove)\b/i.test(raw)
  ) operation = "delete_user";

  else if (
    /(?:غير|غيّر|بدل|حوّل|حول|change|switch)\s*(?:لي\s*)?(?:الباقه|الباقة|البروفايل|بروفايل|profile|plan)/iu.test(normalized) ||
    /^\/(?:profile|setprofile)\b/i.test(raw) ||
    /^\/user\s+profile\b/i.test(raw)
  ) operation = "change_profile";

  else if (
    /(?:غير|غيّر|بدل|reset|change)\s*(?:لي\s*)?(?:كلمه\s*المرور|كلمة\s*المرور|الباسورد|باسورد|password|passwd|pass)/iu.test(normalized) ||
    /^\/(?:password|passwd|setpass)\b/i.test(raw) ||
    /^\/user\s+(?:password|passwd)\b/i.test(raw)
  ) operation = "change_password";

  if (!operation) return null;

  let username = usernameFrom(raw);
  if (!username && /^\/user$/i.test(parts[0] || "") && parts[2]) username = cleanUsername(parts[2]);
  if (
    !username &&
    /^\/(?:profile|setprofile|password|passwd|setpass|deleteuser|deluser|removeuser)$/i.test(parts[0] || "") &&
    parts[1]
  ) username = cleanUsername(parts[1]);
  if (!username) return null;

  return {
    operation,
    username,
    profile_hint: operation === "change_profile" ? profileHint(raw, username) : null,
  };
}

function profileKeyboard(sessionId: string, profiles: string[]) {
  const buttons = profiles.slice(0, 20).map((profile, index) => ({
    text: profile,
    callback_data: `ua:p:${sessionId}:${index}`,
  }));
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([{ text: "❌ إلغاء", callback_data: `ua:no:${sessionId}` }]);
  return { inline_keyboard: rows };
}

function passwordKeyboard(sessionId: string) {
  return {
    inline_keyboard: [
      [{ text: "🔑 نفس اسم المستخدم", callback_data: `ua:same:${sessionId}` }],
      [{ text: "✍️ كلمة مرور جديدة", callback_data: `ua:custom:${sessionId}` }],
      [{ text: "❌ إلغاء", callback_data: `ua:no:${sessionId}` }],
    ],
  };
}

function actionKeyboard(actionId: string, label: string) {
  return {
    inline_keyboard: [
      [{ text: label, callback_data: `ua:ok:${actionId}` }],
      [{ text: "❌ إلغاء", callback_data: `ua:cancel:${actionId}` }],
    ],
  };
}

function deleteStage1Keyboard(actionId: string) {
  return {
    inline_keyboard: [
      [{ text: "⚠️ متابعة الحذف", callback_data: `ua:del1:${actionId}` }],
      [{ text: "❌ إلغاء", callback_data: `ua:cancel:${actionId}` }],
    ],
  };
}

function deleteStage2Keyboard(actionId: string) {
  return {
    inline_keyboard: [
      [{ text: "🗑 نعم، احذف نهائيًا", callback_data: `ua:del2:${actionId}` }],
      [{ text: "❌ تراجع", callback_data: `ua:cancel:${actionId}` }],
    ],
  };
}

async function cancelOpenSessions(userId: number) {
  const rows = await dbGet<AdminSession>("tg_user_admin_sessions", {
    telegram_user_id: `eq.${userId}`,
    step: "in.(choose_profile,choose_password,await_password)",
    select: "*",
    order: "created_at.desc",
    limit: "20",
  });
  for (const session of rows) {
    await dbPatch(
      "tg_user_admin_sessions",
      { step: "cancelled", updated_at: new Date().toISOString() },
      { id: `eq.${session.id}` },
    );
  }
}

async function createPending(
  session: AdminSession,
  user: UserResolved,
  actionType: string,
  extra: Record<string, unknown>,
) {
  const rows = await dbInsert<PendingAction>(
    "tg_pending_actions",
    {
      telegram_user_id: session.telegram_user_id,
      chat_id: session.chat_id,
      network_id: session.network_id,
      action_type: actionType,
      target_type: "user",
      target_value: session.username,
      preview: {
        source: user.source,
        current_profile: currentProfile(user),
        active_sessions: user.active.length,
        currently_disabled: isDisabled(user.entry.disabled),
        ...extra,
      },
      status: "pending",
    },
    "*",
  );
  const pending = rows[0];
  if (!pending) throw new Error("تعذر إنشاء طلب التأكيد");

  const safeExtra = Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "password_ciphertext"));
  await audit({
    telegram_user_id: session.telegram_user_id,
    chat_id: session.chat_id,
    network_id: session.network_id,
    pending_action_id: pending.id,
    action_type: actionType,
    target_value: session.username,
    phase: "preview",
    details: {
      source: user.source,
      current_profile: currentProfile(user),
      active_sessions: user.active.length,
      ...safeExtra,
    },
  });
  return pending;
}

async function startRequest(
  update: TgUpdate,
  request: { operation: Operation; username: string; profile_hint?: string | null },
) {
  const message = update.message;
  if (!message?.from) return false;

  const network = await activeNetwork(message.from.id);
  if (!network) {
    await send(message.chat.id, "📭 لا توجد شبكة نشطة.");
    return true;
  }
  if (network.connection_mode !== "direct") {
    await send(
      message.chat.id,
      "🔐 <b>إدارة المستخدمين الكتابية تحتاج Privileged Agent opt-in لهذه الشبكة.</b>\nلن أرفع صلاحيات Agent القراءة تلقائيًا.",
    );
    return true;
  }

  const client = routerClient(network);
  try {
    const user = await resolveUser(client, request.username);
    if (!user) {
      await send(message.chat.id, `❌ لم أجد المستخدم <code>${esc(request.username)}</code> في Hotspot أو User Manager. لم أنفذ شيئًا.`);
      return true;
    }

    await cancelOpenSessions(message.from.id);
    const step = request.operation === "change_profile"
      ? "choose_profile"
      : request.operation === "change_password"
        ? "choose_password"
        : "delete_preview";

    const sessions = await dbInsert<AdminSession>(
      "tg_user_admin_sessions",
      {
        telegram_user_id: message.from.id,
        chat_id: message.chat.id,
        network_id: network.id,
        operation: request.operation,
        username: request.username,
        source: user.source,
        profiles: user.profiles,
        step,
      },
      "*",
    );
    const session = sessions[0];
    if (!session) throw new Error("تعذر بدء جلسة الإدارة");

    if (request.operation === "change_profile") {
      if (!user.profiles.length) {
        await send(message.chat.id, "⚠️ لم أجد Profiles متاحة على هذا النظام.");
        return true;
      }

      const hinted = request.profile_hint
        ? user.profiles.find((profile) => normalizeLocalText(profile) === normalizeLocalText(request.profile_hint || ""))
        : undefined;

      if (hinted) {
        await dbPatch(
          "tg_user_admin_sessions",
          { selected_profile: hinted, step: "selected", updated_at: new Date().toISOString() },
          { id: `eq.${session.id}` },
        );
        const pending = await createPending(
          { ...session, selected_profile: hinted },
          user,
          "change_user_profile",
          { new_profile: hinted },
        );
        await send(
          message.chat.id,
          `🛡 <b>معاينة تغيير الباقة</b>\n━━━━━━━━━━━━━━━━━━\n📡 ${esc(network.identity || network.label)}\n👤 <code>${esc(request.username)}</code>\n📚 ${esc(sourceLabel(user.source))}\n🏷 الحالية: <b>${esc(currentProfile(user))}</b>\n➡️ الجديدة: <b>${esc(hinted)}</b>\n👥 جلسات نشطة: <b>${user.active.length}</b>\n\nلن أفصل الجلسة الحالية تلقائيًا.`,
          actionKeyboard(pending.id, "✅ غيّر الباقة"),
        );
        return true;
      }

      await send(
        message.chat.id,
        `🏷 <b>تغيير باقة المستخدم</b>\n━━━━━━━━━━━━━━━━━━\n👤 <code>${esc(request.username)}</code>\n📚 ${esc(sourceLabel(user.source))}\nالحالية: <b>${esc(currentProfile(user))}</b>\n\nاختر الباقة الجديدة:`,
        profileKeyboard(session.id, user.profiles),
      );
      return true;
    }

    if (request.operation === "change_password") {
      await send(
        message.chat.id,
        `🔐 <b>تغيير كلمة المرور</b>\n━━━━━━━━━━━━━━━━━━\n👤 <code>${esc(request.username)}</code>\n📚 ${esc(sourceLabel(user.source))}\n\nاختر الطريقة:`,
        passwordKeyboard(session.id),
      );
      return true;
    }

    const pending = await createPending(session, user, "delete_user", {
      profile: currentProfile(user),
      disabled: isDisabled(user.entry.disabled),
      active_ips: user.active.map((row) => row.address).filter(Boolean).slice(0, 8),
    });
    await send(
      message.chat.id,
      `🗑 <b>معاينة حذف المستخدم</b>\n━━━━━━━━━━━━━━━━━━\n📡 ${esc(network.identity || network.label)}\n👤 <code>${esc(request.username)}</code>\n📚 ${esc(sourceLabel(user.source))}\n🏷 الباقة: <b>${esc(currentProfile(user))}</b>\n🚦 الحالة: ${isDisabled(user.entry.disabled) ? "⛔ معطل" : "🟢 مفعّل"}\n👥 جلسات نشطة: <b>${user.active.length}</b>\n\n⚠️ الحذف نهائي من قاعدة المستخدمين. إذا أكملت سأطلب تأكيدًا ثانيًا قبل التنفيذ.`,
      deleteStage1Keyboard(pending.id),
    );
    return true;
  } catch (error) {
    await send(message.chat.id, `🔴 تعذر تجهيز العملية.\n<code>${esc(error instanceof Error ? error.message : error)}</code>`);
    return true;
  } finally {
    client.close();
  }
}

async function latestAwaitingPassword(userId: number) {
  const rows = await dbGet<AdminSession>("tg_user_admin_sessions", {
    telegram_user_id: `eq.${userId}`,
    operation: "eq.change_password",
    step: "eq.await_password",
    select: "*",
    order: "created_at.desc",
    limit: "1",
  });
  return rows[0] ?? null;
}

async function showPasswordPreview(session: AdminSession, passwordCiphertext: string) {
  const network = await exactNetwork(session.telegram_user_id, session.network_id);
  if (!network) throw new Error("الشبكة لم تعد موجودة");
  const client = routerClient(network);
  try {
    const user = await resolveUser(client, session.username);
    if (!user) throw new Error("المستخدم لم يعد موجودًا");
    await dbPatch(
      "tg_user_admin_sessions",
      { password_ciphertext: passwordCiphertext, step: "selected", updated_at: new Date().toISOString() },
      { id: `eq.${session.id}` },
    );
    const pending = await createPending(
      { ...session, password_ciphertext: passwordCiphertext },
      user,
      "change_user_password",
      { password_ciphertext: passwordCiphertext },
    );
    await send(
      session.chat_id,
      `🛡 <b>معاينة تغيير كلمة المرور</b>\n━━━━━━━━━━━━━━━━━━\n📡 ${esc(network.identity || network.label)}\n👤 <code>${esc(session.username)}</code>\n📚 ${esc(sourceLabel(user.source))}\n🔑 كلمة المرور الجديدة: <b>محفوظة ومخفية</b>\n👥 جلسات نشطة: <b>${user.active.length}</b>\n\nلن أفصل الجلسة الحالية تلقائيًا.`,
      actionKeyboard(pending.id, "✅ غيّر كلمة المرور"),
    );
  } finally {
    client.close();
  }
}

async function executeProfile(client: RouterOSClient, user: UserResolved, username: string, newProfile: string) {
  if (!user.profiles.includes(newProfile)) throw new Error("الباقة المطلوبة لم تعد موجودة على الراوتر");

  if (user.source === "hotspot") {
    await client.command("/ip/hotspot/user/set", [`=.id=${user.entry[".id"]}`, `=profile=${newProfile}`]);
    return;
  }

  if (user.source === "user-manager-v6") {
    await client.command("/tool/user-manager/user/create-and-activate-profile", [
      `=customer=${user.customer || "admin"}`,
      `=numbers=${username}`,
      `=profile=${newProfile}`,
    ]);
    return;
  }

  await client.command("/user-manager/user-profile/add", [`=user=${username}`, `=profile=${newProfile}`]);
  let created: Record<string, string> | undefined;
  try {
    const rows = await client.command("/user-manager/user-profile/print", [
      "=.proplist=.id,user,profile,state",
      `?user=${username}`,
      `?profile=${newProfile}`,
    ]);
    created = rows[rows.length - 1];
    if (created?.[".id"]) {
      await client.command("/user-manager/user-profile/activate-user-profile", [`=.id=${created[".id"]}`]);
    }
  } catch (error) {
    if (created?.[".id"]) {
      try {
        await client.command("/user-manager/user-profile/remove", [`=.id=${created[".id"]}`]);
      } catch {}
    }
    throw new Error(`تفعيل الباقة الجديدة فشل وتم التراجع عن الإضافة: ${error instanceof Error ? error.message : error}`);
  }
}

async function executePassword(client: RouterOSClient, user: UserResolved, newPassword: string) {
  const path = user.source === "hotspot"
    ? "/ip/hotspot/user/set"
    : user.source === "user-manager-v6"
      ? "/tool/user-manager/user/set"
      : "/user-manager/user/set";
  await client.command(path, [`=.id=${user.entry[".id"]}`, `=password=${newPassword}`]);
}

async function executeDelete(client: RouterOSClient, user: UserResolved) {
  for (const active of user.active) {
    if (!active[".id"]) continue;
    try {
      await client.command("/ip/hotspot/active/remove", [`=.id=${active[".id"]}`]);
    } catch {}
  }
  const path = user.source === "hotspot"
    ? "/ip/hotspot/user/remove"
    : user.source === "user-manager-v6"
      ? "/tool/user-manager/user/remove"
      : "/user-manager/user/remove";
  await client.command(path, [`=.id=${user.entry[".id"]}`]);
}

async function executePending(
  pending: PendingAction,
  callbackId: string,
  chatId: number,
  messageId?: number,
) {
  const network = await exactNetwork(pending.telegram_user_id, pending.network_id);
  if (!network) throw new Error("الشبكة لم تعد موجودة");
  const client = routerClient(network);

  try {
    const user = await resolveUser(client, pending.target_value);
    if (!user) throw new Error("المستخدم لم يعد موجودًا؛ لم أنفذ شيئًا");
    if (String(pending.preview.source || "") !== user.source) {
      throw new Error("مصدر المستخدم تغيّر منذ المعاينة؛ أعد الطلب من جديد");
    }

    await dbPatch(
      "tg_pending_actions",
      { status: "running", confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: `eq.${pending.id}`, status: "eq.pending" },
    );
    await audit({
      telegram_user_id: pending.telegram_user_id,
      chat_id: pending.chat_id,
      network_id: pending.network_id,
      pending_action_id: pending.id,
      action_type: pending.action_type,
      target_value: pending.target_value,
      phase: "confirmed",
      details: { source: user.source },
    });

    if (pending.action_type === "change_user_profile") {
      const newProfile = String(pending.preview.new_profile || "");
      if (!newProfile) throw new Error("الباقة الجديدة مفقودة");
      await executeProfile(client, user, pending.target_value, newProfile);
    } else if (pending.action_type === "change_user_password") {
      const ciphertext = String(pending.preview.password_ciphertext || "");
      if (!ciphertext) throw new Error("كلمة المرور المشفرة مفقودة");
      await executePassword(client, user, decryptSecret(ciphertext));
    } else if (pending.action_type === "delete_user") {
      await executeDelete(client, user);
    } else {
      throw new Error("نوع العملية غير مدعوم");
    }

    await dbPatch(
      "tg_pending_actions",
      { status: "completed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: `eq.${pending.id}` },
    );
    await audit({
      telegram_user_id: pending.telegram_user_id,
      chat_id: pending.chat_id,
      network_id: pending.network_id,
      pending_action_id: pending.id,
      action_type: pending.action_type,
      target_value: pending.target_value,
      phase: "success",
      details: {
        source: user.source,
        new_profile: pending.preview.new_profile || null,
        disconnected_sessions: pending.action_type === "delete_user" ? user.active.length : 0,
      },
    });

    await answer(callbackId, "تم التنفيذ");
    const result = pending.action_type === "change_user_profile"
      ? `✅ تم تغيير باقة <code>${esc(pending.target_value)}</code> إلى <b>${esc(pending.preview.new_profile)}</b>.`
      : pending.action_type === "change_user_password"
        ? `✅ تم تغيير كلمة مرور <code>${esc(pending.target_value)}</code> بنجاح.`
        : `✅ تم حذف المستخدم <code>${esc(pending.target_value)}</code> نهائيًا${user.active.length ? ` وفصل ${user.active.length} جلسة نشطة` : ""}.`;

    if (messageId) await edit(chatId, messageId, result);
    else await send(chatId, result);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await dbPatch(
      "tg_pending_actions",
      { status: "error", error_text: message.slice(0, 500), updated_at: new Date().toISOString() },
      { id: `eq.${pending.id}` },
    );
    await audit({
      telegram_user_id: pending.telegram_user_id,
      chat_id: pending.chat_id,
      network_id: pending.network_id,
      pending_action_id: pending.id,
      action_type: pending.action_type,
      target_value: pending.target_value,
      phase: "error",
      details: { error: message.slice(0, 500) },
    });
    await answer(callbackId, "فشل التنفيذ", true);
    const text = `🔴 <b>لم تكتمل العملية</b>\n<code>${esc(message)}</code>`;
    if (messageId) await edit(chatId, messageId, text);
    else await send(chatId, text);
    return true;
  } finally {
    client.close();
  }
}

async function handleSessionCallback(update: TgUpdate) {
  const callback = update.callback_query;
  if (!callback?.data || !/^ua:(?:p|same|custom|no):/i.test(callback.data)) return false;

  const [, kind, id, extra] = callback.data.split(":");
  const chatId = callback.message?.chat.id ?? callback.from.id;
  const messageId = callback.message?.message_id;
  const rows = await dbGet<AdminSession>("tg_user_admin_sessions", {
    id: `eq.${id}`,
    telegram_user_id: `eq.${callback.from.id}`,
    select: "*",
    limit: "1",
  });
  const session = rows[0];
  if (!session) {
    await answer(callback.id, "الجلسة غير موجودة", true);
    return true;
  }

  if (new Date(session.expires_at).getTime() < Date.now()) {
    await dbPatch("tg_user_admin_sessions", { step: "expired", updated_at: new Date().toISOString() }, { id: `eq.${session.id}` });
    await answer(callback.id, "انتهت الجلسة", true);
    if (messageId) await edit(chatId, messageId, "⌛ انتهت الجلسة. أرسل الطلب من جديد.");
    return true;
  }

  if (kind === "no") {
    await dbPatch("tg_user_admin_sessions", { step: "cancelled", updated_at: new Date().toISOString() }, { id: `eq.${session.id}` });
    await answer(callback.id, "تم الإلغاء");
    if (messageId) await edit(chatId, messageId, "❌ تم الإلغاء. لم أغيّر شيئًا.");
    return true;
  }

  if (kind === "custom") {
    await dbPatch("tg_user_admin_sessions", { step: "await_password", updated_at: new Date().toISOString() }, { id: `eq.${session.id}` });
    await answer(callback.id, "أرسل كلمة المرور");
    if (messageId) {
      await edit(
        chatId,
        messageId,
        `✍️ أرسل الآن كلمة المرور الجديدة للمستخدم <code>${esc(session.username)}</code>.\nسأحذف رسالتك من Telegram فور استلامها ولن أسجلها كنص.`,
      );
    }
    return true;
  }

  if (kind === "same") {
    await answer(callback.id, "سيتم استخدام اسم المستخدم");
    await showPasswordPreview(session, encryptSecret(session.username));
    if (messageId) await edit(chatId, messageId, "🔑 اخترت كلمة مرور مطابقة لاسم المستخدم. أرسلت معاينة التأكيد في رسالة جديدة.");
    return true;
  }

  const index = Number(extra);
  const selected = session.profiles[index];
  if (!selected) {
    await answer(callback.id, "الباقة غير موجودة", true);
    return true;
  }

  const network = await exactNetwork(session.telegram_user_id, session.network_id);
  if (!network) {
    await answer(callback.id, "الشبكة غير موجودة", true);
    return true;
  }
  const client = routerClient(network);
  try {
    const user = await resolveUser(client, session.username);
    if (!user) {
      await answer(callback.id, "المستخدم غير موجود", true);
      return true;
    }
    await dbPatch(
      "tg_user_admin_sessions",
      { selected_profile: selected, step: "selected", updated_at: new Date().toISOString() },
      { id: `eq.${session.id}` },
    );
    const pending = await createPending(
      { ...session, selected_profile: selected },
      user,
      "change_user_profile",
      { new_profile: selected },
    );
    await answer(callback.id, "تم اختيار الباقة");
    if (messageId) {
      await edit(
        chatId,
        messageId,
        `🛡 <b>معاينة تغيير الباقة</b>\n━━━━━━━━━━━━━━━━━━\n👤 <code>${esc(session.username)}</code>\n🏷 الحالية: <b>${esc(currentProfile(user))}</b>\n➡️ الجديدة: <b>${esc(selected)}</b>\n👥 جلسات نشطة: <b>${user.active.length}</b>`,
        actionKeyboard(pending.id, "✅ غيّر الباقة"),
      );
    }
    return true;
  } finally {
    client.close();
  }
}

async function handlePendingCallback(update: TgUpdate) {
  const callback = update.callback_query;
  if (!callback?.data || !/^ua:(?:ok|cancel|del1|del2):/i.test(callback.data)) return false;

  const [, kind, id] = callback.data.split(":");
  const chatId = callback.message?.chat.id ?? callback.from.id;
  const messageId = callback.message?.message_id;
  const rows = await dbGet<PendingAction>("tg_pending_actions", {
    id: `eq.${id}`,
    telegram_user_id: `eq.${callback.from.id}`,
    select: "*",
    limit: "1",
  });
  const pending = rows[0];
  if (!pending) {
    await answer(callback.id, "طلب التأكيد غير موجود", true);
    return true;
  }
  if (pending.status !== "pending") {
    await answer(callback.id, "هذا الطلب لم يعد نشطًا", true);
    return true;
  }
  if (new Date(pending.expires_at).getTime() < Date.now()) {
    await dbPatch("tg_pending_actions", { status: "expired", updated_at: new Date().toISOString() }, { id: `eq.${pending.id}` });
    await answer(callback.id, "انتهت صلاحية الطلب", true);
    if (messageId) await edit(chatId, messageId, "⌛ انتهت صلاحية التأكيد. أرسل الطلب من جديد.");
    return true;
  }

  if (kind === "cancel") {
    await dbPatch("tg_pending_actions", { status: "cancelled", updated_at: new Date().toISOString() }, { id: `eq.${pending.id}` });
    await audit({
      telegram_user_id: pending.telegram_user_id,
      chat_id: pending.chat_id,
      network_id: pending.network_id,
      pending_action_id: pending.id,
      action_type: pending.action_type,
      target_value: pending.target_value,
      phase: "cancelled",
    });
    await answer(callback.id, "تم الإلغاء");
    if (messageId) await edit(chatId, messageId, "❌ تم الإلغاء. لم أغيّر شيئًا.");
    return true;
  }

  if (kind === "del1" && pending.action_type === "delete_user") {
    await answer(callback.id, "تأكيد أخير");
    if (messageId) {
      await edit(
        chatId,
        messageId,
        `🚨 <b>التأكيد النهائي للحذف</b>\n━━━━━━━━━━━━━━━━━━\n👤 <code>${esc(pending.target_value)}</code>\n\nسيُحذف الحساب من ${esc(pending.preview.source)}، وستُفصل جلساته النشطة إن وجدت.\n<b>هذا الإجراء غير قابل للتراجع من البوت.</b>`,
        deleteStage2Keyboard(pending.id),
      );
    }
    return true;
  }

  if (kind === "del2" && pending.action_type === "delete_user") {
    return executePending(pending, callback.id, chatId, messageId);
  }
  if (kind === "ok" && pending.action_type !== "delete_user") {
    return executePending(pending, callback.id, chatId, messageId);
  }

  await answer(callback.id, "تأكيد غير صالح", true);
  return true;
}

async function handlePasswordInput(update: TgUpdate) {
  const message = update.message;
  if (!message?.from || !message.text || message.text.startsWith("/")) return false;
  const session = await latestAwaitingPassword(message.from.id);
  if (!session) return false;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await dbPatch("tg_user_admin_sessions", { step: "expired", updated_at: new Date().toISOString() }, { id: `eq.${session.id}` });
    return false;
  }

  const raw = message.text;
  await deleteMessage(message.chat.id, message.message_id);
  if (raw.length < 1 || raw.length > 128) {
    await send(message.chat.id, "⚠️ كلمة المرور يجب أن تكون بين 1 و128 حرفًا. أرسلها مرة أخرى.");
    return true;
  }
  await showPasswordPreview(session, encryptSecret(raw));
  return true;
}

function helpText() {
  return `👤 <b>إدارة المستخدم</b>\n━━━━━━━━━━━━━━━━━━\nيمكنك الكلام طبيعيًا:\n• غير باقة المستخدم <code>773032</code> إلى <code>500</code>\n• غير كلمة مرور الكرت <code>AB-12_X</code>\n• احذف المستخدم <code>test-user</code>\n• افحص المستخدم <code>773032</code>\n\nأوامر اختيارية:\n<code>/user USER</code> — تقرير\n<code>/user profile USER</code> — تغيير الباقة\n<code>/user password USER</code> — تغيير كلمة المرور\n<code>/user delete USER</code> — حذف آمن بتأكيدين\n\nتعطيل/تفعيل وفصل الجلسة يعمل أيضًا بالكلام الطبيعي مع زر تأكيد.`;
}

export async function handleTelegramUserAdmin(update: TgUpdate): Promise<boolean> {
  if (await handleSessionCallback(update)) return true;
  if (await handlePendingCallback(update)) return true;
  if (await handlePasswordInput(update)) return true;

  const message = update.message;
  if (!message?.from || !message.text) return false;
  const raw = message.text.trim();
  if (!raw) return false;

  if (/^\/user(?:@\w+)?$/i.test(raw)) {
    await send(message.chat.id, helpText());
    return true;
  }

  const info = raw.match(/^\/user(?:@\w+)?\s+(?:info\s+)?([^\s]+)$/i);
  if (info) {
    return handleTelegramCardUniversal({
      ...update,
      message: { ...message, text: `/card ${info[1]}` },
    });
  }

  const request = parseRequest(raw);
  if (!request) return false;
  return startRequest(update, request);
}
