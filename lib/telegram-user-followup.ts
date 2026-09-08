import { dbGet, dbUpsert } from "./telegram-db";
import { normalizeLocalText } from "./telegram-nlu-v2";
import { handleTelegramCardUniversal } from "./telegram-card-universal";
import { handleTelegramAgentPrivileged } from "./telegram-agent-privileged";
import { handlePrivilegedNatural } from "./telegram-privileged";
import { handleTelegramAgentUserAdmin } from "./telegram-agent-user-admin";
import { handleTelegramUserAdmin } from "./telegram-user-admin";
import { handleTelegramUserRenew } from "./telegram-user-renew";
import type { TgUpdate } from "./telegram-extra";

type SearchItem={username:string;source?:string;profile?:string;disabled?:boolean};
type Context={telegram_user_id:number;network_id?:string|null;last_intent?:string|null;last_entity_type?:string|null;last_entity_value?:string|null;last_command?:string|null;metadata?:{user_search_results?:SearchItem[];user_search_at?:string;[k:string]:unknown}|null;updated_at?:string|null};
type BotUser={telegram_user_id:number;active_network_id?:string|null};

type FollowAction="inspect"|"disconnect"|"disable"|"enable"|"profile"|"password"|"renew"|"delete";

const ordinalGroups:Array<[number,string[]]>=[
  [1,["الاول","الأول","اول","أول","الاولى","الأولى","اولي","أولى","first"]],
  [2,["الثاني","الثانى","الثانيه","الثانية","ثاني","second"]],
  [3,["الثالث","الثالثه","الثالثة","ثالث","third"]],
  [4,["الرابع","الرابعه","الرابعة","رابع","fourth"]],
  [5,["الخامس","الخامسه","الخامسة","خامس","fifth"]],
  [6,["السادس","السادسه","السادسة","سادس","sixth"]],
  [7,["السابع","السابعه","السابعة","سابع","seventh"]],
  [8,["الثامن","الثامنه","الثامنة","ثامن","eighth"]],
  [9,["التاسع","التاسعه","التاسعة","تاسع","ninth"]],
  [10,["العاشر","العاشره","العاشرة","عاشر","tenth"]],
];

