import { after, NextRequest, NextResponse } from "next/server";
import { dbGet } from "@/lib/telegram-db";
import { handleTelegramAIV2 } from "@/lib/telegram-ai-v2";
import { handleTelegramAgentPrivileged } from "@/lib/telegram-agent-privileged";
import { handleTelegramCardUniversal } from "@/lib/telegram-card-universal";
import { handleTelegramCommandRouter } from "@/lib/telegram-command-router";
import { handleTelegramExtra, TgUpdate } from "@/lib/telegram-extra";
import { handleHighPriorityIntentOverrides } from "@/lib/telegram-intent-overrides";
import { handleTelegramNaturalPro } from "@/lib/telegram-natural-pro";
import { handlePrivilegedCallback, handlePrivilegedNatural } from "@/lib/telegram-privileged";
import { handleTelegramSales } from "@/lib/telegram-sales";
import { handleTelegramUpdate } from "@/lib/telegram-bot";
import { handleTelegramUserCreate } from "@/lib/telegram-user-create";
import { handleTelegramUserAdmin } from "@/lib/telegram-user-admin";

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
      // Direct privileged confirmations use priv:* callbacks.
      const privilegedCallbackHandled = await handlePrivilegedCallback(update);
      if (privilegedCallbackHandled) return;

      // Agent permission and Agent-write confirmations use isolated prefixes
      // (agentperm:* / pagent:*), and also own natural write requests on Agent networks.
      const agentPrivilegedHandled = await handleTelegramAgentPrivileged(update);
      if (agentPrivilegedHandled) return;

      // Explicit deterministic commands first. Unknown /user-style commands are
      // deliberately allowed to fall through to the user-admin engine below.
      const commandHandled = await handleTelegramCommandRouter(update);
      if (commandHandled) return;

      const salesHandled = await handleTelegramSales(update);
      if (salesHandled) return;
      const extraHandled = await handleTelegramExtra(update);
      if (extraHandled) return;
      const cardHandled = await handleTelegramCardUniversal(update);
      if (cardHandled) return;

      // Network onboarding owns all setup text, especially API passwords.
      if (await setupActive(update)) {
        await handleTelegramUpdate(update);
        return;
      }

      // Guided creation owns its callbacks and custom-password input.
      const userCreateHandled = await handleTelegramUserCreate(update);
      if (userCreateHandled) return;

      // Full Direct user administration. Agent password/create/profile writes stay
      // blocked until the separate one-time Secret transport is implemented.
      const userAdminHandled = await handleTelegramUserAdmin(update);
      if (userAdminHandled) return;

      // High-priority intent corrections learned from real conversations.
      const overrideHandled = await handleHighPriorityIntentOverrides(update);
      if (overrideHandled) return;

      // Existing Direct privileged operations.
      const privilegedNaturalHandled = await handlePrivilegedNatural(update);
      if (privilegedNaturalHandled) return;

      // Primary deterministic language layer.
      const localHandled = await handleTelegramNaturalPro(update);
      if (localHandled) return;

      // AI remains only an optional rare fallback.
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
