import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "mikro-telegram-bot",
    configured: Boolean(
      process.env.TELEGRAM_BOT_TOKEN &&
      process.env.TELEGRAM_WEBHOOK_SECRET &&
      process.env.SUPABASE_URL &&
      process.env.SUPABASE_PUBLISHABLE_KEY &&
      process.env.CREDENTIALS_KEY
    ),
  });
}
