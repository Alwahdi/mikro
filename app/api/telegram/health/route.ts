import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Redeploy marker: refresh production environment bindings after Telegram secrets update.
export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "mikro-telegram-bot",
    configured: Boolean(
      process.env.TELEGRAM_BOT_TOKEN &&
      process.env.TELEGRAM_WEBHOOK_SECRET
    ),
  });
}