function token(){const v=process.env.TELEGRAM_BOT_TOKEN;if(!v)throw new Error("TELEGRAM_BOT_TOKEN missing");return v;}
function esc(v:unknown){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");}
async function send(chatId:number,text:string){const r=await fetch(`https://api.telegram.org/bot${token()}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text,parse_mode:"HTML",disable_web_page_preview:true}),cache:"no-store"});const j=await r.json();if(!j.ok)throw new Error(j.description||`Telegram ${r.status}`);}
function withText(update:TgUpdate,text:string):TgUpdate{return{...update,message:update.message?{...update.message,text}:update.message};}
function ordinalIndex(raw:string){const n=normalizeLocalText(raw);const tokens=n.split(/\s+/).filter(Boolean);for(const [index,words] of ordinalGroups){if(words.some(w=>tokens.includes(normalizeLocalText(w))))return index;}const explicit=n.match(/(?:رقم|النتيجه|النتيجة|المستخدم|user|result|number|#)\s*#?\s*(\d{1,2})(?:\s|$)/i);if(explicit){const v=Number(explicit[1]);return v>=1&&v<=30?v:null;}const short=n.match(/^(?:افحص|شوف|شيك|راجع|افصل|عطل|وقف|شغل|فعل|جدد|احذف|امسح|delete|inspect|check|disable|enable|disconnect|renew)\s+(\d{1,2})$/i);if(short){const v=Number(short[1]);return v>=1&&v<=30?v:null;}return null;}
function action(raw:string):FollowAction|null{const n=normalizeLocalText(raw);if(/(?:احذف|امسح|شيل|ازل|delete|remove)/i.test(n))return"delete";if(/(?:جدد|تجديد|renew|renewal|reactivate|اعاده تفعيل|اعادة تفعيل)/i.test(n))return"renew";if(/(?:كلمه المرور|كلمة المرور|باسورد|password|passwd|pass)/i.test(n)&&/(?:غير|بدل|reset|change)/i.test(n))return"password";if(/(?:الباقه|الباقة|بروفايل|profile|plan)/i.test(n)&&/(?:غير|بدل|حول|حوّل|change|switch)/i.test(n))return"profile";if(/(?:افصل|اطرد|طلع|اخرج|disconnect|kick|logout)/i.test(n))return"disconnect";if(/(?:عطل|وقف|امنع|احظر|بلك|disable|block)/i.test(n))return"disable";if(/(?:شغل|فعل|رجع|افتح|فك الحظر|enable|unblock)/i.test(n))return"enable";if(/(?:افحص|شوف|شيك|راجع|تفاصيل|افتح|inspect|check|details|show)/i.test(n))return"inspect";return null;}
function profileHint(raw:string){return raw.match(/(?:الباقه|الباقة|باقة|باقه|بروفايل|profile|plan)?\s*(?:الى|إلى|الي|to)\s*[:#-]?\s*([\p{L}\p{N}_.@:+-]{1,128})/iu)?.[1]||null;}
async function context(uid:number){return(await dbGet<Context>("tg_nlu_context",{telegram_user_id:`eq.${uid}`,select:"*",limit:"1"}))[0]??null;}
async function activeNetworkId(uid:number){return(await dbGet<BotUser>("tg_users",{telegram_user_id:`eq.${uid}`,select:"telegram_user_id,active_network_id",limit:"1"}))[0]?.active_network_id||null;}
async function rememberChoice(uid:number,ctx:Context,item:SearchItem){await dbUpsert("tg_nlu_context",{telegram_user_id:uid,network_id:ctx.network_id||null,last_intent:"card",last_entity_type:"card",last_entity_value:item.username,last_command:`search-choice:${item.username}`,metadata:{...(ctx.metadata||{}),selected_search_user:item.username,selected_search_at:new Date().toISOString()},updated_at:new Date().toISOString()},"telegram_user_id");}

export async function handleTelegramUserFollowup(update:TgUpdate):Promise<boolean>{const m=update.message;if(!m?.from||!m.text||m.text.trim().startsWith("/"))return false;const index=ordinalIndex(m.text);if(!index)return false;const ctx=await context(m.from.id);const rows=Array.isArray(ctx?.metadata?.user_search_results)?ctx!.metadata!.user_search_results!:[];if(!rows.length||ctx?.last_intent!=="users")return false;const at=Date.parse(String(ctx?.metadata?.user_search_at||ctx?.updated_at||""));if(!Number.isFinite(at)||Date.now()-at>30*60_000){await send(m.chat.id,"⌛ قائمة البحث السابقة قديمة. ابحث عن المستخدم من جديد حتى لا أنفذ على اسم غير مقصود.");return true;}const active=await activeNetworkId(m.from.id);if(!active||!ctx?.network_id||active!==ctx.network_id){await send(m.chat.id,"🔒 غيرت الشبكة منذ آخر بحث. أعد البحث في الشبكة الحالية قبل استخدام «الأول/الثاني».");return true;}const item=rows[index-1];if(!item?.username){await send(m.chat.id,`ℹ️ القائمة السابقة فيها <b>${rows.length}</b> نتيجة فقط، وما في نتيجة رقم <b>${index}</b>.`);return true;}const act=action(m.text)||"inspect";await rememberChoice(m.from.id,ctx,item);
  if(act==="inspect")return handleTelegramCardUniversal(withText(update,`/card ${item.username}`));
  if(act==="renew"){const p=profileHint(m.text);return handleTelegramUserRenew(withText(update,p?`جدد الكرت ${item.username} باقة ${p}`:`جدد الكرت ${item.username}`));}
  if(act==="disconnect"||act==="disable"||act==="enable"){const verb=act==="disconnect"?"افصل":act==="disable"?"عطل":"شغل";const rewritten=withText(update,`${verb} المستخدم ${item.username}`);if(await handleTelegramAgentPrivileged(rewritten))return true;return handlePrivilegedNatural(rewritten);}
  if(act==="profile"){const p=profileHint(m.text);const text=p?`غير الباقة للمستخدم ${item.username} الى ${p}`:`غير الباقة للمستخدم ${item.username}`;const rewritten=withText(update,text);if(await handleTelegramAgentUserAdmin(rewritten))return true;return handleTelegramUserAdmin(rewritten);}
  if(act==="password"){const rewritten=withText(update,`غير كلمة المرور للمستخدم ${item.username}`);if(await handleTelegramAgentUserAdmin(rewritten))return true;return handleTelegramUserAdmin(rewritten);}
  const rewritten=withText(update,`احذف المستخدم ${item.username}`);if(await handleTelegramAgentUserAdmin(rewritten))return true;return handleTelegramUserAdmin(rewritten);
}
