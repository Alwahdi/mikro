import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, markAgentSeen } from "@/lib/router-agent";
import { dbGet, dbPatch } from "@/lib/telegram-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AgentCommand = {
  id: string;
  network_id: string;
  chat_id: number;
  reply_message_id?: number | null;
  kind: "status" | "ping" | "vlan" | "sales";
};

function parseBody(raw: string) {
  const result: Record<string, string> = {};
  for (const line of raw.replace(/\r/g, "").split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    result[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return result;
}

function esc(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function gb(value: unknown) {
  const bytes = Number(value || 0);
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

async function telegram(method: string, payload: Record<string, unknown>) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing");
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

async function deliver(command: AgentCommand, text: string) {
  if (command.reply_message_id) {
    try {
      await telegram("editMessageText", {
        chat_id: command.chat_id,
        message_id: command.reply_message_id,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      return;
    } catch {}
  }
  await telegram("sendMessage", {
    chat_id: command.chat_id,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

function render(command: AgentCommand, data: Record<string, string>) {
  if (data.status !== "ok") {
    const reason = data.error || "agent-command-failed";
    if (reason === "user-manager-unavailable") {
      return "🔴 <b>User Manager غير متاح</b>\nلا توجد بيانات مبيعات قابلة للقراءة على هذا الراوتر.";
    }
    if (reason === "vlan-not-found") return "❌ VLAN غير موجود أو معطل.";
    return `🔴 تعذر تنفيذ الطلب عبر Agent.\n<code>${esc(reason)}</code>`;
  }

  if (command.kind === "status") {
    const total = Number(data.total_memory || 0);
    const free = Number(data.free_memory || 0);
    const ram = total > 0 ? Math.round((1 - free / total) * 100) : 0;
    const ping = Number(data.ping_replies || 0);
    const ppp = Number(data.pppoe_running || 0);
    return `📊 <b>${esc(data.identity || "MikroTik")} • الحالة الآن</b>\n━━━━━━━━━━━━━━━━━━\n🌐 الإنترنت: ${ping > 0 ? "🟢 متصل" : "🔴 غير متصل"}\n📍 Ping: <b>${ping}/3</b>\n🔗 PPPoE نشط: <b>${ppp}</b>\n👥 المتصلون: <b>${esc(data.online || 0)}</b>\n⚙️ CPU: <b>${esc(data.cpu || 0)}%</b>\n🧠 RAM: <b>${ram}%</b>\n⏱ Uptime: ${esc(data.uptime || "-")}\n🧩 RouterOS: ${esc(data.version || "-")}\n\n🔄 الاتصال: Agent HTTPS`;
  }

  if (command.kind === "ping") {
    return `🌐 <b>اختبار الإنترنت</b>\n━━━━━━━━━━━━━━━━━━\n📍 8.8.8.8\n✅ الردود: <b>${esc(data.replies || 0)}/5</b>\n📉 الفقد: <b>${esc(data.loss || 100)}%</b>`;
  }

  if (command.kind === "vlan") {
    const rx = Number(data.rx || 0);
    const tx = Number(data.tx || 0);
    return `🧩 <b>VLAN ${esc(data.vlan_id)} • ${esc(data.name)}</b>\n━━━━━━━━━━━━━━━━━━\n📦 الاستهلاك: <b>${gb(rx + tx)}</b>\n⬇️ Download: ${gb(tx)}\n⬆️ Upload: ${gb(rx)}\n👥 متصل الآن: <b>${esc(data.online || 0)}</b>`;
  }

  if (command.kind === "sales") {
    const count = Number(data.count || 0);
    const cards = (data.cards || "").split(",").filter(Boolean).slice(0, 30);
    const list = cards.map((card, index) => `${index + 1}. 🎫 <code>${esc(card)}</code>`).join("\n");
    return `💰 <b>مبيعات اليوم • أول دخول فقط</b>\n━━━━━━━━━━━━━━━━━━\n🆕 الكروت التي سجلت لأول مرة: <b>${count}</b>\n\n${list || "لا توجد مبيعات مسجلة حتى الآن."}${count > cards.length ? `\n\n… +${count - cards.length} كرت` : ""}`;
  }

  return "✅ تم تنفيذ الطلب.";
}

export async function POST(req: NextRequest) {
  const networkId = req.nextUrl.searchParams.get("network") || "";
  const token = req.nextUrl.searchParams.get("token") || "";
  if (!networkId || !token) return new NextResponse("missing credentials", { status: 400 });

  const network = await authenticateAgent(networkId, token);
  if (!network) return new NextResponse("unauthorized", { status: 401 });

  const raw = await req.text();
  if (raw.length > 64_000) return new NextResponse("payload too large", { status: 413 });
  const data = parseBody(raw);
  const commandId = data.id || "";
  if (!commandId) return new NextResponse("missing command id", { status: 400 });

  const commands = await dbGet<AgentCommand>("tg_agent_commands", {
    id: `eq.${commandId}`,
    network_id: `eq.${networkId}`,
    select: "id,network_id,chat_id,reply_message_id,kind",
    limit: "1",
  });
  const command = commands[0];
  if (!command) return new NextResponse("unknown command", { status: 404 });

  const ok = data.status === "ok";
  await dbPatch(
    "tg_agent_commands",
    {
      status: ok ? "success" : "error",
      result: data,
      error: ok ? null : data.error || "agent-command-failed",
      completed_at: new Date().toISOString(),
    },
    { id: `eq.${command.id}` },
  );
  await markAgentSeen(networkId);

  if (command.kind === "status" && ok) {
    await dbPatch(
      "tg_networks",
      {
        identity: data.identity || network.label,
        router_os_version: data.version || null,
        agent_capabilities: {
          transport: "https-fetch",
          status: true,
          ping: true,
          vlan: true,
          sales: true,
        },
        updated_at: new Date().toISOString(),
      },
      { id: `eq.${networkId}` },
    );
  }

  try {
    await deliver(command, render(command, data));
  } catch (error) {
    console.error("Agent Telegram delivery failed", error);
  }

  return NextResponse.json({ ok: true });
}
