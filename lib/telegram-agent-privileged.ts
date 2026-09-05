import { createHash, randomBytes } from "crypto";
import { dbGet, dbInsert, dbPatch } from "./telegram-db";
import { normalizeLocalText, type LocalNluContext } from "./telegram-nlu-v2";
import type { TgUpdate } from "./telegram-extra";

type BotUser = { telegram_user_id: number; active_network_id?: string | null };
type Network = {
  id: string;
  telegram_user_id: number;
  label: string;
  identity?: string | null;
  connection_mode: "direct" | "agent";
  agent_last_seen_at?: string | null;
  agent_privileged_enabled?: boolean;
  agent_privileged_version?: string | null;
};
type PendingAction = {
  id: string;
  telegram_user_id: number;
  chat_id: number;
  network_id: string;
  action_type: ActionType;
  target_type: "user" | "vlan";
  target_value: string;
  preview: Record<string, unknown>;
  status: string;
  expires_at: string;
};
type ActionType = "disconnect_user" | "disable_hotspot_user" | "enable_hotspot_user" | "disable_vlan" | "enable_vlan";
type ParsedAction = { action_type: ActionType; target_type: "user" | "vlan"; target_value: string };

const BASE = "https://mikro-nine.vercel.app";

function token() {
  const value = process.env.TELEGRAM_BOT_TOKEN;
  if (!value) throw new Error("TELEGRAM_BOT_TOKEN missing");
  return value;
}

