import { after, NextRequest, NextResponse } from "next/server";
import { handleTelegramAIV2 } from "@/lib/telegram-ai-v2";
import { handleTelegramCardUniversal } from "@/lib/telegram-card-universal";
import { handleTelegramExtra, TgUpdate } from "@/lib/telegram-extra";
import { handleTelegramNaturalFallback } from "@/lib/telegram-natural-fallback";
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

  // Acknowledge Telegram immediately. Router/API work continues after the response.
  after(async () => {
    try {
      const salesHandled = await handleTelegramSales(update);
      if (salesHandled) return;

      const extraHandled = await handleTelegramExtra(update);
      if (extraHandled) return;

      const cardHandled = await handleTelegramCardUniversal(update);
      if (cardHandled) return;

      // Full AI stays optional. The deterministic local NLU below is the primary
      // no-AI language layer and does not depend on AI Gateway billing.
      if (process.env.MIKRO_AI_ENABLED === "true") {
        const aiHandled = await handleTelegramAIV2(update);
        if (aiHandled) return;
      }

      const fallbackHandled = await handleTelegramNaturalFallback(update);
      if (fallbackHandled) return;

      // Important: setup wizard text must always reach the core bot. Do not
      // replace it with AI-unavailable messages.
      await handleTelegramUpdate(update);
    } catch (error) {
      console.error("telegram update processing error", error);
    }
  });

  return NextResponse.json({ ok: true });
}
