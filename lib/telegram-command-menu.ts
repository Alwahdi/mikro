import type { TgUpdate } from "./telegram-extra";

function token(){const v=process.env.TELEGRAM_BOT_TOKEN;if(!v)throw new Error("TELEGRAM_BOT_TOKEN missing");return v;}

const commands=[
  {command:"start",description:"القائمة الرئيسية وبدء البوت"},
  {command:"help",description:"كل ما يستطيع البوت عمله"},
  {command:"status",description:"حالة الشبكة والراوتر"},
  {command:"diagnose",description:"فحص وتشخيص الشبكة"},
  {command:"online",description:"المستخدمون المتصلون الآن"},
  {command:"users",description:"البحث عن مستخدم أو كرت"},
  {command:"card",description:"فحص كرت وجلساته بالتفصيل"},
  {command:"renew",description:"تجديد كرت User Manager"},
  {command:"sales",description:"مبيعات اليوم حسب أول استخدام"},
  {command:"batchcards",description:"إنشاء دفعة كروت جديدة"},
  {command:"batches",description:"دفعات الكروت السابقة"},
  {command:"printcards",description:"تجهيز كروت A4 PDF للطباعة"},
  {command:"vlans",description:"عرض VLANs"},
  {command:"vlan",description:"فحص VLAN محددة"},
  {command:"ping",description:"اختبار Ping"},
  {command:"router",description:"معلومات وموارد الراوتر"},
  {command:"wan",description:"حالة WAN والبوابات"},
  {command:"dns",description:"حالة DNS والـResolve"},
  {command:"firewall",description:"ملخص Firewall آمن"},
  {command:"queues",description:"Queues وQoS"},
  {command:"logs",description:"آخر Logs وأخطاء الراوتر"},
  {command:"alerts",description:"إدارة التنبيهات الذكية"},
  {command:"backup",description:"RSC أو Binary Backup"},
  {command:"schedules",description:"المهام المجدولة"},
  {command:"networks",description:"الشبكات المرتبطة"},
  {command:"add",description:"إضافة شبكة MikroTik"},
  {command:"cancel",description:"إلغاء العملية الحالية"},
];

async function sync(){const r=await fetch(`https://api.telegram.org/bot${token()}/setMyCommands`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({commands}),cache:"no-store"});if(!r.ok)return;const j=await r.json();if(!j.ok)console.warn("setMyCommands failed",j.description);}

export async function syncTelegramCommandMenuOnStart(update:TgUpdate):Promise<boolean>{const text=update.message?.text?.trim()||"";if(!/^\/start(?:@\w+)?(?:\s|$)/i.test(text))return false;try{await sync();}catch(e){console.warn("command menu sync failed",e);}return false;}
