import { handleTelegramBackup } from "./telegram-backup";
import { handleTelegramCardUniversal } from "./telegram-card-universal";
import { handleTelegramExtra, type TgUpdate } from "./telegram-extra";
import { handleTelegramOps } from "./telegram-ops";
import { handleTelegramSales } from "./telegram-sales";
import { showScheduledTasks } from "./telegram-scheduler";
import { handleTelegramUpdate } from "./telegram-bot";

function token(){const value=process.env.TELEGRAM_BOT_TOKEN;if(!value)throw new Error("TELEGRAM_BOT_TOKEN is missing");return value;}
async function send(chatId:number,text:string){const response=await fetch(`https://api.telegram.org/bot${token()}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text,parse_mode:"HTML",disable_web_page_preview:true}),cache:"no-store"});const json=await response.json();if(!json.ok)throw new Error(json.description||`Telegram ${response.status}`);}
function withText(update:TgUpdate,text:string):TgUpdate{if(!update.message)return update;return {...update,message:{...update.message,text}};}
function helpText(){return `🧠 <b>MikroTik Operations Assistant</b>\n━━━━━━━━━━━━━━━━━━\nاكتب بطريقتك العادية؛ الأوامر اختيارية.\n\n<b>أمثلة:</b>\n• كم واحد متصل الآن؟\n• افحص الكرت <code>AB-12_X</code> وجيب جلساته\n• مين أكثر واحد يستهلك؟\n• جيب آخر أخطاء الراوتر\n• خذ لي نسخة RSC وارسلها\n• سوي Binary Backup مشفر\n• كل يوم الساعة 3 الفجر خذ نسخة RSC\n• كل 6 ساعات ارسل تقرير الحالة\n\n<b>المراقبة:</b>\n/status • /diagnose • /online • /sales • /ping\n/vlans • /vlan 202 • /router • /logs • /interfaces\n/dhcp • /hotspot • /top\n\n<b>النسخ والأتمتة:</b>\n/backup rsc — Export وإرساله كملف\n/backup binary — System Backup مشفر\n/schedules — المهام المجدولة\n\n<b>الشبكات:</b>\n/networks • /use 2 • /add • /cancel\n\n✅ أسماء الكروت يمكن أن تكون أرقامًا أو حروفًا أو رموزًا مثل <code>user-A_19</code>.`}

export async function handleTelegramCommandRouter(update:TgUpdate):Promise<boolean>{
  const message=update.message;if(!message?.text||!message.from)return false;const text=message.text.trim();if(!text.startsWith("/"))return false;
  const first=text.split(/\s+/)[0];const command=first.replace(/@\w+$/i,"").toLowerCase();const rest=text.slice(first.length).trim();
  if(["/help","/home","/menu","/commands"].includes(command)){await send(message.chat.id,helpText());return true;}
  const aliases:Record<string,string>={"/health":"/status","/network":"/status","/users":"/online","/active":"/online","/clients":"/online","/sale":"/sales","/today":"/sales","/vlanlist":"/vlans","/vlanslist":"/vlans","/device":"/router","/version":"/router","/test":"/ping","/internet":"/ping","/errors":"/logs","/leases":"/dhcp","/usage":"/top","/jobs":"/schedules"};
  if(aliases[command])return handleTelegramCommandRouter(withText(update,aliases[command]+(rest?` ${rest}`:"")));
  if(command==="/diagnose"||command==="/check"){await send(message.chat.id,"🔎 <b>فحص الشبكة</b>\nسأقرأ الحالة العامة وأختبر الإنترنت. لن أغيّر أي إعداد.");await handleTelegramUpdate(withText(update,"/status"));await handleTelegramUpdate(withText(update,"/ping"));return true;}
  if(command==="/card"){
    if(!rest){await send(message.chat.id,"🎫 <b>فحص كرت/يوزر</b>\nمثال أرقام: <code>/card 15352951</code>\nمثال حروف: <code>/card AB-12_X</code>\nأو اكتب: «افحص اليوزر abdullah بالكامل». ");return true;}
    return handleTelegramCardUniversal(withText(update,`/card ${rest.split(/\s+/)[0]}`));
  }
  if(command==="/backup"){
    if(!rest){await send(message.chat.id,"🧰 اختر النوع بكتابة:\n<code>/backup rsc</code> — ملف إعدادات نصي قابل للقراءة\n<code>/backup binary</code> — System Backup مشفر");return true;}
    return handleTelegramBackup(withText(update,`/backup ${rest}`),/(?:binary|bin|backup)/i.test(rest)&&!/rsc/i.test(rest)?"binary":"rsc");
  }
  if(command==="/schedules")return showScheduledTasks(update);
  if(command==="/logs")return handleTelegramOps(update,"logs");
  if(command==="/interfaces")return handleTelegramOps(update,"interfaces");
  if(command==="/dhcp")return handleTelegramOps(update,"dhcp");
  if(command==="/hotspot")return handleTelegramOps(update,"hotspot");
  if(command==="/top")return handleTelegramOps(update,"top_usage");
  if(command==="/online")return handleTelegramExtra(update);
  if(command==="/vlans")return handleTelegramExtra(update);
  if(command==="/router")return handleTelegramExtra(update);
  if(command==="/sales")return handleTelegramSales(update);
  return false;
}
