import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, markAgentSeen } from "@/lib/router-agent";
import { dbGet, dbInsert, dbPatch } from "@/lib/telegram-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ReadKind = "logs" | "interfaces" | "dhcp" | "hotspot" | "top_usage";
type Cmd = {
  id: string;
  network_id: string;
  chat_id: number;
  reply_message_id?: number | null;
  kind: string;
  payload?: Record<string, unknown> | null;
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
};

function parse(raw: string) {
  const out: Record<string, string> = {};
  for (const line of raw.replace(/\r/g, "").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function esc(v: unknown) {
  return String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

async function tg(method: string, payload: Record<string, unknown>) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const json = await response.json();
  if (!json.ok) throw new Error(json.description || `Telegram ${response.status}`);
  return json.result;
}

async function deliver(command: Cmd, text: string, reply_markup?: unknown) {
  if (!command.chat_id || command.chat_id <= 0) return;
  if (command.reply_message_id) {
    try {
      await tg("editMessageText", {
        chat_id: command.chat_id,
        message_id: command.reply_message_id,
        text: text.slice(0, 4000),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup,
      });
      return;
    } catch {}
  }
  await tg("sendMessage", {
    chat_id: command.chat_id,
    text: text.slice(0, 4000),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup,
  });
}

function renderRead(kind: ReadKind, d: Record<string, string>) {
  if (d.status !== "ok") return `🔴 تعذر تنفيذ الطلب عبر Agent.\n<code>${esc(d.error || "agent-command-failed")}</code>`;
  if (kind === "logs") {
    const rows = (d.items || "").split(";").filter(Boolean).slice(0, 25);
    return `🧾 <b>آخر السجلات</b>\n━━━━━━━━━━━━━━━━━━\n${rows.map((x, i) => {
      const [time, topics, msg] = x.split("@");
      return `${i + 1}. <b>${esc(time || "-")}</b> • ${esc(topics || "-")}\n${esc(msg || "-")}`;
    }).join("\n\n") || "لا توجد سجلات."}`;
  }
  if (kind === "interfaces") {
    const rows = (d.items || "").split(";").filter(Boolean);
    return `🔌 <b>واجهات الراوتر</b>\n━━━━━━━━━━━━━━━━━━\nالإجمالي: <b>${esc(d.total || 0)}</b> • Running: <b>${esc(d.running || 0)}</b>\n\n${rows.map((x) => {
      const [name, type, running, disabled, mtu] = x.split("@");
      return `${disabled === "1" ? "⛔" : running === "1" ? "🟢" : "⚪"} <b>${esc(name || "-")}</b> • ${esc(type || "-")} • MTU ${esc(mtu || "-")}`;
    }).join("\n")}`;
  }
  if (kind === "dhcp") {
    const rows = (d.items || "").split(";").filter(Boolean);
    return `📬 <b>DHCP Leases</b>\n━━━━━━━━━━━━━━━━━━\n🟢 Bound: <b>${esc(d.bound || 0)}</b> / ${esc(d.total || 0)}\n\n${rows.map((x, i) => {
      const [ip, mac, host, server] = x.split("@");
      return `${i + 1}. ${esc(ip || "-")} • <code>${esc(mac || "-")}</code>${host ? ` • ${esc(host)}` : ""}${server ? `\n   ${esc(server)}` : ""}`;
    }).join("\n") || "لا توجد leases مرتبطة الآن."}`;
  }
  if (kind === "hotspot") {
    const rows = (d.items || "").split(";").filter(Boolean);
    return `📡 <b>Hotspot Overview</b>\n━━━━━━━━━━━━━━━━━━\n🧩 Servers: <b>${esc(d.servers || 0)}</b>\n👥 Active: <b>${esc(d.active || 0)}</b>\n🎫 Local users: <b>${esc(d.users || 0)}</b>\n🚫 Disabled users: <b>${esc(d.disabled || 0)}</b>\n\n${rows.map((x) => {
      const [name, intf, dis] = x.split("@");
      return `• ${dis === "1" ? "⛔" : "🟢"} <b>${esc(name || "-")}</b> • ${esc(intf || "-")}`;
    }).join("\n")}`;
  }
  const rows = (d.items || "").split(";").filter(Boolean).map((x) => {
    const [user, ip, server, total] = x.split("@");
    return { user, ip, server, total: Number(total || 0) };
  }).sort((a, b) => b.total - a.total).slice(0, 20);
  return `🏆 <b>أعلى المتصلين استهلاكًا في الجلسة الحالية</b>\n━━━━━━━━━━━━━━━━━━\n${rows.map((r, i) => `${i + 1}. <code>${esc(r.user || "-")}</code> • <b>${bytes(r.total)}</b>\n   ${esc(r.ip || "-")} • ${esc(r.server || "-")}`).join("\n\n") || "لا يوجد مستخدمون متصلون."}`;
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

function actionLabel(action: string) {
  const labels: Record<string, string> = {
    disconnect_user: "فصل الجلسة",
    disable_hotspot_user: "تعطيل المستخدم",
    enable_hotspot_user: "تفعيل المستخدم",
    disable_vlan: "تعطيل VLAN",
    enable_vlan: "تفعيل VLAN",
  };
  return labels[action] || action;
}

function confirmKeyboard(id: string) {
  return {
    inline_keyboard: [
      [{ text: "✅ تأكيد التنفيذ", callback_data: `pagent:ok:${id}` }],
      [{ text: "❌ إلغاء", callback_data: `pagent:no:${id}` }],
    ],
  };
}

async function handlePrivilegedPreview(command: Cmd, data: Record<string, string>) {
  if (data.status !== "ok") {
    await deliver(command, `🔴 تعذر تجهيز المعاينة عبر Agent.\n<code>${esc(data.error || "preview-failed")}</code>`);
    return;
  }

  const actionType = String(command.payload?.action_type || "");
  const target = String(command.payload?.target || "");
  if (!actionType || !target) {
    await deliver(command, "🔴 بيانات المعاينة ناقصة؛ لم أنفذ شيئًا.");
    return;
  }

  let targetType = "user";
  let preview: Record<string, unknown> = {};
  let body = "";

  if (command.kind === "priv_preview_user") {
    const active = Number(data.active || 0);
    const disabled = data.disabled === "1";
    if (actionType === "disconnect_user" && active === 0) {
      await deliver(command, `ℹ️ المستخدم <code>${esc(target)}</code> غير متصل الآن؛ لا توجد جلسة لفصلها.`);
      return;
    }
    if (actionType === "disable_hotspot_user" && disabled) {
      await deliver(command, `ℹ️ المستخدم <code>${esc(target)}</code> معطل أصلًا.`);
      return;
    }
    if (actionType === "enable_hotspot_user" && !disabled) {
      await deliver(command, `ℹ️ المستخدم <code>${esc(target)}</code> مفعّل أصلًا.`);
      return;
    }
    preview = {
      transport: "privileged-agent",
      source: data.source || null,
      profile: data.profile || null,
      currently_disabled: disabled,
      active_sessions: active,
      ip: data.ip || null,
    };
    body = `👤 المستخدم: <code>${esc(target)}</code>\n📚 المصدر: <b>${esc(data.source || "-")}</b>\n🏷 الباقة: <b>${esc(data.profile || "-")}</b>\n🚦 الحالة: ${disabled ? "⛔ معطل" : "🟢 مفعّل"}\n👥 جلسات نشطة: <b>${active}</b>${data.ip ? `\n📍 IP: <code>${esc(data.ip)}</code>` : ""}`;
  } else {
    targetType = "vlan";
    const disabled = data.disabled === "1";
    if (actionType === "disable_vlan" && disabled) {
      await deliver(command, `ℹ️ VLAN ${esc(target)} معطل أصلًا.`);
      return;
    }
    if (actionType === "enable_vlan" && !disabled) {
      await deliver(command, `ℹ️ VLAN ${esc(target)} مفعّل أصلًا.`);
      return;
    }
    preview = {
      transport: "privileged-agent",
      name: data.name || null,
      parent: data.parent || null,
      currently_disabled: disabled,
      affected_hotspot_users: Number(data.affected || 0),
    };
    body = `🧩 VLAN: <b>${esc(target)}</b> — ${esc(data.name || "-")}\n🔗 Parent: ${esc(data.parent || "-")}\n🚦 الحالة: ${disabled ? "⛔ معطل" : "🟢 مفعّل"}\n👥 متصلون قد يتأثرون: <b>${esc(data.affected || 0)}</b>`;
  }

  const userId = Number(command.payload?.telegram_user_id || 0);
  if (!userId) {
    await deliver(command, "🔴 تعذر ربط المعاينة بصاحب الشبكة؛ لم أنفذ شيئًا.");
    return;
  }

  const rows = await dbInsert<PendingAction>("tg_pending_actions", {
    telegram_user_id: userId,
    chat_id: command.chat_id,
    network_id: command.network_id,
    action_type: actionType,
    target_type: targetType,
    target_value: target,
    preview,
    status: "pending",
  }, "*");
  const pending = rows[0];
  if (!pending) throw new Error("failed to create Agent pending action");

  await audit({
    telegram_user_id: userId,
    chat_id: command.chat_id,
    network_id: command.network_id,
    pending_action_id: pending.id,
    action_type: actionType,
    target_type: targetType,
    target_value: target,
    phase: "preview",
    details: preview,
  });

  const warning = targetType === "vlan" && actionType === "disable_vlan"
    ? "⚠️ تعطيل VLAN قد يقطع كل الترافيك والخدمات التي تعتمد عليها."
    : actionType === "disconnect_user"
      ? "⚠️ سيؤدي التأكيد إلى فصل الجلسات الحالية فقط."
      : actionType === "disable_hotspot_user"
        ? "⚠️ سيمنع تسجيل دخول جديد؛ لن أفصل الجلسة الحالية تلقائيًا."
        : "⚠️ سيتم تغيير الحالة فقط بدون تعديلات إضافية.";

  await deliver(
    command,
    `🛡 <b>تأكيد مطلوب • ${esc(actionLabel(actionType))}</b>\n━━━━━━━━━━━━━━━━━━\n🔄 الاتصال: Privileged Agent\n${body}\n\n${warning}\n\n⏳ التأكيد صالح لمدة 10 دقائق.`,
    confirmKeyboard(pending.id),
  );
}

async function handlePrivilegedWrite(command: Cmd, data: Record<string, string>) {
  const pendingId = String(command.payload?.pending_action_id || "");
  if (!pendingId) {
    await deliver(command, "🔴 نتيجة عملية غير مرتبطة بطلب تأكيد.");
    return;
  }
  const rows = await dbGet<PendingAction>("tg_pending_actions", {
    id: `eq.${pendingId}`,
    network_id: `eq.${command.network_id}`,
    select: "*",
    limit: "1",
  });
  const pending = rows[0];
  if (!pending) {
    await deliver(command, "🔴 طلب التأكيد لم يعد موجودًا.");
    return;
  }

  const ok = data.status === "ok";
  const now = new Date().toISOString();
  if (ok) {
    await dbPatch("tg_pending_actions", {
      status: "success",
      completed_at: now,
      updated_at: now,
      error_text: null,
    }, { id: `eq.${pending.id}` });
    await audit({
      telegram_user_id: pending.telegram_user_id,
      chat_id: pending.chat_id,
      network_id: pending.network_id,
      pending_action_id: pending.id,
      action_type: pending.action_type,
      target_type: pending.target_type,
      target_value: pending.target_value,
      phase: "success",
      details: { transport: "privileged-agent", result: data },
    });
    await deliver(
      command,
      `✅ <b>تم التنفيذ بنجاح</b>\n━━━━━━━━━━━━━━━━━━\n🛠 ${esc(actionLabel(pending.action_type))}\n🎯 <code>${esc(pending.target_value)}</code>\n🔄 Privileged Agent\n${data.changed !== undefined ? `📌 التغييرات: <b>${esc(data.changed)}</b>\n` : ""}\n🧾 تم تسجيل العملية في Audit Log.`,
    );
  } else {
    const error = data.error || "agent-write-failed";
    await dbPatch("tg_pending_actions", {
      status: "error",
      completed_at: now,
      updated_at: now,
      error_text: error,
    }, { id: `eq.${pending.id}` });
    await audit({
      telegram_user_id: pending.telegram_user_id,
      chat_id: pending.chat_id,
      network_id: pending.network_id,
      pending_action_id: pending.id,
      action_type: pending.action_type,
      target_type: pending.target_type,
      target_value: pending.target_value,
      phase: "error",
      details: { transport: "privileged-agent", error },
    });
    await deliver(command, `🔴 <b>فشل التنفيذ</b>\nلم أعتبر العملية ناجحة.\n<code>${esc(error)}</code>`);
  }
}

export async function POST(req: NextRequest) {
  const network = req.nextUrl.searchParams.get("network") || "";
  const token = req.nextUrl.searchParams.get("token") || "";
  if (!network || !token) return new NextResponse("missing credentials", { status: 400 });

  const authenticated = await authenticateAgent(network, token);
  if (!authenticated) return new NextResponse("unauthorized", { status: 401 });
  const raw = await req.text();
  if (raw.length > 64000) return new NextResponse("payload too large", { status: 413 });
  const data = parse(raw);
  const id = data.id || "";
  if (!id) return new NextResponse("missing command id", { status: 400 });

  const rows = await dbGet<Cmd>("tg_agent_commands", {
    id: `eq.${id}`,
    network_id: `eq.${network}`,
    select: "id,network_id,chat_id,reply_message_id,kind,payload",
    limit: "1",
  });
  const command = rows[0];
  if (!command) return new NextResponse("unknown command", { status: 404 });

  const readKinds = ["logs", "interfaces", "dhcp", "hotspot", "top_usage"];
  const previewKinds = ["priv_preview_user", "priv_preview_vlan"];
  const writeKinds = ["priv_disconnect_user", "priv_disable_user", "priv_enable_user", "priv_disable_vlan", "priv_enable_vlan"];

  if (!readKinds.includes(command.kind) && !previewKinds.includes(command.kind) && !writeKinds.includes(command.kind)) {
    const url = new URL("/api/router-agent/result", req.nextUrl.origin);
    url.searchParams.set("network", network);
    url.searchParams.set("token", token);
    const delegated = await fetch(url, {
      method: "POST",
      body: raw,
      headers: { "content-type": "text/plain" },
      cache: "no-store",
    });
    return new NextResponse(await delegated.text(), {
      status: delegated.status,
      headers: { "content-type": delegated.headers.get("content-type") || "application/json" },
    });
  }

  const ok = data.status === "ok";
  await dbPatch("tg_agent_commands", {
    status: ok ? "success" : "error",
    result: data,
    error: ok ? null : data.error || "agent-command-failed",
    completed_at: new Date().toISOString(),
  }, { id: `eq.${command.id}` });
  await markAgentSeen(network);

  try {
    if (previewKinds.includes(command.kind)) await handlePrivilegedPreview(command, data);
    else if (writeKinds.includes(command.kind)) await handlePrivilegedWrite(command, data);
    else await deliver(command, renderRead(command.kind as ReadKind, data));
  } catch (error) {
    console.error("Agent v2 Telegram delivery failed", error);
  }

  return NextResponse.json({ ok: true });
}
