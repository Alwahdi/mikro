import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function GET() {
  try {
    await telegram("setMyCommands", {
      commands: [
        { command: "start", description: "🏠 الرئيسية ولوحة التحكم" },
        { command: "add", description: "➕ إضافة شبكة MikroTik" },
        { command: "status", description: "📊 حالة الإنترنت والراوتر" },
        { command: "online", description: "👥 المستخدمون المتصلون الآن" },
        { command: "sales", description: "💰 كروت أول دخول اليوم" },
        { command: "vlans", description: "🧩 VLANs المفعلة" },
        { command: "vlan", description: "📍 تفاصيل VLAN — مثال /vlan 202" },
        { command: "ping", description: "🌐 اختبار الاتصال بـ 8.8.8.8" },
        { command: "router", description: "🛠 معلومات الراوتر والإصدار" },
        { command: "networks", description: "📡 شبكاتي واختيار الشبكة" },
        { command: "help", description: "❓ المساعدة والأوامر" },
        { command: "cancel", description: "❌ إلغاء الإعداد الحالي" },
      ],
    });

    await telegram("setMyDescription", {
      description:
        "إدارة ومراقبة شبكات MikroTik من Telegram فقط. يدعم RouterOS 6 و7، الاتصال المباشر، والشبكات بدون DDNS أو Public IP عبر Agent HTTPS.",
    });

    await telegram("setMyShortDescription", {
      short_description: "إدارة MikroTik من Telegram • Direct API + No-DDNS Agent",
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: String(error instanceof Error ? error.message : error) },
      { status: 500 },
    );
  }
}
