import { handleTelegramAlerts } from "./telegram-alerts";
import { handleTelegramBackup } from "./telegram-backup";
import { dbGet } from "./telegram-db";
import { normalizeLocalText, type LocalNluContext } from "./telegram-nlu-v2";
import { handlePrivilegedNatural } from "./telegram-privileged";
import { createScheduledTask } from "./telegram-scheduler";
import type { ScheduleSpec } from "./telegram-nlu-pro";
import type { TgUpdate } from "./telegram-extra";

function recurrence(raw:string):ScheduleSpec|null{
  const n=normalizeLocalText(raw);
  const everyMinute=/(?:كل\s*(?:دقيقه|دقيقة)|every\s+minute)/i.test(n);
  if(everyMinute)return{kind:"interval",minutes:1,text:raw.trim()};
  const m=n.match(/(?:كل|every)\s*(\d{1,3})\s*(دقيقه|دقيقة|دقايق|دقائق|minutes?|ساعه|ساعة|ساعات|hours?)/i);
  if(m){const amount=Number(m[1]);const minutes=/(?:ساع|hour)/i.test(m[2])?amount*60:amount;if(Number.isInteger(minutes)&&minutes>=1&&minutes<=10080)return{kind:"interval",minutes,text:raw.trim()};}
  if(/(?:كل\s*ساعه|كل\s*ساعة|hourly)/i.test(n))return{kind:"interval",minutes:60,text:raw.trim()};
  if(/(?:كل\s*ساعتين|every\s+two\s+hours)/i.test(n))return{kind:"interval",minutes:120,text:raw.trim()};
  return null;
}

function asksPing(n:string){return /(?:ping|بنج|بينق|اختبر.*(?:نت|انترنت|شبكه|شبكة)|افحص.*(?:ping|بنج|بينق))/i.test(n);}
function asksFullBackup(n:string){return /(?:نسخه|نسخة|backup|باك\s*اب|باكاب)/i.test(n)&&/(?:كامله|كاملة|كامل|full|complete|استعاده|استعادة|restore)/i.test(n)&&!/(?:rsc|export|تصدير|نصي|نصيه|نصية)/i.test(n);}

async function lastContext(uid:number){return (await dbGet<LocalNluContext>("tg_nlu_context",{telegram_user_id:`eq.${uid}`,select:"*",limit:"1"}))[0]??null;}
function withText(update:TgUpdate,text:string):TgUpdate{if(!update.message)return update;return{...update,message:{...update.message,text}};}

async function colloquialPrivileged(update:TgUpdate,n:string){
  const m=update.message;if(!m?.from)return false;

  let transformed=m.text?.trim()||"";
  if(/^(?:بلك|بلوك|امنع|احظر)\s+/i.test(n)) transformed=transformed.replace(/^(?:بلك|بلوك|امنع|احظر)\s+/iu,"عطل ");
  else if(/^(?:فك\s+الحظر|شيل\s+الحظر|الغ\s+الحظر)\s+(?:عن\s+)?/i.test(n)) transformed=transformed.replace(/^(?:فك\s+الحظر|شيل\s+الحظر|الغ\s+الحظر)\s+(?:عن\s+)?/iu,"شغل ");
  if(transformed!==(m.text?.trim()||"")){
    if(await handlePrivilegedNatural(withText(update,transformed)))return true;
  }

  const ctx=await lastContext(m.from.id);if(!ctx?.last_entity_type||!ctx.last_entity_value)return false;
  const disconnect=/^(?:افصله|افصلها|طلعه|طلعها|اطرده|اطردها|اخرجه|اخرجها)$/i.test(n);
  const disable=/^(?:عطله|عطلها|وقفه|وقفها|اقفله|اقفلها|سكره|سكرها|امنعه|امنعها|احظره|احظرها|بلكه|بلكها|بلوكه|بلوكها)$/i.test(n);
  const enable=/^(?:رجعه|رجعها|فعله|فعلها|شغله|شغلها|افتحه|افتحها|فك\s+الحظر|شيل\s+الحظر|الغ\s+الحظر)$/i.test(n);
  if(!disconnect&&!disable&&!enable)return false;

  if(ctx.last_entity_type==="card"){
    const verb=disconnect?"افصل":disable?"عطل":"شغل";
    return handlePrivilegedNatural(withText(update,`${verb} الكرت ${ctx.last_entity_value}`));
  }
  if(ctx.last_entity_type==="vlan"&&!disconnect){
    const verb=disable?"عطل":"شغل";
    return handlePrivilegedNatural(withText(update,`${verb} vlan ${ctx.last_entity_value}`));
  }
  return false;
}

export async function handleHighPriorityIntentOverrides(update:TgUpdate):Promise<boolean>{
  const m=update.message;if(!m?.text||!m.from)return false;const raw=m.text.trim();if(!raw)return false;const n=normalizeLocalText(raw);

  // Stateful alert controls take precedence over ordinary NLU.
  if(await handleTelegramAlerts(update))return true;

  // A recurring ping is a scheduler request, never a card/username lookup.
  const spec=recurrence(raw);
  if(spec&&asksPing(n)) return createScheduledTask(update,"ping",spec);

  // "Full/complete backup" means the restorable encrypted system backup unless
  // the user explicitly asked for an RSC/text export.
  if(asksFullBackup(n)) return handleTelegramBackup(update,"binary");

  if(await colloquialPrivileged(update,n))return true;

  return false;
}
