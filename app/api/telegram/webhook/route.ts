import { after, NextRequest, NextResponse } from "next/server";
import { handleTelegramAIV2 } from "@/lib/telegram-ai-v2";
import { handleTelegramCard } from "@/lib/telegram-card";
import { handleTelegramExtra, TgUpdate } from "@/lib/telegram-extra";
import { handleTelegramNaturalFallback } from "@/lib/telegram-natural-fallback";
import { handleTelegramSales } from "@/lib/telegram-sales";
import { handleTelegramUpdate } from "@/lib/telegram-bot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function tellAIUnavailable(update: TgUpdate) {
  const chatId = update.message?.chat.id;
  if (!chatId || !process.env.TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "🧠 فهمت أنك كتبت طلبًا طبيعيًا، لكن التحليل الحر الكامل لم يُفعّل في حساب AI Gateway بعد. جرّب بصيغة مباشرة مثل: «كم مستخدم متصل الآن؟»، «افحص الكرت 15352951»، «مبيعات اليوم»، «VLAN 202»، أو استخدم /help.",
      }),
      cache: "no-store",
    });
  } catch {}
}

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

  // Telegram retries slow webhooks. Acknowledge immediately, then do router/AI work.
  after(async () => {
    try {
      const salesHandled = await handleTelegramSales(update);
      if (salesHandled) return;

      const extraHandled = await handleTelegramExtra(update);
      if (extraHandled) return;

      const cardHandled = await handleTelegramCard(update);
      if (cardHandled) return;

      // Full ToolLoopAgent mode is feature-gated until AI Gateway billing is enabled.
      if (process.env.MIKRO_AI_ENABLED === "true") {
        const aiHandled = await handleTelegramAIV2(update);
        if (aiHandled) return;
      }

      // Free deterministic natural-language layer keeps common questions working now.
      const fallbackHandled = await handleTelegramNaturalFallback(update);
      if (fallbackHandled) return;

      if (update.message?.text && !update.message.text.trim().startsWith("/")) {
        await tellAIUnavailable(update);
        return;
      }

      await handleTelegramUpdate(update);
    } catch (error) {
      console.error("telegram update processing error", error);
    }
  });

  return NextResponse.json({ ok: true });
}
