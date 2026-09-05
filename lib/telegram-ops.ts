import { decryptSecret } from "./telegram-crypto";
import { dbGet } from "./telegram-db";
import { RouterOSClient } from "./routeros-api";
import type { TgUpdate } from "./telegram-extra";

type User={telegram_user_id:number;active_network_id?:string|null};
type Network={id:string;telegram_user_id:number;label:string;connection_mode:"direct"|"agent";host?:string|null;port?:number|null;username?:string|null;password_ciphertext?:string|null;protocol:"api"|"api-ssl";tls_verify:boolean;identity?:string|null;router_os_version?:string|null};
type UsageRow={user:string;address:string;server:string;total:number};
function token(){const v=process.env.TELEGRAM_BOT_TOKEN;if(!v)throw new Error("TELEGRAM_BOT_TOKEN missing");return v;}
function esc(v:unknown){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");}
async function send(chatId:number,text:string){const r=await fetch(`https://api.telegram.org/bot${token()}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text:text.slice(0,4000),parse_mode:"HTML"}),cache:"no-store"});const j=await r.json();if(!j.ok)throw new Error(j.description||`Telegram ${r.status}`);}
async function context(uid:number){const u=await dbGet<User>("tg_users",{telegram_user_id:`eq.${uid}`,select:"telegram_user_id,active_network_id",limit:"1"});if(!u[0]?.active_network_id)return null;const n=await dbGet<Network>("tg_networks",{id:`eq.${u[0].active_network_id}`,telegram_user_id:`eq.${uid}`,select:"*",limit:"1"});return n[0]??null;}
function client(n:Network){if(n.connection_mode!=="direct"||!n.host||!n.port||!n.username||!n.password_ciphertext)throw new Error("هذه القراءة تحتاج Agent Operations v2 على الشبكات بدون Cloud؛ الاتصال المباشر يدعمها الآن.");return new RouterOSClient({host:n.host,port:n.port,username:n.username,password:decryptSecret(n.password_ciphertext),tls:n.protocol==="api-ssl",rejectUnauthorized:n.tls_verify,timeoutMs:16000});}
function bytes(n:number){if(n<1024)return `${n} B`;if(n<1024**2)return `${(n/1024).toFixed(1)} KB`;if(n<1024**3)return `${(n/1024**2).toFixed(1)} MB`;return `${(n/1024**3).toFixed(2)} GB`;}
function num(v:unknown){const n=Number(v||0);return Number.isFinite(n)?n:0;}

export async function handleTelegramOps(update:TgUpdate,kind:"logs"|"interfaces"|"dhcp"|"hotspot"|"top_usage"){
  const m=update.message;if(!m?.from)return false;const n=await context(m.from.id);if(!n){await send(m.chat.id,"📭 لا توجد شبكة نشطة.");return true;}
  if(n.connection_mode!=="direct"){await send(m.chat.id,"🟠 هذه العملية موجودة في Direct الآن، وسيتم تمريرها عبر Agent Operations v2 للشبكات خلف CGNAT. لم أعطك بيانات تخمينية.");return true;}
  const c=client(n);
  try{
    if(kind==="logs"){
      const rows=await c.command("/log/print",["=.proplist=time,topics,message"]);const last=rows.slice(-25).reverse();
      const lines=last.map((r,i)=>`${i+1}. <b>${esc(r.time||"-")}</b> • ${esc(r.topics||"-")}\n${esc(r.message||"-")}`);
      await send(m.chat.id,`🧾 <b>${esc(n.identity||n.label)} • آخر السجلات</b>\n━━━━━━━━━━━━━━━━━━\n${lines.join("\n\n")||"لا توجد سجلات."}`);return true;
    }
    if(kind==="interfaces"){
      const rows=await c.command("/interface/print",["=.proplist=name,type,running,disabled,actual-mtu"]);const running=rows.filter(r=>r.running==="true"&&r.disabled!=="true").length;
      const lines=rows.slice(0,60).map(r=>`${r.disabled==="true"?"⛔":r.running==="true"?"🟢":"⚪"} <b>${esc(r.name||"-")}</b> • ${esc(r.type||"-")} • MTU ${esc(r["actual-mtu"]||"-")}`);
      await send(m.chat.id,`🔌 <b>واجهات الراوتر</b>\n━━━━━━━━━━━━━━━━━━\nالإجمالي: <b>${rows.length}</b> • Running: <b>${running}</b>\n\n${lines.join("\n")}${rows.length>60?`\n… +${rows.length-60}`:""}`);return true;
    }
    if(kind==="dhcp"){
      const rows=await c.command("/ip/dhcp-server/lease/print",["=.proplist=address,mac-address,host-name,status,last-seen,server,disabled"]);const bound=rows.filter(r=>r.status==="bound").length;
      const lines=rows.filter(r=>r.status==="bound").slice(0,50).map((r,i)=>`${i+1}. ${esc(r.address||"-")} • <code>${esc(r["mac-address"]||"-")}</code>${r["host-name"]?` • ${esc(r["host-name"])}`:""}`);
      await send(m.chat.id,`📬 <b>DHCP Leases</b>\n━━━━━━━━━━━━━━━━━━\n🟢 Bound: <b>${bound}</b> / ${rows.length}\n\n${lines.join("\n")||"لا توجد leases مرتبطة الآن."}`);return true;
    }
    if(kind==="hotspot"){
      const [servers,active,users]=await Promise.all([c.command("/ip/hotspot/print",["=.proplist=name,interface,disabled,profile"]),c.command("/ip/hotspot/active/print",["=.proplist=user,address,server,uptime"]),c.command("/ip/hotspot/user/print",["=.proplist=name,profile,disabled"])]);
      await send(m.chat.id,`📡 <b>Hotspot Overview</b>\n━━━━━━━━━━━━━━━━━━\n🧩 Servers: <b>${servers.length}</b>\n👥 Active: <b>${active.length}</b>\n🎫 Local users: <b>${users.length}</b>\n🚫 Disabled users: <b>${users.filter(x=>x.disabled==="true").length}</b>\n\n${servers.slice(0,20).map(s=>`• ${s.disabled==="true"?"⛔":"🟢"} <b>${esc(s.name||"-")}</b> • ${esc(s.interface||"-")}`).join("\n")}`);return true;
    }
    const rows=await c.command("/ip/hotspot/active/print",["=.proplist=user,address,server,uptime,bytes-in,bytes-out"]);
    const ranked:UsageRow[]=rows.map((r):UsageRow=>({user:r.user||"-",address:r.address||"-",server:r.server||"-",total:num(r["bytes-in"])+num(r["bytes-out"])})).sort((a,b)=>b.total-a.total).slice(0,20);
    await send(m.chat.id,`🏆 <b>أعلى المتصلين استهلاكًا في الجلسة الحالية</b>\n━━━━━━━━━━━━━━━━━━\n${ranked.map((r,i)=>`${i+1}. <code>${esc(r.user)}</code> • <b>${bytes(r.total)}</b>\n   ${esc(r.address)} • ${esc(r.server)}`).join("\n\n")||"لا يوجد مستخدمون متصلون."}`);return true;
  }catch(e){await send(m.chat.id,`🔴 تعذر تنفيذ القراءة.\n<code>${esc(e instanceof Error?e.message:e)}</code>`);return true;}finally{c.close();}
}
