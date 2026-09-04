import { NextRequest, NextResponse } from "next/server";
import { handleTelegramUpdate } from "@/lib/telegram-bot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  const supplied = req.headers.get("x-telegram-bot-api-secret-token");
  if (!expected || supplied !== expected) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  try {
    await handleTelegramUpdate(await req.json());
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("telegram webhook error", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
