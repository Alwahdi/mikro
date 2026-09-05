import { randomBytes } from "crypto";
import { decryptSecret } from "./telegram-crypto";
import { dbGet, dbInsert, dbPatch } from "./telegram-db";
import { RouterOSClient } from "./routeros-api";
import type { TgUpdate } from "./telegram-extra";

type BotUser = { telegram_user_id:number; active_network_id?:string|null };
type Network = {
  id:string; telegram_user_id:number; label:string; connection_mode:"direct"|"agent";
  host?:string|null; port?:number|null; username?:string|null; password_ciphertext?:string|null;
  protocol:"api"|"api-ssl"; tls_verify:boolean; identity?:string|null; router_os_version?:string|null;
};

function token(){ const v=process.env.TELEGRAM_BOT_TOKEN; if(!v) throw new Error("TELEGRAM_BOT_TOKEN is missing"); return v; }
function esc(v:unknown){ return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"); }
async function send(chatId:number,text:string){
  const r=await fetch(`https://api.telegram.org/bot${token()}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text,parse_mode:"HTML"}),cache:"no-store"});
  const j=await r.json(); if(!j.ok) throw new Error(j.description||`Telegram ${r.status}`); return j.result;
}
async function sendDocument(chatId:number, filename:string, content:Uint8Array|string, caption:string){
  const form=new FormData(); form.append("chat_id",String(chatId)); form.append("caption",caption.slice(0,1000)); form.append("parse_mode","HTML");
  const blob=typeof content==="string"?new Blob([content],{type:"text/plain;charset=utf-8"}):new Blob([content],{type:"application/octet-stream"});
  form.append("document",blob,filename);
  const r=await fetch(`https://api.telegram.org/bot${token()}/sendDocument`,{method:"POST",body:form,cache:"no-store"});
  const j=await r.json(); if(!j.ok) throw new Error(j.description||`Telegram ${r.status}`); return j.result;
}
function clientFor(n:Network){
  if(n.connection_mode!=="direct"||!n.host||!n.port||!n.username||!n.password_ciphertext) throw new Error("هذه العملية تحتاج Direct API حالياً");
  return new RouterOSClient({host:n.host,port:n.port,username:n.username,password:decryptSecret(n.password_ciphertext),tls:n.protocol==="api-ssl",rejectUnauthorized:n.tls_verify,timeoutMs:25000});
}
async function context(userId:number){
  const u=await dbGet<BotUser>("tg_users",{telegram_user_id:`eq.${userId}`,select:"telegram_user_id,active_network_id",limit:"1"});
  if(!u[0]?.active_network_id) return null;
  const n=await dbGet<Network>("tg_networks",{id:`eq.${u[0].active_network_id}`,telegram_user_id:`eq.${userId}`,select:"*",limit:"1"});
  return n[0]??null;
}
function majorMinor(v?:string|null){ const m=/^(\d+)(?:\.(\d+))?/.exec(v||""); return {major:Number(m?.[1]||0),minor:Number(m?.[2]||0)}; }
function safeName(value:string){ return value.replace(/[^A-Za-z0-9_.-]+/g,"_").slice(0,40)||"MikroTik"; }
function stamp(){ return new Date().toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z"); }
function parseSize(value?:string){
  const s=String(value||"0"); const n=Number.parseFloat(s); if(!Number.isFinite(n)) return 0;
  if(/KiB/i.test(s)) return Math.round(n*1024); if(/MiB/i.test(s)) return Math.round(n*1024*1024); if(/GiB/i.test(s)) return Math.round(n*1024*1024*1024); return Math.round(n);
}
async function rscContent(client:RouterOSClient, filename:string, version?:string|null){
  await client.command("/export",[`=file=${filename.replace(/\.rsc$/i,"")}`]);
  await new Promise((r)=>setTimeout(r,1500));
  const rows=await client.command("/file/print",["=.proplist=.id,name,size,contents",`?name=${filename}`]);
  const row=rows[0]; if(!row) throw new Error("تم تنفيذ export لكن ملف RSC لم يظهر في /file");
  const id=row[".id"]||filename; const size=parseSize(row.size);
  let text=row.contents||"";
  const ver=majorMinor(version);
  if(!text && (ver.major>7 || (ver.major===7 && ver.minor>=13))){
    let offset=0; const parts:string[]=[]; const chunk=32768; const hardLimit=8*1024*1024;
    while(offset<hardLimit){
      const read=await client.command("/file/read",[`=file=${filename}`,`=offset=${offset}`,`=chunk-size=${chunk}`]);
      const data=read[0]?.data||""; if(!data) break; parts.push(data); const used=Buffer.byteLength(data,"utf8"); offset+=used; if(used<chunk) break;
    }
    text=parts.join("");
  }
  try{ await client.command("/file/remove",[`=numbers=${id}`]); }catch{}
  if(!text) {
    if(size>60*1024 && ver.major<7) throw new Error(`تم إنشاء RSC (${row.size||size+" bytes"}) لكن RouterOS ${version||"v6"} لا يسمح بقراءة ملف بهذا الحجم عبر API القديم. الملف حُذف بعد الاختبار ولم تتغير الإعدادات.`);
    throw new Error("تعذر قراءة محتوى ملف RSC عبر API رغم إنشائه");
  }
  return {text,size:size||Buffer.byteLength(text,"utf8")};
}

export async function runRscBackup(chatId:number,userId:number,announce=true){
  const network=await context(userId); if(!network){ await send(chatId,"📭 لا توجد شبكة نشطة."); return false; }
  if(network.connection_mode!=="direct"){
    await send(chatId,"🟠 نسخة RSC كملف Telegram على Agent Mode تحتاج Agent File Transport الجديد. لم أنفذ Backup ناقص أو وهمي. استخدم Direct لهذه العملية حالياً."); return false;
  }
  if(announce) await send(chatId,`🧰 <b>${esc(network.identity||network.label)}</b>\nجاري إنشاء Export RSC وقراءته ثم حذفه من الراوتر بعد الإرسال…`);
  const hist=await dbInsert<{id:string}>("tg_backup_history",{telegram_user_id:userId,network_id:network.id,backup_type:"rsc",status:"started"},"id");
  const client=clientFor(network); const filename=`${safeName(network.identity||network.label)}_${stamp()}.rsc`;
  try{
    const out=await rscContent(client,filename,network.router_os_version);
    const msg=await sendDocument(chatId,filename,out.text,`✅ <b>RSC Backup</b> • ${esc(network.identity||network.label)}\nRouterOS ${esc(network.router_os_version||"-")} • ${(out.size/1024).toFixed(1)} KiB`);
    await dbPatch("tg_backup_history",{router_filename:filename,size_bytes:out.size,status:"sent",telegram_file_id:msg?.document?.file_id||null},{id:`eq.${hist[0]?.id||""}`});
    return true;
  }catch(e){
    await dbPatch("tg_backup_history",{status:"error",error_text:String(e)},{id:`eq.${hist[0]?.id||""}`});
    await send(chatId,`🔴 <b>لم أرسل نسخة ناقصة</b>\n${esc(e instanceof Error?e.message:e)}\n\nيمكنك طلب <code>binary backup</code> للحصول على نسخة System Backup مشفرة عبر MikroTik Cloud إذا كان إصدار الراوتر يدعمها.`); return false;
  }finally{ client.close(); }
}

export async function runBinaryCloudBackup(chatId:number,userId:number,announce=true){
  const network=await context(userId); if(!network){ await send(chatId,"📭 لا توجد شبكة نشطة."); return false; }
  if(network.connection_mode!=="direct"){ await send(chatId,"🟠 Binary Cloud Backup عبر Agent سيتم دعمه بواسطة File Transport؛ لم أنفذ عملية غير مكتملة."); return false; }
  const ver=majorMinor(network.router_os_version); if(ver.major<6 || (ver.major===6&&ver.minor<44)){ await send(chatId,"⚠️ MikroTik Cloud Backup يحتاج RouterOS 6.44+."); return false; }
  const password=randomBytes(18).toString("base64url"); const name=`MTBOT-${safeName(network.identity||network.label)}-${stamp()}`;
  if(announce) await send(chatId,"🔐 جاري إنشاء Binary System Backup مشفر ورفعه إلى MikroTik Cloud…");
  const hist=await dbInsert<{id:string}>("tg_backup_history",{telegram_user_id:userId,network_id:network.id,backup_type:"cloud-binary",status:"started"},"id");
  const client=clientFor(network);
  try{
    await client.command("/system/backup/cloud/upload-file",["=action=create-and-upload",`=name=${name}`,`=password=${password}`]);
    const rows=await client.command("/system/backup/cloud/print",["=.proplist=name,size,ros-version,date,status,secret-download-key"]);
    const row=rows.find((r)=>r.name===name)||rows[0]; if(!row||row.status!=="ok") throw new Error(row?.status||"Cloud backup was not confirmed");
    await dbPatch("tg_backup_history",{cloud_backup_name:row.name||name,cloud_secret_key:row["secret-download-key"]||null,status:"sent",size_bytes:parseSize(row.size)},{id:`eq.${hist[0]?.id||""}`});
    await send(chatId,`✅ <b>Binary Backup محفوظ ومشفر</b>\n━━━━━━━━━━━━━━━━━━\n📡 ${esc(network.identity||network.label)}\n📦 ${esc(row.size||"-")}\n🧩 ROS ${esc(row["ros-version"]||network.router_os_version||"-")}\n\n🔑 <b>Backup password</b>\n<code>${esc(password)}</code>\n\n🔐 <b>Secret download key</b>\n<code>${esc(row["secret-download-key"]||"-")}</code>\n\nاحتفظ بهما بأمان. الـBinary Backup حساس ويُفضّل استعادته على نفس الجهاز ونفس RouterOS.`);
    return true;
  }catch(e){
    await dbPatch("tg_backup_history",{status:"error",error_text:String(e)},{id:`eq.${hist[0]?.id||""}`});
    await send(chatId,`🔴 تعذر إنشاء Binary Cloud Backup.\n${esc(e instanceof Error?e.message:e)}\nلن أحذف أو أستبدل أي Cloud Backup موجود من نفسي.`); return false;
  }finally{ client.close(); }
}

export async function handleTelegramBackup(update:TgUpdate, forced?:"rsc"|"binary"){
  const m=update.message; if(!m?.from||!m.text) return false;
  const text=m.text.trim(); let type=forced;
  if(!type){ if(/(?:binary|باينري|ثنائي|\.backup|system backup)/i.test(text)) type="binary"; else type="rsc"; }
  return type==="binary"?runBinaryCloudBackup(m.chat.id,m.from.id):runRscBackup(m.chat.id,m.from.id);
}
