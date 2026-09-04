import { after, NextRequest, NextResponse } from "next/server";
import { handleTelegramAI } from "@/lib/telegram-ai";
import { handleTelegramExtra, TgUpdate } from "@/lib/telegram-extra";
import { handleTelegramSales } from "@/lib/telegram-sales";
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

  let update: TgUpdate;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid-json" }, { status: 400 });
  }

  // Telegram retries updates when webhook acknowledgement is slow. Return 200
  // immediately, then perform router/API/AI work after the response is committed.
  after(async () => {
    try {
      const salesHandled = await handleTelegramSales(update);
      if (salesHandled) return;

      const extraHandled = await handleTelegramExtra(update);
      if (extraHandled) return;

      const aiHandled = await handleTelegramAI(update);
      if (aiHandled) return;

      await handleTelegramUpdate(update);
    } catch (error) {
      console.error("telegram update processing error", error);
    }
  });

  return NextResponse.json({ ok: true });
}