function esc(value: unknown) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function telegram(method: string, payload: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
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
  return telegram("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup });
}

async function edit(chatId: number, messageId: number, text: string, reply_markup?: unknown) {
  try {
    return await telegram("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup });
  } catch {
    return null;
  }
}

async function answer(id: string, text?: string, alert = false) {
  try { await telegram("answerCallbackQuery", { callback_query_id: id, text, show_alert: alert }); } catch {}
}

async function activeNetwork(userId: number) {
  const users = await dbGet<BotUser>("tg_users", {
    telegram_user_id: `eq.${userId}`,
    select: "telegram_user_id,active_network_id",
    limit: "1",
  });
  const id = users[0]?.active_network_id;
  if (!id) return null;
  const networks = await dbGet<Network>("tg_networks", {
    id: `eq.${id}`,
    telegram_user_id: `eq.${userId}`,
    select: "id,telegram_user_id,label,identity,connection_mode,agent_last_seen_at,agent_privileged_enabled,agent_privileged_version",
    limit: "1",
  });
  return networks[0] ?? null;
}

async function exactNetwork(userId: number, networkId: string) {
  const rows = await dbGet<Network>("tg_networks", {
    id: `eq.${networkId}`,
    telegram_user_id: `eq.${userId}`,
    select: "id,telegram_user_id,label,identity,connection_mode,agent_last_seen_at,agent_privileged_enabled,agent_privileged_version",
    limit: "1",
  });
  return rows[0] ?? null;
}

async function context(userId: number) {
  const rows = await dbGet<LocalNluContext>("tg_nlu_context", {
    telegram_user_id: `eq.${userId}`,
    select: "*",
    limit: "1",
  });
  return rows[0] ?? null;
}

const blocked = new Set(["الشبكه", "الشبكة", "شبكه", "شبكة", "الراوتر", "راوتر", "router", "network", "vlan", "فيلان", "المستخدم", "مستخدم", "الكرت", "كرت", "اليوزر", "يوزر", "هذا", "هذه", "هذي", "ذا"]);
function userCandidate(value?: string | null) {
  if (!value) return null;
  const cleaned = value.trim().replace(/^["'«]+|["'»،,.!?]+$/g, "");
  if (cleaned.length < 2 || cleaned.length > 128 || !/^[\p{L}\p{N}_.@:+-]+$/u.test(cleaned)) return null;
  if (blocked.has(normalizeLocalText(cleaned))) return null;
  return cleaned;
}

function extractUser(raw: string) {
  const quoted = userCandidate(raw.match(/["'«]([^"'»]{2,128})["'»]/u)?.[1]);
  if (quoted) return quoted;
  const noun = raw.match(/(?:كرت|الكرت|يوزر|اليوزر|مستخدم|المستخدم|مشترك|user|card|account)\s*(?:رقم|اسم|اسمه|name|number)?\s*[:#-]?\s*([\p{L}\p{N}_.@:+-]{2,128})/iu)?.[1];
  if (noun) return userCandidate(noun);
  const verb = raw.match(/(?:افصل|فصل|اطرد|اخرج|طلع|عطل|وقف|اقفل|سكر|امنع|احظر|بلك|فعل|شغل|رجع|افتح|disconnect|kick|logout|disable|block|enable|unblock)\s*(?:هذا|هذه|هذي|ذا|the)?\s*(?:الكرت|كرت|اليوزر|يوزر|المستخدم|مستخدم|user|card)?\s*[:#-]?\s*([\p{L}\p{N}_.@:+-]{2,128})/iu)?.[1];
  return userCandidate(verb);
}

function extractVlan(raw: string) {
  const match = raw.match(/(?:vlan|فيلان|فلان)\s*#?\s*(\d{1,4})/i);
  const id = Number(match?.[1] || 0);
  return id >= 1 && id <= 4094 ? id : null;
}

function parseAction(raw: string, ctx: LocalNluContext | null): ParsedAction | null {
  const n = normalizeLocalText(raw.replace(/^\//, ""));
  const disconnect = /(?:^|\s)(?:افصل|فصل|اطرد|اخرج|طلع|disconnect|kick|logout)(?:\s|$)/i.test(n);
  const disable = /(?:^|\s)(?:عطل|وقف|اقفل|سكر|امنع|احظر|بلك|disable|block)(?:\s|$)/i.test(n);
  const enable = /(?:^|\s)(?:فعل|شغل|رجع|افتح|فك الحظر|enable|unblock)(?:\s|$)/i.test(n);
  if (!disconnect && !disable && !enable) return null;

  const vlan = extractVlan(raw);
  const mentionsVlan = /(?:vlan|فيلان|فلان)/i.test(n);
  if (vlan && (disable || enable)) return { action_type: disable ? "disable_vlan" : "enable_vlan", target_type: "vlan", target_value: String(vlan) };
  if (mentionsVlan && ctx?.last_entity_type === "vlan" && ctx.last_entity_value && (disable || enable)) {
    return { action_type: disable ? "disable_vlan" : "enable_vlan", target_type: "vlan", target_value: ctx.last_entity_value };
  }

  let user = extractUser(raw);
  const mentionsUser = /(?:كرت|يوزر|مستخدم|مشترك|user|card|account)/i.test(n);
  if (!user && ctx?.last_entity_type === "card" && ctx.last_entity_value && (mentionsUser || /(?:ه|ها|هذا|هذه|هذي|ذا)$/i.test(n))) user = ctx.last_entity_value;
  if (!user) return null;
  if (disconnect) return { action_type: "disconnect_user", target_type: "user", target_value: user };
  if (disable) return { action_type: "disable_hotspot_user", target_type: "user", target_value: user };
  if (enable) return { action_type: "enable_hotspot_user", target_type: "user", target_value: user };
  return null;
}

function enableRequest(raw: string) {
  const n = normalizeLocalText(raw);
  return /^\/agent_privileged(?:@\w+)?$/i.test(raw) || /(?:فعل|شغل|فعّل).*(?:التحكم الكامل|صلاحيات الكتابه|صلاحيات الكتابة|privileged agent|full control)/i.test(n);
}

function readonlyRequest(raw: string) {
  const n = normalizeLocalText(raw);
  return /^\/agent_readonly(?:@\w+)?$/i.test(raw) || /(?:الغ|الغي|اقفل|وقف|ارجع).*(?:التحكم الكامل|صلاحيات الكتابه|صلاحيات الكتابة)|(?:رجع|ارجع).*agent.*(?:قراءه|قراءة|readonly)/i.test(n);
}

function permissionKeyboard(networkId: string, level: "privileged" | "readonly") {
  return {
    inline_keyboard: [
      [{ text: level === "privileged" ? "🔐 أوافق وأفعّل" : "🔒 نعم، ارجع Read-only", callback_data: `agentperm:${level === "privileged" ? "priv" : "read"}:${networkId}` }],
      [{ text: "❌ إلغاء", callback_data: `agentperm:no:${networkId}` }],
    ],
  };
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function installerToken(userId: number, networkId: string, purpose: "privileged" | "readonly") {
  const raw = randomBytes(24).toString("base64url");
  await dbInsert("tg_agent_install_tokens", {
    network_id: networkId,
    telegram_user_id: userId,
    purpose,
    token_hash: hash(raw),
  });
  return raw;
}

async function audit(p: {
  telegram_user_id: number;
  chat_id: number;
  network_id: string;
  pending_action_id?: string | null;
  action_type: string;
  target_type?: string | null;
  target_value?: string | null;
  phase: string;
  details?: Record<string, unknown>;
}) {
  await dbInsert("tg_action_audit", { ...p, details: p.details || {} });
}

async function handlePermissionCallback(update: TgUpdate) {
  const cb = update.callback_query;
  if (!cb?.data || !/^agentperm:(?:priv|read|no):[0-9a-f-]{36}$/i.test(cb.data)) return false;
  const [, decision, networkId] = cb.data.split(":");
  const chatId = cb.message?.chat.id ?? cb.from.id;
  const messageId = cb.message?.message_id;
  const network = await exactNetwork(cb.from.id, networkId);
  if (!network || network.connection_mode !== "agent") {
    await answer(cb.id, "شبكة Agent غير موجودة", true);
    return true;
  }
  if (decision === "no") {
    await answer(cb.id, "تم الإلغاء");
    if (messageId) await edit(chatId, messageId, "❌ تم الإلغاء. لم تتغير صلاحيات Agent.");
    return true;
  }

  const purpose = decision === "priv" ? "privileged" : "readonly";
  const oneTime = await installerToken(cb.from.id, network.id, purpose);
  await dbPatch("tg_networks", { agent_privileged_requested_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { id: `eq.${network.id}` });
  await audit({
    telegram_user_id: cb.from.id,
    chat_id: chatId,
    network_id: network.id,
    action_type: purpose === "privileged" ? "enable_privileged_agent" : "disable_privileged_agent",
    target_type: "network",
    target_value: network.identity || network.label,
    phase: "installer_issued",
    details: { expires_minutes: 10 },
  });

  const url = `${BASE}/api/router-agent/privileged?mode=install&purpose=${purpose}&network=${network.id}&install=${oneTime}`;
  const command = `/tool fetch url="${url}" dst-path=mt-tg-agent-permission.rsc; /import file-name=mt-tg-agent-permission.rsc; /file remove mt-tg-agent-permission.rsc`;
  const title = purpose === "privileged" ? "🔐 تفعيل Privileged Agent" : "🔒 الرجوع إلى Read-only Agent";
  const note = purpose === "privileged"
    ? "هذا يضيف write للـAgent، لكن السيرفر سيقبل فقط العمليات الموجودة في القائمة البيضاء وبعد تأكيد Telegram."
    : "هذا يستبدل Agent بالنسخة Read-only ويوقف أوامر الكتابة.";
  await answer(cb.id, "جهزت أمر التثبيت");
  const text = `${title}\n━━━━━━━━━━━━━━━━━━\n📡 <b>${esc(network.identity || network.label)}</b>\n${note}\n\nنفّذ هذا الأمر مرة واحدة على MikroTik خلال 10 دقائق:\n\n<code>${esc(command)}</code>\n\n🔑 الرابط يستخدم Token تثبيت مؤقت لمرة واحدة؛ لا يعرض Agent secret الدائم.`;
  if (messageId) await edit(chatId, messageId, text);
  else await send(chatId, text);
  return true;
}

async function handlePendingCallback(update: TgUpdate) {
  const cb = update.callback_query;
  if (!cb?.data || !/^pagent:(?:ok|no):[0-9a-f-]{36}$/i.test(cb.data)) return false;
  const [, decision, id] = cb.data.split(":");
  const chatId = cb.message?.chat.id ?? cb.from.id;
  const messageId = cb.message?.message_id;
  const rows = await dbGet<PendingAction>("tg_pending_actions", {
    id: `eq.${id}`,
    telegram_user_id: `eq.${cb.from.id}`,
    select: "*",
    limit: "1",
  });
  const pending = rows[0];
  if (!pending) { await answer(cb.id, "طلب التأكيد غير موجود", true); return true; }
  if (pending.status !== "pending") { await answer(cb.id, "هذا الطلب لم يعد نشطًا", true); return true; }
  if (new Date(pending.expires_at).getTime() < Date.now()) {
    await dbPatch("tg_pending_actions", { status: "expired", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { id: `eq.${pending.id}` });
    await answer(cb.id, "انتهت صلاحية التأكيد", true);
    if (messageId) await edit(chatId, messageId, "⌛ انتهت صلاحية التأكيد. أرسل الطلب من جديد.");
    return true;
  }
  if (decision === "no") {
    await dbPatch("tg_pending_actions", { status: "cancelled", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { id: `eq.${pending.id}` });
    await audit({ telegram_user_id: pending.telegram_user_id, chat_id: pending.chat_id, network_id: pending.network_id, pending_action_id: pending.id, action_type: pending.action_type, target_type: pending.target_type, target_value: pending.target_value, phase: "cancelled" });
    await answer(cb.id, "تم الإلغاء");
    if (messageId) await edit(chatId, messageId, "❌ تم الإلغاء. لم أغيّر شيئًا في الراوتر.");
    return true;
  }

  const network = await exactNetwork(pending.telegram_user_id, pending.network_id);
  if (!network?.agent_privileged_enabled) {
    await answer(cb.id, "Privileged Agent غير مفعّل", true);
    if (messageId) await edit(chatId, messageId, "🔐 Privileged Agent غير مفعّل على هذه الشبكة. أعد تفعيل الصلاحيات ثم أرسل الطلب من جديد.");
    return true;
  }

  const kinds: Record<ActionType, string> = {
    disconnect_user: "priv_disconnect_user",
    disable_hotspot_user: "priv_disable_user",
    enable_hotspot_user: "priv_enable_user",
    disable_vlan: "priv_disable_vlan",
    enable_vlan: "priv_enable_vlan",
  };
  const now = new Date().toISOString();
  await dbPatch("tg_pending_actions", { status: "executing", confirmed_at: now, updated_at: now }, { id: `eq.${pending.id}`, status: "eq.pending" });
  await audit({ telegram_user_id: pending.telegram_user_id, chat_id: pending.chat_id, network_id: pending.network_id, pending_action_id: pending.id, action_type: pending.action_type, target_type: pending.target_type, target_value: pending.target_value, phase: "confirmed", details: { transport: "privileged-agent" } });
  await dbInsert("tg_agent_commands", {
    network_id: pending.network_id,
    telegram_user_id: pending.telegram_user_id,
    chat_id: chatId,
    reply_message_id: messageId || null,
    kind: kinds[pending.action_type],
    payload: { pending_action_id: pending.id, target: pending.target_value },
    status: "pending",
  });
  await answer(cb.id, "تم التأكيد");
  if (messageId) await edit(chatId, messageId, `⏳ <b>جاري التنفيذ عبر Privileged Agent…</b>\n🎯 <code>${esc(pending.target_value)}</code>\n\nسيعيد Agent النتيجة إلى هذه الرسالة.`);
  return true;
}

async function requestPermission(update: TgUpdate, level: "privileged" | "readonly") {
  const m = update.message;
  if (!m?.from) return false;
  const network = await activeNetwork(m.from.id);
  if (!network) { await send(m.chat.id, "📭 لا توجد شبكة نشطة."); return true; }
  if (network.connection_mode !== "agent") { await send(m.chat.id, "ℹ️ الشبكة الحالية Direct API؛ Privileged Agent خاص بالشبكات التي تعمل عبر Agent."); return true; }

  if (level === "privileged" && network.agent_privileged_enabled) {
    await send(m.chat.id, `✅ Privileged Agent مفعّل أصلًا على <b>${esc(network.identity || network.label)}</b> (${esc(network.agent_privileged_version || "v1")}).`);
    return true;
  }
  if (level === "readonly" && !network.agent_privileged_enabled) {
    await send(m.chat.id, `✅ Agent على <b>${esc(network.identity || network.label)}</b> يعمل Read-only أصلًا.`);
    return true;
  }

  const lastSeen = network.agent_last_seen_at ? new Date(network.agent_last_seen_at).getTime() : 0;
  const online = Date.now() - lastSeen < 90_000;
  const text = level === "privileged"
    ? `🔐 <b>تفعيل التحكم الكتابي عبر Agent</b>\n━━━━━━━━━━━━━━━━━━\n📡 ${esc(network.identity || network.label)}\n🔄 Agent: ${online ? "🟢 متصل" : "🟠 لم يظهر مؤخرًا"}\n\nسيُعاد تثبيت Agent بصلاحية write محلية، لكن البوت لا يملك Generic CLI. المسموح حاليًا فقط بعد Preview + Confirm:\n• فصل جلسة مستخدم\n• تعطيل/تفعيل مستخدم\n• تعطيل/تفعيل VLAN\n\nكلمات المرور وإنشاء المستخدم لن تمر عبر هذا المسار حتى نفعّل قناة Secret منفصلة. هل تريد المتابعة؟`
    : `🔒 <b>الرجوع إلى Read-only Agent</b>\n━━━━━━━━━━━━━━━━━━\n📡 ${esc(network.identity || network.label)}\nسيتم استبدال Agent بالنسخة read/test/sensitive وإيقاف أي أوامر write مستقبلية.`;
  await send(m.chat.id, text, permissionKeyboard(network.id, level));
  return true;
}

async function queuePreview(update: TgUpdate, parsed: ParsedAction, network: Network) {
  const m = update.message;
  if (!m?.from) return false;
  if (!network.agent_privileged_enabled) {
    await send(m.chat.id, `🔐 هذه الشبكة تعمل عبر Agent Read-only.\nأرسل <code>/agent_privileged</code> أو قل «فعّل التحكم الكامل» لتفعيل عمليات الكتابة الآمنة.`);
    return true;
  }
  const kind = parsed.target_type === "user" ? "priv_preview_user" : "priv_preview_vlan";
  const waiting = await send(m.chat.id, `🔎 <b>${esc(network.identity || network.label)}</b>\nأفحص الهدف أولًا عبر Agent قبل أن أعرض زر التأكيد…`);
  await dbInsert("tg_agent_commands", {
    network_id: network.id,
    telegram_user_id: m.from.id,
    chat_id: m.chat.id,
    reply_message_id: waiting.message_id,
    kind,
    payload: { target: parsed.target_value, action_type: parsed.action_type, telegram_user_id: m.from.id },
    status: "pending",
  });
  return true;
}

export async function handleTelegramAgentPrivileged(update: TgUpdate): Promise<boolean> {
  if (await handlePermissionCallback(update)) return true;
  if (await handlePendingCallback(update)) return true;

  const m = update.message;
  if (!m?.from || !m.text) return false;
  const raw = m.text.trim();
  if (!raw) return false;
  if (enableRequest(raw)) return requestPermission(update, "privileged");
  if (readonlyRequest(raw)) return requestPermission(update, "readonly");

  const network = await activeNetwork(m.from.id);
  if (!network || network.connection_mode !== "agent") return false;
  const ctx = await context(m.from.id);
  const parsed = parseAction(raw, ctx);
  if (!parsed) return false;
  return queuePreview(update, parsed, network);
}
