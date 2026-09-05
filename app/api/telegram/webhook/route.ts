import { after, NextRequest, NextResponse } from "next/server";
import { dbGet } from "@/lib/telegram-db";
import { handleTelegramAIV2 } from "@/lib/telegram-ai-v2";
import { handleTelegramCardUniversal } from "@/lib/telegram-card-universal";
import { handleTelegramCommandRouter } from "@/lib/telegram-command-router";
import { handleTelegramExtra, TgUpdate } from "@/lib/telegram-extra";
import { handleHighPriorityIntentOverrides } from "@/lib/telegram-intent-overrides";
import { handleTelegramNaturalPro } from "@/lib/telegram-natural-pro";
import { handlePrivilegedCallback, handlePrivilegedNatural } from "@/lib/telegram-privileged";
import { handleTelegramSales } from "@/lib/telegram-sales";
import { handleTelegramUpdate } from "@/lib/telegram-bot";
import { handleTelegramUserCreate } from "@/lib/telegram-user-create";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type SetupRow={setup_state?:string|null};
async function setupActive(update:TgUpdate){
  const m=update.message;if(!m?.from||!m.text||m.text.trim().startsWith("/"))return false;
  const rows=await dbGet<SetupRow>("tg_users",{telegram_user_id:`eq.${m.from.id}`,select:"setup_state",limit:"1"});
  return Boolean(rows[0]?.setup_state&&rows[0].setup_state!=="idle");
}

export async function POST(req: NextRequest) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  const supplied = req.headers.get("x-telegram-bot-api-secret-token");
  if (!expected || supplied !== expected) return NextResponse.json({ ok: false }, { status: 401 });

  let update: TgUpdate;
  try { update = (await req.json()) as TgUpdate; }
  catch { return NextResponse.json({ ok: false, error: "invalid-json" }, { status: 400 }); }

  after(async () => {
    try {
      // Confirmation callbacks for privileged actions are isolated from all
      // ordinary command routing. They are bound to the Telegram user, network,
      // exact target and a short expiry window.
      const privilegedCallbackHandled = await handlePrivilegedCallback(update);
      if (privilegedCallbackHandled) return;

      // Explicit commands stay deterministic and never require AI.
      const commandHandled = await handleTelegramCommandRouter(update);
      if (commandHandled) return;

      const salesHandled = await handleTelegramSales(update);
      if (salesHandled) return;
      const extraHandled = await handleTelegramExtra(update);
      if (extraHandled) return;
      const cardHandled = await handleTelegramCardUniversal(update);
      if (cardHandled) return;

      // Network setup answers (especially API passwords) own text exclusively.
      // Nothing below may interpret or log them as an operational command.
      if (await setupActive(update)) {
        await handleTelegramUpdate(update);
        return;
      }

      // Guided user creation owns its callback/password state here. A custom
      // user password is deleted from Telegram immediately and stored encrypted.
      const userCreateHandled = await handleTelegramUserCreate(update);
      if (userCreateHandled) return;

      // High-priority corrections learned from real conversations. These stop
      // broad card matching from stealing explicit scheduler/full-backup intents.
      const overrideHandled = await handleHighPriorityIntentOverrides(update);
      if (overrideHandled) return;

      // Privileged language creates a read-only preview only. RouterOS writes
      // require a separate inline-button confirmation handled above.
      const privilegedNaturalHandled = await handlePrivilegedNatural(update);
      if (privilegedNaturalHandled) return;

      // Primary language layer: deterministic, fuzzy, contextual, multilingual and free.
      const localHandled = await handleTelegramNaturalPro(update);
      if (localHandled) return;

      // AI is only a rare fallback. Normal operations do not depend on AI billing.
      if (process.env.MIKRO_AI_ENABLED === "true") {
        const aiHandled = await handleTelegramAIV2(update);
        if (aiHandled) return;
      }

      await handleTelegramUpdate(update);
    } catch (error) {
      console.error("telegram update processing error", error);
    }
  });

  return NextResponse.json({ ok: true });
}
