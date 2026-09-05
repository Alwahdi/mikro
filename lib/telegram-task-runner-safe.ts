import { randomBytes } from "crypto";
import { decryptSecret } from "./telegram-crypto";
import { dbGet, dbInsert, dbPatch } from "./telegram-db";
import { RouterOSClient } from "./routeros-api";
import { runSalesForNetwork } from "./telegram-sales";
import { nextRun } from "./telegram-scheduler";
import type { ScheduleSpec } from "./telegram-nlu-pro";

type Task={id:string;telegram_user_id:number;network_id:string;task_type:string;payload:Record<string,unknown>;next_run_at:string|null;enabled:boolean};
type Network={id:string;telegram_user_id:number;label:string;identity?:string|null;router_os_version?:string|null;connection_mode:"direct"|"agent";host?:string|null;port?:number|null;username?:string|null;password_ciphertext?:string|null;protocol:"api"|"api-ssl";tls_verify:boolean};

function token(){const v=process.env.TELEGRAM_BOT_TOKEN;if(!v)throw new Error("TELEGRAM_BOT_TOKEN is missing");return v;}
function esc(v:unknown){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");}
async function send(chatId:number,text:string){const r=await fetch(`https://api.telegram.org/bot${token()}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text,parse_mode:"HTML",disable_web_page_preview:true}),cache:"no-store"});const j=await r.json();if(!j.ok)throw new Error(j.description||`Telegram ${r.status}`);return j.result;}
function clientFor(n:Network){if(n.connection_mode!=="direct"||!n.host||!n.port||!n.username||!n.password_ciphertext)throw new Error("Direct API credentials are incomplete");return new RouterOSClient({host:n.host,port:n.port,username:n.username,password:decryptSecret(n.password_ciphertext),tls:n.protocol==="api-ssl",rejectUnauthorized:n.tls_verify,timeoutMs:25000});}
function exactNetwork(t:Task){return dbGet<Network>("tg_networks",{id:`eq.${t.network_id}`,telegram_user_id:`eq.${t.telegram_user_id}`,select:"*",limit:"1"}).then(r=>r[0]??null);}
function versionParts(v?:string|null){const m=/^(\d+)(?:\.(\d+))?/.exec(v||"");return {major:Number(m?.[1]||0),minor:Number(m?.[2]||0)};}
function taskLabel(t:string){return ({status:"تقرير الحالة",diagnose:"فحص الشبكة",ping:"Ping",sales:"مبيعات اليوم",backup_binary:"Binary Backup",backup_rsc:"RSC Backup"} as Record<string,string>)[t]||t;}

async function queueAgent(task:Task,kind:string,payload:Record<string,unknown>={}){
  const chatId=Number(task.payload?.chat_id||task.telegram_user_id);
  const msg=await send(chatId,`⏳ <b>${esc(task.payload?.network_label||"MikroTik")}</b>\nتشغيل المهمة المجدولة عبر Agent…`);
  await dbInsert("tg_agent_commands",{network_id:task.network_id,telegram_user_id:task.telegram_user_id,chat_id:chatId,reply_message_id:msg.message_id,kind,payload,status:"pending"});
}

async function directPing(task:Task,n:Network){
  const chatId=Number(task.payload?.chat_id||task.telegram_user_id);const c=clientFor(n);
  try{
    let rows:Record<string,string>[]=[];
    try{rows=await c.command("/ping",["=address=8.8.8.8","=count=5"]);}catch{}
    const replies=rows.filter(r=>Boolean(r.time)).length;const loss=Math.max(0,100-replies*20);
    const times=rows.map(r=>r.time).filter(Boolean);
    await send(chatId,`🌐 <b>${esc(n.identity||n.label)} • Ping مجدول</b>\n━━━━━━━━━━━━━━━━━━\n📍 8.8.8.8\n✅ الردود: <b>${replies}/5</b>\n📉 الفقد: <b>${loss}%</b>${times.length?`\n⏱ العينات: ${esc(times.slice(0,5).join(" • "))}`:""}\n\n🔒 منفذ على الراوتر المثبت في الجدول.`);
  }finally{c.close();}
}

async function directStatus(task:Task,n:Network,diagnose=false){
  const chatId=Number(task.payload?.chat_id||task.telegram_user_id);const c=clientFor(n);
  try{
    // Important: one RouterOS socket, one command at a time. No Promise.all here.
    const resource=await c.command("/system/resource/print",["=.proplist=version,cpu-load,free-memory,total-memory,uptime"]);
    const identity=await c.command("/system/identity/print",["=.proplist=name"]);
    const active=await c.command("/ip/hotspot/active/print",["=.proplist=user"]);
    let pingReplies=0;
    try{const rows=await c.command("/ping",["=address=8.8.8.8","=count=5"]);pingReplies=rows.filter(r=>Boolean(r.time)).length;}catch{}
    const r=resource[0]||{};const total=Number(r["total-memory"]||0);const free=Number(r["free-memory"]||0);const ram=total?Math.round((1-free/total)*100):0;
    await send(chatId,`${diagnose?"🔎":"📊"} <b>${esc(identity[0]?.name||n.identity||n.label)} • ${diagnose?"فحص مجدول":"تقرير مجدول"}</b>\n━━━━━━━━━━━━━━━━━━\n🌐 الإنترنت: ${pingReplies>0?"🟢 يعمل":"🔴 لم يصل رد Ping"}\n📍 Ping replies: <b>${pingReplies}/5</b>\n👥 Hotspot online: <b>${active.length}</b>\n⚙️ CPU: <b>${esc(r["cpu-load"]||"-")}%</b>\n🧠 RAM: <b>${ram}%</b>\n⏱ Uptime: ${esc(r.uptime||"-")}\n🧩 RouterOS: ${esc(r.version||n.router_os_version||"-")}\n\n🔒 المهمة منفذة على الراوتر المثبت في الجدول.`);
  }finally{c.close();}
}

async function directBinary(task:Task,n:Network){
  const chatId=Number(task.payload?.chat_id||task.telegram_user_id);const v=versionParts(n.router_os_version);if(v.major<6||(v.major===6&&v.minor<44))throw new Error("Binary Cloud Backup يحتاج RouterOS 6.44+");
  const password=randomBytes(18).toString("base64url");const safe=String(n.identity||n.label).replace(/[^A-Za-z0-9_.-]+/g,"_").slice(0,32)||"MikroTik";const name=`MTBOT-${safe}-${Date.now()}`;const c=clientFor(n);
  try{
    await c.command("/system/backup/cloud/upload-file",["=action=create-and-upload",`=name=${name}`,`=password=${password}`]);
    const rows=await c.command("/system/backup/cloud/print",["=.proplist=name,size,ros-version,date,status,secret-download-key"]);const row=rows.find(x=>x.name===name)||rows[0];if(!row||row.status!=="ok")throw new Error(row?.status||"Cloud backup was not confirmed");
    await dbInsert("tg_backup_history",{telegram_user_id:task.telegram_user_id,network_id:n.id,backup_type:"cloud-binary",cloud_backup_name:row.name||name,cloud_secret_key:row["secret-download-key"]||null,size_bytes:Number.parseInt(row.size||"0",10)||null,status:"sent"});
    await send(chatId,`✅ <b>Binary Backup المجدول اكتمل</b>\n━━━━━━━━━━━━━━━━━━\n📡 ${esc(n.identity||n.label)}\n📦 ${esc(row.size||"-")}\n🧩 ROS ${esc(row["ros-version"]||n.router_os_version||"-")}\n\n🔑 Password: <code>${esc(password)}</code>\n🔐 Secret key: <code>${esc(row["secret-download-key"]||"-")}</code>`);
  }finally{c.close();}
}

async function execute(task:Task){
  const n=await exactNetwork(task);if(!n)throw new Error("الشبكة المرتبطة بهذه المهمة لم تعد موجودة");
  if(task.task_type==="sales")return runSalesForNetwork(Number(task.payload?.chat_id||task.telegram_user_id),task.telegram_user_id,task.network_id);
  if(task.task_type==="backup_rsc")throw new Error("RSC المجدول متوقف حتى تتوفر وسيلة نقل ملف كامل على هذا الإصدار");
  if(n.connection_mode==="agent"){
    if(task.task_type==="status")return queueAgent(task,"status");
    if(task.task_type==="diagnose"){await queueAgent(task,"status");return queueAgent(task,"ping");}
    if(task.task_type==="ping")return queueAgent(task,"ping");
    if(task.task_type==="backup_binary")return queueAgent(task,"backup_binary");
  }
  if(task.task_type==="status")return directStatus(task,n,false);
  if(task.task_type==="diagnose")return directStatus(task,n,true);
  if(task.task_type==="ping")return directPing(task,n);
  if(task.task_type==="backup_binary")return directBinary(task,n);
  throw new Error(`Unsupported scheduled task: ${task.task_type}`);
}

export async function runDueTasksSafe(){
  const now=new Date();const due=await dbGet<Task>("tg_scheduled_tasks",{enabled:"eq.true",next_run_at:`lte.${now.toISOString()}`,select:"*",order:"next_run_at.asc",limit:"20"});const results:Array<{id:string;ok:boolean;network_id:string}>=[];
  for(const task of due){
    const spec=task.payload?.spec as ScheduleSpec|undefined;if(!spec){await dbPatch("tg_scheduled_tasks",{enabled:false,last_status:"invalid schedule",updated_at:now.toISOString()},{id:`eq.${task.id}`});results.push({id:task.id,ok:false,network_id:task.network_id});continue;}
    const next=nextRun(spec,now);
    await dbPatch("tg_scheduled_tasks",{next_run_at:next.toISOString(),last_run_at:now.toISOString(),last_status:"running",updated_at:now.toISOString()},{id:`eq.${task.id}`,next_run_at:`eq.${task.next_run_at}`});
    try{await execute(task);await dbPatch("tg_scheduled_tasks",{last_status:"ok",updated_at:new Date().toISOString()},{id:`eq.${task.id}`});results.push({id:task.id,ok:true,network_id:task.network_id});}
    catch(e){const msg=e instanceof Error?e.message:String(e);await dbPatch("tg_scheduled_tasks",{last_status:`error: ${msg.slice(0,300)}`,updated_at:new Date().toISOString()},{id:`eq.${task.id}`});try{await send(Number(task.payload?.chat_id||task.telegram_user_id),`🔴 فشلت المهمة المجدولة <b>${esc(taskLabel(task.task_type))}</b>\n${esc(msg)}`);}catch{}results.push({id:task.id,ok:false,network_id:task.network_id});}
  }
  return results;
}
