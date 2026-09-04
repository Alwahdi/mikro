import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!token || !secret) {
    return NextResponse.json(
      { ok: false, error: "Telegram bot environment is not configured" },
      { status: 503 },
    );
  }

  const webhookUrl = new URL("/api/telegram/webhook", req.nextUrl.origin).toString();
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    }),
    cache: "no-store",
  });

  const result = await response.json();
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, telegram: result },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    webhook: webhookUrl,
    telegram: result.description,
  });
}
