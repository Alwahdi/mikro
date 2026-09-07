import { decryptSecret } from "./telegram-crypto";
import { dbGet, dbInsert } from "./telegram-db";
import { RouterOSClient } from "./routeros-api";
import type { TgUpdate } from "./telegram-extra";

type BotUser={telegram_user_id:number;active_network_id?:string|null};
type Network={id:string;telegram_user_id:number;label:string;identity?:string|null;connection_mode:"direct"|"agent";host?:string|null;port?:number|null;username?:string|null;password_ciphertext?:string|null;protocol:"api"|"api-ssl";tls_verify:boolean;router_os_version?:string|null;agent_last_seen_at?:string|null};

type DirectSnapshot={
  identity:string;
  version:string;
  cpu:number;
  ram:number;
  uptime:string;
  online:number;
  pingReplies:number;
  pingCount:number;
  avgPingMs:number|null;
  lossPct:number;
  dnsReplies:number|null;
  activeDefaultRoutes:number;
  defaultRoutes:number;
  pppoeConfigured:number;
  pppoeRunning:number;
};

function botToken(){const v=process.env.TELEGRAM_BOT_TOKEN;if(!v)throw new Error("TELEGRAM_BOT_TOKEN is missing");return v;}
function esc(v:unknown){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");}
async function send(chatId:number,text:string){const r=await fetch(`https://api.telegram.org/bot${botToken()}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text,parse_mode:"HTML",disable_web_page_preview:true}),cache:"no-store"});const j=await r.json();if(!j.ok)throw new Error(j.description||`Telegram ${r.status}`);return j.result;}

async function activeNetwork(uid:number){const u=(await dbGet<BotUser>("tg_users",{telegram_user_id:`eq.${uid}`,select:"telegram_user_id,active_network_id",limit:"1"}))[0];if(!u?.active_network_id)return null;return (await dbGet<Network>("tg_networks",{id:`eq.${u.active_network_id}`,telegram_user_id:`eq.${uid}`,select:"*",limit:"1"}))[0]??null;}
function clientFor(n:Network){if(n.connection_mode!=="direct"||!n.host||!n.port||!n.username||!n.password_ciphertext)throw new Error("Direct API credentials are incomplete");return new RouterOSClient({host:n.host,port:n.port,username:n.username,password:decryptSecret(n.password_ciphertext),tls:n.protocol==="api-ssl",rejectUnauthorized:n.tls_verify,timeoutMs:12000,maxLifetimeMs:70000});}
function num(v:unknown){const x=Number(v||0);return Number.isFinite(x)?x:0;}
function parseTimeMs(v?:string){if(!v)return null;let total=0,found=false;for(const m of v.matchAll(/([0-9.]+)(ms|us|µs|s)/g)){const n=Number(m[1]);if(!Number.isFinite(n))continue;found=true;total+=m[2]==="s"?n*1000:m[2]==="ms"?n:n/1000;}return found?total:null;}

async function snapshotDirect(n:Network):Promise<DirectSnapshot>{const c=clientFor(n);try{
  const resource=await c.command("/system/resource/print",["=.proplist=version,cpu-load,free-memory,total-memory,uptime"]);const identity=await c.command("/system/identity/print",["=.proplist=name"]);const active=await c.command("/ip/hotspot/active/print",["=.proplist=user"]);const r=resource[0]||{};const total=num(r["total-memory"]),free=num(r["free-memory"]);const ram=total?Math.round((1-free/total)*100):0;
  let pingRows:Record<string,string>[]=[];try{pingRows=await c.command("/ping",["=address=8.8.8.8","=count=5"]);}catch{}const times=pingRows.map(x=>parseTimeMs(x.time)).filter((x):x is number=>x!==null);const replies=times.length;const loss=Math.round((1-replies/5)*100);const avg=times.length?Math.round(times.reduce((a,b)=>a+b,0)/times.length):null;
  let dnsReplies:number|null=null;if(replies>0){try{const dns=await c.command("/ping",["=address=google.com","=count=2"]);dnsReplies=dns.filter(x=>parseTimeMs(x.time)!==null).length;}catch{dnsReplies=0;}}
  let routes:Record<string,string>[]=[];try{routes=await c.command("/ip/route/print",["=.proplist=dst-address,gateway,distance,active,disabled,dynamic",'?dst-address=0.0.0.0/0']);}catch{}
  let ppp:Record<string,string>[]=[];try{ppp=await c.command("/interface/pppoe-client/print",["=.proplist=name,running,disabled"]);}catch{}
  return{identity:identity[0]?.name||n.identity||n.label,version:r.version||n.router_os_version||"-",cpu:num(r["cpu-load"]),ram,uptime:r.uptime||"-",online:active.length,pingReplies:replies,pingCount:5,avgPingMs:avg,lossPct:loss,dnsReplies,defaultRoutes:routes.filter(x=>x.disabled!=="true").length,activeDefaultRoutes:routes.filter(x=>x.disabled!=="true"&&x.active==="true").length,pppoeConfigured:ppp.filter(x=>x.disabled!=="true").length,pppoeRunning:ppp.filter(x=>x.disabled!=="true"&&x.running==="true").length};
}finally{c.close();}}

function renderDirect(s:DirectSnapshot){const issues:string[]=[];const actions:string[]=[];
  if(s.pingReplies===0){if(s.pppoeConfigured>0&&s.pppoeRunning===0){issues.push("🔴 لا يوجد رد من الإنترنت وPPPoE المفعّل غير Running.");actions.push("افحص جلسة PPPoE والخط/المودم قبل تغيير إعدادات Hotspot.");}else if(s.defaultRoutes>0&&s.activeDefaultRoutes===0){issues.push("🔴 الإنترنت لا يرد ولا توجد Default Route فعّالة.");actions.push("افحص الـWAN والـgateway والـdefault route.");}else{issues.push("🔴 لم يصل أي رد من 8.8.8.8.");actions.push("المشكلة أقرب للـWAN/مزود الخدمة أو routing؛ الشبكة الداخلية ليست أول متهم.");}}
  else{if(s.lossPct>=25){issues.push(`🟠 Packet loss مرتفع: ${s.lossPct}%.`);actions.push("افحص جودة الخط الخارجي والـWAN قبل تعديل السرعات الداخلية.");}else if(s.lossPct>0){issues.push(`🟡 يوجد Packet loss بسيط: ${s.lossPct}%.`);}if((s.avgPingMs??0)>=250){issues.push(`🟠 Ping مرتفع: ${s.avgPingMs}ms.`);actions.push("افحص ضغط الـWAN وQueues وأعلى المستهلكين وجودة المزود.");}else if((s.avgPingMs??0)>=120){issues.push(`🟡 Ping أعلى من المثالي: ${s.avgPingMs}ms.`);}if(s.dnsReplies===0){issues.push("🟠 الوصول بالـIP يعمل لكن اختبار الاسم لم يرد؛ توجد علامة على مشكلة DNS.");actions.push("راجع DNS servers و/​ip dns قبل تغيير Hotspot.");}}
  if(s.cpu>=90){issues.push(`🔴 CPU مرتفع جدًا: ${s.cpu}%.`);actions.push("حدد العملية/الخدمة التي تستهلك CPU قبل إضافة Rules جديدة.");}else if(s.cpu>=75){issues.push(`🟠 CPU مرتفع: ${s.cpu}%.`);}if(s.ram>=92){issues.push(`🟠 استخدام RAM مرتفع: ${s.ram}%.`);}if(!issues.length){issues.push("🟢 المؤشرات الأساسية التي فحصتها طبيعية الآن.");actions.push("لا يوجد سبب واضح لتغيير الإعدادات حاليًا. إذا المشكلة متقطعة فعّل التنبيهات لالتقاطها وقت حدوثها.");}
  const internet=s.pingReplies>0?"🟢 يعمل":"🔴 لا يرد";const dns=s.dnsReplies===null?"—":s.dnsReplies>0?"🟢 يعمل":"🔴 مشتبه";
  return `🔎 <b>${esc(s.identity)} • تشخيص الشبكة</b>\n━━━━━━━━━━━━━━━━━━\n🌐 الإنترنت: ${internet}\n📍 Ping: <b>${s.pingReplies}/${s.pingCount}</b>${s.avgPingMs!==null?` • متوسط <b>${s.avgPingMs}ms</b>`:""}\n📉 Packet loss: <b>${s.lossPct}%</b>\n🔤 DNS: ${dns}\n🛣 Default routes: <b>${s.activeDefaultRoutes}/${s.defaultRoutes}</b> فعّالة\n🔗 PPPoE: <b>${s.pppoeRunning}/${s.pppoeConfigured}</b> Running\n👥 Hotspot online: <b>${s.online}</b>\n⚙️ CPU: <b>${s.cpu}%</b>\n🧠 RAM: <b>${s.ram}%</b>\n⏱ Uptime: ${esc(s.uptime)}\n🧩 RouterOS: ${esc(s.version)}\n\n<b>🧠 القراءة</b>\n${issues.join("\n")}\n\n<b>🎯 الإجراء المقترح</b>\n${actions.slice(0,3).map((x,i)=>`${i+1}. ${esc(x)}`).join("\n")}`;}

export function renderAgentDiagnosis(data:Record<string,string>){const total=num(data.total_memory),free=num(data.free_memory),ram=total?Math.round((1-free/total)*100):0,ping=num(data.ping_replies),cpu=num(data.cpu),ppp=num(data.pppoe_running),online=num(data.online);const issues:string[]=[];const actions:string[]=[];
  if(ping===0){if(ppp===0){issues.push("🔴 الإنترنت لا يرد ولا توجد جلسة PPPoE Running في Telemetry الحالية.");actions.push("افحص الـWAN/PPPoE من الراوتر قبل تعديل Hotspot.");}else{issues.push("🔴 لا يوجد رد Ping من الراوتر رغم وجود PPPoE Running.");actions.push("افحص المزود أو routing/default route.");}}if(cpu>=90){issues.push(`🔴 CPU مرتفع جدًا: ${cpu}%.`);actions.push("راجع الحمل على الراوتر.");}else if(cpu>=75)issues.push(`🟠 CPU مرتفع: ${cpu}%.`);if(ram>=92)issues.push(`🟠 RAM مرتفع: ${ram}%.`);if(!issues.length){issues.push("🟢 المؤشرات المتاحة عبر Agent طبيعية الآن.");actions.push("إذا المشكلة متقطعة، فعّل التنبيهات لالتقاطها وقت حدوثها.");}
  return `🔎 <b>${esc(data.identity||"MikroTik")} • تشخيص الشبكة</b>\n━━━━━━━━━━━━━━━━━━\n🌐 الإنترنت: ${ping>0?"🟢 يعمل":"🔴 لا يرد"}\n📍 Ping replies: <b>${ping}/3</b>\n🔗 PPPoE Running: <b>${ppp}</b>\n👥 المتصلون: <b>${online}</b>\n⚙️ CPU: <b>${cpu}%</b>\n🧠 RAM: <b>${ram}%</b>\n⏱ Uptime: ${esc(data.uptime||"-")}\n🧩 RouterOS: ${esc(data.version||"-")}\n\n<b>🧠 القراءة</b>\n${issues.join("\n")}\n\n<b>🎯 الإجراء المقترح</b>\n${actions.slice(0,3).map((x,i)=>`${i+1}. ${esc(x)}`).join("\n")}\n\nℹ️ Agent الحالي يؤكد وصول Ping لكنه لا يقيس زمن latency بالمللي ثانية؛ لذلك لن أخمّن قيمة غير موجودة.`;}

export async function handleTelegramDiagnose(update:TgUpdate):Promise<boolean>{const m=update.message;if(!m?.from)return false;const n=await activeNetwork(m.from.id);if(!n){await send(m.chat.id,"📭 لا توجد شبكة نشطة. أضف أو اختر شبكة أولاً.");return true;}if(n.connection_mode==="agent"){const last=n.agent_last_seen_at?new Date(n.agent_last_seen_at).getTime():0;const online=Date.now()-last<90_000;const waiting=await send(m.chat.id,`${online?"🔎":"🟠"} <b>${esc(n.identity||n.label)}</b>\nجاري جمع Telemetry التشخيص عبر Agent…`);await dbInsert("tg_agent_commands",{network_id:n.id,telegram_user_id:m.from.id,chat_id:m.chat.id,reply_message_id:waiting.message_id,kind:"status",payload:{mode:"diagnose"},status:"pending"});return true;}
  await send(m.chat.id,`🔎 <b>${esc(n.identity||n.label)}</b>\nأفحص الإنترنت وDNS وWAN/PPPoE والـdefault route وموارد الراوتر…\n🔒 قراءة فقط؛ لن أغيّر أي إعداد.`);try{const s=await snapshotDirect(n);await send(m.chat.id,renderDirect(s));}catch(e){await send(m.chat.id,`🔴 تعذر إكمال التشخيص.\n<code>${esc(e instanceof Error?e.message:e)}</code>`);}return true;}
