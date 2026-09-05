import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return NextResponse.json({ ok: false, error: "missing bot token" }, { status: 500 });

  const commands = [
    { command: "start", description: "الرئيسية" },
    { command: "help", description: "المساعدة وأمثلة الكلام الطبيعي" },
    { command: "status", description: "حالة الشبكة والراوتر" },
    { command: "diagnose", description: "فحص الشبكة والإنترنت" },
    { command: "online", description: "المستخدمون المتصلون الآن" },
    { command: "card", description: "فحص كرت وسجل جلساته" },
    { command: "sales", description: "مبيعات اليوم وأول دخول" },
    { command: "ping", description: "اختبار الإنترنت وPing" },
    { command: "vlans", description: "عرض VLANs المفعلة" },
    { command: "vlan", description: "تفاصيل VLAN محدد" },
    { command: "router", description: "معلومات الراوتر والإصدار" },
    { command: "networks", description: "عرض شبكاتي" },
    { command: "add", description: "إضافة شبكة جديدة" },
    { command: "cancel", description: "إلغاء الإعداد الحالي" }
  ];

  const response = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commands }),
    cache: "no-store"
  });
  const json = await response.json();
  return NextResponse.json({ ok: Boolean(json.ok), command_count: commands.length, telegram: json.ok ? true : json.description || false }, { status: json.ok ? 200 : 500 });
}
