import { after, NextRequest, NextResponse } from "next/server";
import { dbGet } from "@/lib/telegram-db";
import { handleTelegramAIV2 } from "@/lib/telegram-ai-v2";
import { handleTelegramAgentPrivileged } from "@/lib/telegram-agent-privileged";
import { handleTelegramAgentUserAdmin } from "@/lib/telegram-agent-user-admin";
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
async function setupActive(update:TgUpdate){const m=update.message;if(!m?.from||!m.text||m.text.trim().startsWith("/"))return false;const rows=await dbGet<SetupRow>("tg_users",{telegram_user_id:`eq.${m.from.id}`,select:"setup_state",limit:"1"});return Boolean(rows[0]?.setup_state&&rows[0].setup_state!=="idle");}

export async function POST(req:NextRequest){const expected=process.env.TELEGRAM_WEBHOOK_SECRET;const supplied=req.headers.get("x-telegram-bot-api-secret-token");if(!expected||supplied!==expected)return NextResponse.json({ok:false},{status:401});let update:TgUpdate;try{update=(await req.json()) as TgUpdate;}catch{return NextResponse.json({ok:false,error:"invalid-json"},{status:400});}
  after(async()=>{try{
    if(await handlePrivilegedCallback(update))return;
    if(await handleTelegramAgentPrivileged(update))return;
    // Agent user-admin owns aua:* callbacks, password input and Agent-only admin requests.
    if(await handleTelegramAgentUserAdmin(update))return;
    if(await handleTelegramCommandRouter(update))return;
    if(await handleTelegramSales(update))return;
    if(await handleTelegramExtra(update))return;
    if(await handleTelegramCardUniversal(update))return;
    if(await setupActive(update)){await handleTelegramUpdate(update);return;}
    if(await handleTelegramUserCreate(update))return;
    if(await handleTelegramUserAdmin(update))return;
    if(await handleTelegramUserSearch(update))return;
    if(await handleHighPriorityIntentOverrides(update))return;
    if(await handlePrivilegedNatural(update))return;
    if(await handleTelegramNaturalPro(update))return;
    if(process.env.MIKRO_AI_ENABLED==="true"&&await handleTelegramAIV2(update))return;
    await handleTelegramUpdate(update);
  }catch(error){console.error("telegram update processing error",error);}});
  return NextResponse.json({ok:true});}
