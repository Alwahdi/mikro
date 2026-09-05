import { dbGet, dbInsert, dbPatch } from "./telegram-db";
import { handleTelegramUpdate } from "./telegram-bot";
import { handleTelegramSales } from "./telegram-sales";
import { runBinaryCloudBackup, runRscBackup } from "./telegram-backup";
import type { ScheduleSpec } from "./telegram-nlu-pro";
import type { TgUpdate } from "./telegram-extra";

type BotUser={telegram_user_id:number;active_network_id?:string|null};
type Task={id:string;telegram_user_id:number;network_id:string;task_type:string;payload:Record<string,unknown>;schedule_text:string;timezone:string;next_run_at:string|null;last_run_at?:string|null;last_status?:string|null;enabled:boolean;created_at:string};

function token(){const v=process.env.TELEGRAM_BOT_TOKEN;if(!v)throw new Error("TELEGRAM_BOT_TOKEN is missing");return v;}
function esc(v:unknown){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");}
async function send(chatId:number,text:string){const r=await fetch(`https://api.telegram.org/bot${token()}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text,parse_mode:"HTML"}),cache:"no-store"});const j=await r.json();if(!j.ok)throw new Error(j.description||`Telegram ${r.status}`);return j.result;}

const ADEN_OFFSET_MS=3*60*60*1000;
function localParts(now:Date){const d=new Date(now.getTime()+ADEN_OFFSET_MS);return {y:d.getUTCFullYear(),m:d.getUTCMonth(),day:d.getUTCDate(),weekday:d.getUTCDay(),hour:d.getUTCHours(),minute:d.getUTCMinutes()};}
export function nextRun(spec:ScheduleSpec,from=new Date()){
  if(spec.kind==="interval") return new Date(from.getTime()+spec.minutes*60_000);
  const p=localParts(from);
  if(spec.kind==="daily"){
    let t=new Date(Date.UTC(p.y,p.m,p.day,spec.hour-3,spec.minute,0));
    if(t.getTime()<=from.getTime()+5_000)t=new Date(t.getTime()+24*60*60_000);
    return t;
  }
  let delta=(spec.weekday-p.weekday+7)%7;
  let t=new Date(Date.UTC(p.y,p.m,p.day+delta,spec.hour-3,spec.minute,0));
  if(t.getTime()<=from.getTime()+5_000)t=new Date(t.getTime()+7*24*60*60_000);
  return t;
}
function scheduleLabel(spec:ScheduleSpec){
  if(spec.kind==="interval") return `كل ${spec.minutes%60===0?`${spec.minutes/60} ساعة`:`${spec.minutes} دقيقة`}`;
  if(spec.kind==="daily") return `يوميًا ${String(spec.hour).padStart(2,"0")}:${String(spec.minute).padStart(2,"0")}`;
  const names=["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس","الجمعة","السبت"];
  return `كل ${names[spec.weekday]} ${String(spec.hour).padStart(2,"0")}:${String(spec.minute).padStart(2,"0")}`;
}
function taskLabel(task:string){return ({status:"تقرير الحالة",sales:"مبيعات اليوم",backup_rsc:"نسخة RSC",backup_binary:"Binary Cloud Backup",diagnose:"فحص الشبكة"} as Record<string,string>)[task]||task;}

export async function createScheduledTask(update:TgUpdate,taskType:string,spec:ScheduleSpec){
  const m=update.message;if(!m?.from)return false;
  const users=await dbGet<BotUser>("tg_users",{telegram_user_id:`eq.${m.from.id}`,select:"telegram_user_id,active_network_id",limit:"1"});
  const user=users[0];if(!user?.active_network_id){await send(m.chat.id,"📭 لا توجد شبكة نشطة لجدولة المهمة.");return true;}
  const next=nextRun(spec);
  const rows=await dbInsert<Task>("tg_scheduled_tasks",{telegram_user_id:m.from.id,network_id:user.active_network_id,task_type:taskType,payload:{chat_id:m.chat.id,spec},schedule_text:spec.text,timezone:"Asia/Aden",next_run_at:next.toISOString(),enabled:true,last_status:"scheduled"},"*");
  const id=rows[0]?.id||"";
  await send(m.chat.id,`✅ <b>تمت الجدولة</b>\n━━━━━━━━━━━━━━━━━━\n🧩 المهمة: <b>${esc(taskLabel(taskType))}</b>\n🗓 ${esc(scheduleLabel(spec))}\n⏭ التنفيذ القادم: <b>${esc(new Intl.DateTimeFormat("ar-YE",{timeZone:"Asia/Aden",dateStyle:"medium",timeStyle:"short"}).format(next))}</b>\n🆔 <code>${esc(id.slice(0,8))}</code>\n\nلن أغيّر إعدادات الشبكة إلا في نوع المهمة الذي طلبته صراحة.`);
  return true;
}

export async function showScheduledTasks(update:TgUpdate){
  const m=update.message;if(!m?.from)return false;
  const rows=await dbGet<Task>("tg_scheduled_tasks",{telegram_user_id:`eq.${m.from.id}`,enabled:"eq.true",select:"*",order:"created_at.asc",limit:"30"});
  if(!rows.length){await send(m.chat.id,"🗓 لا توجد مهام مجدولة حالياً.");return true;}
  const lines=rows.map((t,i)=>`${i+1}. <b>${esc(taskLabel(t.task_type))}</b>\n   ${esc(t.schedule_text)}\n   ⏭ ${t.next_run_at?esc(new Intl.DateTimeFormat("ar-YE",{timeZone:"Asia/Aden",dateStyle:"short",timeStyle:"short"}).format(new Date(t.next_run_at))):"-"}\n   🆔 <code>${esc(t.id.slice(0,8))}</code>`);
  await send(m.chat.id,`🗓 <b>المهام المجدولة</b>\n━━━━━━━━━━━━━━━━━━\n${lines.join("\n\n")}\n\nللإلغاء: اكتب مثلاً <code>الغ الجدول 2</code> أو أول 8 أحرف من المعرّف.`);return true;
}

export async function cancelScheduledTask(update:TgUpdate,ref:string){
  const m=update.message;if(!m?.from)return false;
  const rows=await dbGet<Task>("tg_scheduled_tasks",{telegram_user_id:`eq.${m.from.id}`,enabled:"eq.true",select:"*",order:"created_at.asc",limit:"50"});
  let task:Task|undefined;
  if(/^\d+$/.test(ref)){const i=Number(ref);task=rows[i-1];}else task=rows.find((r)=>r.id.startsWith(ref));
  if(!task){await send(m.chat.id,"❌ لم أجد هذه المهمة المجدولة. أرسل «جدولي» لعرضها.");return true;}
  await dbPatch("tg_scheduled_tasks",{enabled:false,last_status:"cancelled",updated_at:new Date().toISOString()},{id:`eq.${task.id}`,telegram_user_id:`eq.${m.from.id}`});
  await send(m.chat.id,`✅ ألغيت: <b>${esc(taskLabel(task.task_type))}</b> • <code>${esc(task.id.slice(0,8))}</code>`);return true;
}

async function executeTask(task:Task){
  const chatId=Number(task.payload?.chat_id||task.telegram_user_id);
  const fake: TgUpdate={update_id:Date.now(),message:{message_id:0,chat:{id:chatId},from:{id:task.telegram_user_id},text:""}};
  if(task.task_type==="backup_rsc") return runRscBackup(chatId,task.telegram_user_id,false);
  if(task.task_type==="backup_binary") return runBinaryCloudBackup(chatId,task.telegram_user_id,false);
  if(task.task_type==="sales"){fake.message!.text="/sales";return handleTelegramSales(fake);}
  if(task.task_type==="status"){fake.message!.text="/status";await handleTelegramUpdate(fake);return true;}
  if(task.task_type==="diagnose"){await send(chatId,"🔎 <b>الفحص المجدول</b>");fake.message!.text="/status";await handleTelegramUpdate(fake);fake.message!.text="/ping";await handleTelegramUpdate(fake);return true;}
  throw new Error(`Unsupported scheduled task: ${task.task_type}`);
}

export async function runDueTasks(){
  const now=new Date();
  const due=await dbGet<Task>("tg_scheduled_tasks",{enabled:"eq.true",next_run_at:`lte.${now.toISOString()}`,select:"*",order:"next_run_at.asc",limit:"20"});
  const results=[] as Array<{id:string;ok:boolean}>;
  for(const task of due){
    const spec=task.payload?.spec as ScheduleSpec|undefined;
    if(!spec){await dbPatch("tg_scheduled_tasks",{enabled:false,last_status:"invalid schedule",updated_at:now.toISOString()},{id:`eq.${task.id}`});results.push({id:task.id,ok:false});continue;}
    const next=nextRun(spec,now);
    await dbPatch("tg_scheduled_tasks",{next_run_at:next.toISOString(),last_run_at:now.toISOString(),last_status:"running",updated_at:now.toISOString()},{id:`eq.${task.id}`,next_run_at:`eq.${task.next_run_at}`});
    try{await executeTask(task);await dbPatch("tg_scheduled_tasks",{last_status:"ok",updated_at:new Date().toISOString()},{id:`eq.${task.id}`});results.push({id:task.id,ok:true});}
    catch(e){await dbPatch("tg_scheduled_tasks",{last_status:`error: ${String(e).slice(0,300)}`,updated_at:new Date().toISOString()},{id:`eq.${task.id}`});try{await send(Number(task.payload?.chat_id||task.telegram_user_id),`🔴 فشلت المهمة المجدولة <b>${esc(taskLabel(task.task_type))}</b>\n${esc(e instanceof Error?e.message:e)}`);}catch{}results.push({id:task.id,ok:false});}
  }
  return results;
}
