import { after, NextRequest, NextResponse } from "next/server";
import { handleTelegramUpdate } from "@/lib/telegram-bot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  const supplied = req.headers.get("x-telegram-bot-api-secret-token");

  if (!expected || supplied !== expected) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let update: unknown;
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid-json" }, { status: 400 });
  }

  // Telegram must receive a successful acknowledgement quickly or it retries
  // the same update. Do the actual router work after the response is committed.
  after(async () => {
    try {
      await handleTelegramUpdate(update as Parameters<typeof handleTelegramUpdate>[0]);
    } catch (error) {
      console.error("telegram update processing error", error);
    }
  });

  return NextResponse.json({ ok: true });
}
