import { dbGet } from "./telegram-db";
import { handleTelegramOps, type OpsKind } from "./telegram-ops";
import type { TgUpdate } from "./telegram-extra";

type BotUser={telegram_user_id:number;active_network_id?:string|null};
type Network={id:string;telegram_user_id:number;label:string;identity?:string|null;connection_mode:"direct"|"agent";agent_version?:number|null};
const V4_ONLY=new Set<OpsKind>(["wan","routes","dns","firewall","queues"]);
function token(){const v=process.env.TELEGRAM_BOT_TOKEN;if(!v)throw new Error("TELEGRAM_BOT_TOKEN missing");return v;}
function esc(v:unknown){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");}
async function send(chatId:number,text:string){const r=await fetch(`https://api.telegram.org/bot${token()}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text,parse_mode:"HTML"}),cache:"no-store"});const j=await r.json();if(!j.ok)throw new Error(j.description||`Telegram ${r.status}`);}
async function active(uid:number){const u=(await dbGet<BotUser>("tg_users",{telegram_user_id:`eq.${uid}`,select:"telegram_user_id,active_network_id",limit:"1"}))[0];if(!u?.active_network_id)return null;return(await dbGet<Network>("tg_networks",{id:`eq.${u.active_network_id}`,telegram_user_id:`eq.${uid}`,select:"id,telegram_user_id,label,identity,connection_mode,agent_version",limit:"1"}))[0]??null;}

export async function handleTelegramOpsUniversal(update:TgUpdate,kind:OpsKind):Promise<boolean>{const m=update.message;if(!m?.from)return false;if(!V4_ONLY.has(kind))return handleTelegramOps(update,kind);const n=await active(m.from.id);if(!n)return handleTelegramOps(update,kind);if(n.connection_mode==="agent"&&Number(n.agent_version||0)<4){await send(m.chat.id,`⬆️ <b>${esc(n.identity||n.label)} يحتاج تحديث Agent</b>\n━━━━━━━━━━━━━━━━━━\nهذه القراءة تحتاج Agent v4. الشبكة نفسها ما زالت متصلة، ولن أرسل أمرًا لا يفهمه Agent القديم.\n\nأرسل <code>/agentupdate</code> وسأعطيك سطر تحديث واحد فقط.`);return true;}return handleTelegramOps(update,kind);}
