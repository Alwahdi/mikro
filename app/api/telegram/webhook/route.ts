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
import { handleTelegramUserSearch } from "@/lib/telegram-user-search";

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
      const privilegedCallbackHandled = await handlePrivilegedCallback(update);
      if (privilegedCallbackHandled) return;

      const agentPrivilegedHandled = await handleTelegramAgentPrivileged(update);
      if (agentPrivilegedHandled) return;

      const commandHandled = await handleTelegramCommandRouter(update);
      if (commandHandled) return;

      const salesHandled = await handleTelegramSales(update);
      if (salesHandled) return;
      const extraHandled = await handleTelegramExtra(update);
      if (extraHandled) return;
      const cardHandled = await handleTelegramCardUniversal(update);
      if (cardHandled) return;

      if (await setupActive(update)) {
        await handleTelegramUpdate(update);
        return;
      }

      const userCreateHandled = await handleTelegramUserCreate(update);
      if (userCreateHandled) return;

      const userAdminHandled = await handleTelegramUserAdmin(update);
      if (userAdminHandled) return;

      // Search is intentionally after create/admin so phrases such as
      // "أضف المستخدم X" can never be stolen by the generic user finder.
      const userSearchHandled = await handleTelegramUserSearch(update);
      if (userSearchHandled) return;

      const overrideHandled = await handleHighPriorityIntentOverrides(update);
      if (overrideHandled) return;

      const privilegedNaturalHandled = await handlePrivilegedNatural(update);
      if (privilegedNaturalHandled) return;

      const localHandled = await handleTelegramNaturalPro(update);
      if (localHandled) return;

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
