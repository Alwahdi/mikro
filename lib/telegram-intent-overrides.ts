import { handleTelegramBackup } from "./telegram-backup";
import { normalizeLocalText } from "./telegram-nlu-v2";
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

export async function handleHighPriorityIntentOverrides(update:TgUpdate):Promise<boolean>{
  const m=update.message;if(!m?.text||!m.from)return false;const raw=m.text.trim();if(!raw)return false;const n=normalizeLocalText(raw);

  // A recurring ping is a scheduler request, never a card/username lookup.
  const spec=recurrence(raw);
  if(spec&&asksPing(n)){
    return createScheduledTask(update,"ping",spec);
  }

  // "Full/complete backup" means the restorable encrypted system backup unless
  // the user explicitly asked for an RSC/text export.
  if(asksFullBackup(n)){
    return handleTelegramBackup(update,"binary");
  }

  return false;
}
