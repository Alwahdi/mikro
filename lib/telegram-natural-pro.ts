import { dbGet, dbInsert, dbUpsert } from "./telegram-db";
import { handleTelegramBackup } from "./telegram-backup";
import { handleTelegramCardUniversal } from "./telegram-card-universal";
import { handleTelegramExtra, type TgUpdate } from "./telegram-extra";
import { handleTelegramOps } from "./telegram-ops";
import { handleTelegramSales } from "./telegram-sales";
import { createScheduledTask, showScheduledTasks, cancelScheduledTask } from "./telegram-scheduler";
import { handleTelegramUpdate } from "./telegram-bot";
import { understandProfessionalMessage, type ProResult } from "./telegram-nlu-pro";
import type { LocalNluContext } from "./telegram-nlu-v2";

type ContextRow=LocalNluContext&{telegram_user_id:number};
function token(){const v=process.env.TELEGRAM_BOT_TOKEN;if(!v)throw new Error("TELEGRAM_BOT_TOKEN missing");return v;}
function esc(v:unknown){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");}
async function send(chatId:number,text:string,reply_markup?:unknown){const r=await fetch(`https://api.telegram.org/bot${token()}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text,parse_mode:"HTML",reply_markup}),cache:"no-store"});const j=await r.json();if(!j.ok)throw new Error(j.description||`Telegram ${r.status}`);}
function withText(update:TgUpdate,text:string):TgUpdate{if(!update.message)return update;return {...update,message:{...update.message,text}};}
async function loadContext(uid:number){const r=await dbGet<ContextRow>("tg_nlu_context",{telegram_user_id:`eq.${uid}`,select:"*",limit:"1"});return r[0]??null;}
async function saveContext(uid:number,p:ProResult){
  let type:string|null=null,value:string|null=null;
  if(p.entities.card){type="card";value=p.entities.card;}else if(p.entities.vlan_id){type="vlan";value=String(p.entities.vlan_id);}else if(p.entities.network_index){type="network";value=String(p.entities.network_index);}
  await dbUpsert("tg_nlu_context",{telegram_user_id:uid,last_intent:p.intent,last_entity_type:type,last_entity_value:value,updated_at:new Date().toISOString()},"telegram_user_id");
}
async function log(update:TgUpdate,p:ProResult,outcome:string,error?:unknown){const m=update.message;if(!m?.from||!m.text)return;try{await dbInsert("tg_interactions",{telegram_user_id:m.from.id,chat_id:m.chat.id,update_id:update.update_id,user_text:m.text,normalized_text:p.normalized,intent:p.intent,confidence:p.confidence,entities:p.entities,handled_by:"local-nlu-pro",outcome,error_text:error?String(error).slice(0,1000):null});}catch{}
}

const help=`🧠 <b>MikroTik Assistant • بدون AI</b>\n━━━━━━━━━━━━━━━━━━\nاكتب بطريقتك الطبيعية، مثلاً:\n\n👥 «كم واحد داخل الحين؟»\n🎫 «افحص الكرت AB-12_X وجيب جلساته»\n💰 «كم بعنا اليوم؟»\n🧩 «وش وضع VLAN 202؟»\n🌐 «النت يقطع افحصه»\n🧾 «جيب آخر أخطاء الراوتر»\n🔌 «اعرض الواجهات»\n📬 «كم DHCP lease عندي؟»\n🏆 «مين أكثر واحد يستهلك؟»\n🧰 «خذ لي نسخة RSC الآن»\n🔐 «سوي binary backup»\n🗓 «كل يوم الساعة 3 الفجر خذ نسخة RSC»\n🗓 «كل 6 ساعات ارسل تقرير الحالة»\n\nأفهم أرقام وحروف ورموز في أسماء الكروت، وأتذكر آخر كرت/VLAN في المحادثة.`;

export async function handleTelegramNaturalPro(update:TgUpdate):Promise<boolean>{
  const m=update.message;if(!m?.text||!m.from)return false;const raw=m.text.trim();if(!raw||raw.startsWith("/"))return false;
  const ctx=await loadContext(m.from.id);const p=understandProfessionalMessage(raw,ctx);
  if(p.intent==="unknown"){
    await log(update,p,"unknown");
    await send(m.chat.id,`🧭 <b>وصلني طلبك، لكن لا أريد أخمّن وأنفذ الشيء الخطأ.</b>\n\nأقدر أتعامل مباشرة مع: المستخدمين، الكروت والجلسات، المبيعات، VLAN، حالة الشبكة، Ping، الراوتر، Logs، DHCP، Hotspot، الاستهلاك، Backup والجدولة.\n\nاكتب المطلوب بنفس طريقتك مع اسم الشيء، مثلاً:\n<code>افحص اليوزر ABC-12 بالكامل</code>\n<code>خذ نسخة rsc وارسلها لي</code>\n<code>كل يوم الساعة 3 ارسل تقرير الحالة</code>`);
    return true;
  }
  try{
    await saveContext(m.from.id,p);
    if(p.intent==="card"&&p.entities.card){await log(update,p,"routed:card");return handleTelegramCardUniversal(withText(update,`/card ${p.entities.card}`));}
    if(p.intent==="online"){await log(update,p,"routed:online");return handleTelegramExtra(withText(update,"/online"));}
    if(p.intent==="sales"){await log(update,p,"routed:sales");return handleTelegramSales(withText(update,"/sales"));}
    if(p.intent==="vlans"){await log(update,p,"routed:vlans");return handleTelegramExtra(withText(update,"/vlans"));}
    if(p.intent==="vlan_detail"&&p.entities.vlan_id){await log(update,p,"routed:vlan");await handleTelegramUpdate(withText(update,`/vlan ${p.entities.vlan_id}`));return true;}
    if(p.intent==="router"){await log(update,p,"routed:router");return handleTelegramExtra(withText(update,"/router"));}
    if(p.intent==="ping"){await log(update,p,"routed:ping");await handleTelegramUpdate(withText(update,"/ping"));return true;}
    if(p.intent==="status"){await log(update,p,"routed:status");await handleTelegramUpdate(withText(update,"/status"));return true;}
    if(p.intent==="diagnose"){await log(update,p,"routed:diagnose");await send(m.chat.id,"🔎 <b>أفحص الشبكة من أكثر من جهة…</b>\nلن أغيّر أي إعداد.");await handleTelegramUpdate(withText(update,"/status"));await handleTelegramUpdate(withText(update,"/ping"));return true;}
    if(p.intent==="networks"){await log(update,p,"routed:networks");await handleTelegramUpdate(withText(update,"/networks"));return true;}
    if(p.intent==="use_network"&&p.entities.network_index){await log(update,p,"routed:use_network");await handleTelegramUpdate(withText(update,`/use ${p.entities.network_index}`));return true;}
    if(p.intent==="add_network"){await log(update,p,"routed:add");await handleTelegramUpdate(withText(update,"/add"));return true;}
    if(p.intent==="cancel"){await log(update,p,"routed:cancel");await handleTelegramUpdate(withText(update,"/cancel"));return true;}
    if(p.intent==="backup"){await log(update,p,`routed:backup:${p.entities.backup_type||"rsc"}`);return handleTelegramBackup(update,p.entities.backup_type==="binary"?"binary":"rsc");}
    if(p.intent==="schedule"&&p.entities.schedule&&p.entities.scheduled_task){await log(update,p,"routed:schedule");return createScheduledTask(update,p.entities.scheduled_task,p.entities.schedule);}
    if(p.intent==="show_schedules"){await log(update,p,"routed:schedules");return showScheduledTasks(update);}
    if(p.intent==="cancel_schedule"&&p.entities.schedule_id){await log(update,p,"routed:cancel_schedule");return cancelScheduledTask(update,p.entities.schedule_id);}
    if(p.intent==="logs"||p.intent==="interfaces"||p.intent==="dhcp"||p.intent==="hotspot"||p.intent==="top_usage"){await log(update,p,`routed:${p.intent}`);return handleTelegramOps(update,p.intent);}
    if(p.intent==="help"){await log(update,p,"help");await send(m.chat.id,help);return true;}
    if(p.intent==="greeting"){await log(update,p,"greeting");await send(m.chat.id,"هلا 👋 أنا جاهز. اسألني مباشرة عن الشبكة أو الكروت أو قل لي المهمة التي تريد تنفيذها.\n\nمثال: <code>افحص الشبكة كاملة</code>");return true;}
    if(p.intent==="thanks"){await log(update,p,"thanks");await send(m.chat.id,"تحت أمرك ✅ إذا تريد نكمل على نفس الكرت أو الشبكة، قل المطلوب مباشرة.");return true;}
    await log(update,p,"unhandled-known");return false;
  }catch(e){await log(update,p,"error",e);await send(m.chat.id,`🔴 تعذر تنفيذ الطلب بعد أن فهمته كـ <b>${esc(p.intent)}</b>.\n<code>${esc(e instanceof Error?e.message:e)}</code>`);return true;}
}
