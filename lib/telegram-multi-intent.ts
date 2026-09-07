import { handleTelegramCommandRouter } from "./telegram-command-router";
import { handleTelegramUpdate } from "./telegram-bot";
import { dbInsert } from "./telegram-db";
import { normalizeLocalText } from "./telegram-nlu-v2";
import type { TgUpdate } from "./telegram-extra";

type ReadIntent =
  | "card"
  | "status"
  | "ping"
  | "online"
  | "sales"
  | "router"
  | "vlan"
  | "vlans"
  | "logs"
  | "interfaces"
  | "dhcp"
  | "hotspot"
  | "top"
  | "alerts"
  | "schedules";

type PlannedTask = { intent: ReadIntent; command: string; label: string };

function token(){const value=process.env.TELEGRAM_BOT_TOKEN;if(!value)throw new Error("TELEGRAM_BOT_TOKEN is missing");return value;}
function esc(value:unknown){return String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");}
async function send(chatId:number,text:string){const response=await fetch(`https://api.telegram.org/bot${token()}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text,parse_mode:"HTML",disable_web_page_preview:true}),cache:"no-store"});const json=await response.json();if(!json.ok)throw new Error(json.description||`Telegram ${response.status}`);}
function withText(update:TgUpdate,text:string):TgUpdate{if(!update.message)return update;return {...update,message:{...update.message,text}};}

const BLOCKED_USER_VALUES=new Set(["الان","الآن","الحين","اليوم","هذا","هذه","هذي","وضعه","حاله","حالته","online","status"]);
function extractCardUsername(raw:string){const quoted=raw.match(/["'«]([^"'»]{2,128})["'»]/u)?.[1]?.trim();if(quoted&&/^[\p{L}\p{N}_.@:+-]{2,128}$/u.test(quoted))return quoted;const match=raw.match(/(?:الكرت|كرت|اليوزر|يوزر|المستخدم|مستخدم|card|user)(?=$|\s|[:#-])\s*(?:رقم|اسم|اسمه|number|name)?\s*[:#-]?\s*([\p{L}\p{N}_.@:+-]{2,128})/iu);const value=match?.[1]?.trim();if(!value||BLOCKED_USER_VALUES.has(value))return null;return value;}

function detectTasks(raw:string):PlannedTask[]{const n=normalizeLocalText(raw),tasks:PlannedTask[]=[];const seen=new Set<string>();const add=(task:PlannedTask)=>{const key=task.intent==="vlan"?task.command:task.intent;if(seen.has(key))return;seen.add(key);tasks.push(task);};const card=extractCardUsername(raw);if(card&&/(?:افحص|شيك|شوف|راجع|جلسات|استهلاك|تفاصيل|inspect|check|sessions?|usage)/iu.test(n))add({intent:"card",command:`/card ${card}`,label:`فحص ${card}`});const vlanMatch=raw.match(/(?:vlan|فيلان|فلان)\s*#?\s*(\d{1,4})/i),vlanId=Number(vlanMatch?.[1]||0);if(vlanId>=1&&vlanId<=4094&&/(?:شوف|افحص|تفاصيل|وضع|حاله|حالة|check|status|details?)/iu.test(n))add({intent:"vlan",command:`/vlan ${vlanId}`,label:`VLAN ${vlanId}`});if(/(?:طمني|طمّني|كيف|وش|ايش|حاله|حالة|الحاله|الوضع|وضع|صحه|صحة).*(?:الشبكه|الشبكة|النت|الانترنت|الإنترنت)/iu.test(n)||/(?:network\s+(?:status|health)|internet\s+status)/i.test(n))add({intent:"status",command:"/status",label:"حالة الشبكة"});if(/(?:ping|بنج|بينق|latency|تاخير|تأخير)/iu.test(n))add({intent:"ping",command:"/ping",label:"Ping"});if(/(?:المتصلين|متصلين|الداخلين|داخلين|شابكين|اونلاين|أونلاين|online\s+users?|active\s+users?|clients?)/iu.test(n)||/(?:كم|عدد|مين|من|جيب|اعرض).{0,24}(?:متصل|داخل|شابك|اونلاين|أونلاين)/iu.test(n))add({intent:"online",command:"/online",label:"المتصلون الآن"});if(/(?:مبيعات|مبيعات\s+اليوم|بعنا|بيع\s+اليوم|sales|sold\s+today)/iu.test(n))add({intent:"sales",command:"/sales",label:"مبيعات اليوم"});if(/(?:معلومات\s+(?:الراوتر|راوتر)|اصدار|إصدار|routeros|router\s+info|version|cpu|الرام|\bram\b|uptime)/iu.test(n))add({intent:"router",command:"/router",label:"معلومات الراوتر"});if(!vlanMatch&&/(?:vlans|الفيلانات|فيلانات|قائمه\s*(?:vlan|الفيلانات)|قائمة\s*(?:vlan|الفيلانات)|اعرض.{0,16}(?:vlan|فيلان))/iu.test(n))add({intent:"vlans",command:"/vlans",label:"VLANs"});if(/(?:\blogs?\b|اللوق|لوقات|سجل\s+الراوتر|اخطاء\s+الراوتر|أخطاء\s+الراوتر|router\s+errors?)/iu.test(n))add({intent:"logs",command:"/logs",label:"Logs"});if(/(?:interfaces?|انترفيس|انترفيسات|الانترفيسات|منافذ\s+الراوتر)/iu.test(n))add({intent:"interfaces",command:"/interfaces",label:"Interfaces"});if(/(?:dhcp|leases?|ليزات|عناوين.{0,20}(?:موزعه|موزعة))/iu.test(n))add({intent:"dhcp",command:"/dhcp",label:"DHCP"});if(/(?:hotspot|هوتسبوت|الهوتسبوت)/iu.test(n))add({intent:"hotspot",command:"/hotspot",label:"Hotspot"});if(/(?:اكثر|أكثر|اعلى|أعلى).{0,24}(?:استهلاك|يسحب|تحميل)|top\s+(?:usage|consumers?)/iu.test(n))add({intent:"top",command:"/top",label:"أعلى الاستهلاك"});if(/(?:تنبيهاتي|اعرض\s+التنبيهات|أعرض\s+التنبيهات|show\s+alerts)/iu.test(n))add({intent:"alerts",command:"/alerts",label:"التنبيهات"});if(/(?:جدولي|المهام\s+المجدوله|المهام\s+المجدولة|show\s+schedules?|scheduled\s+jobs?)/iu.test(n))add({intent:"schedules",command:"/schedules",label:"المهام المجدولة"});return tasks;}

async function dispatch(update:TgUpdate,task:PlannedTask){const synthetic=withText(update,task.command);if(task.intent==="status"||task.intent==="ping"||task.intent==="vlan"){await handleTelegramUpdate(synthetic);return;}const handled=await handleTelegramCommandRouter(synthetic);if(!handled)await handleTelegramUpdate(synthetic);}
async function logPlan(update:TgUpdate,raw:string,tasks:PlannedTask[],outcome:string,error?:unknown){const m=update.message;if(!m?.from)return;try{await dbInsert("tg_interactions",{telegram_user_id:m.from.id,chat_id:m.chat.id,update_id:update.update_id,user_text:raw,normalized_text:normalizeLocalText(raw),intent:"multi_intent",confidence:0.995,entities:{tasks:tasks.map(x=>({intent:x.intent,command:x.command}))},handled_by:"local-multi-intent",outcome,error_text:error?String(error).slice(0,1000):null});}catch{}}

export async function handleTelegramMultiIntent(update:TgUpdate):Promise<boolean>{const message=update.message;if(!message?.from||!message.text)return false;const raw=message.text.trim();if(!raw||raw.startsWith("/"))return false;const tasks=detectTasks(raw);if(tasks.length<2)return false;const selected=tasks.slice(0,5),omitted=tasks.length-selected.length;await logPlan(update,raw,selected,"planned");await send(message.chat.id,`🧠 <b>فهمت الطلب المركّب</b>\n━━━━━━━━━━━━━━━━━━\nسأنفذ بالترتيب:\n${selected.map((task,index)=>`${index+1}. ${esc(task.label)}`).join("\n")}${omitted>0?`\n\n… وتركت ${omitted} فحص إضافي حتى لا أضغط الراوتر في رسالة واحدة.`:""}\n\n🔒 كل هذه الخطوات قراءة فقط ولن أغيّر أي إعداد.`);let failures=0;for(const task of selected){try{await dispatch(update,task);}catch(error){failures++;const messageText=error instanceof Error?error.message:String(error);await send(message.chat.id,`⚠️ تعذر إكمال <b>${esc(task.label)}</b>، وكملت بقية الطلب.\n<code>${esc(messageText.slice(0,240))}</code>`);}}await logPlan(update,raw,selected,failures?`completed:${selected.length-failures}/${selected.length}`:"completed");return true;}
