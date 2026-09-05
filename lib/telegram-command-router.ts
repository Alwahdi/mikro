import { handleTelegramCardUniversal } from "./telegram-card-universal";
import { handleTelegramExtra, type TgUpdate } from "./telegram-extra";
import { handleTelegramSales } from "./telegram-sales";
import { handleTelegramUpdate } from "./telegram-bot";

function token() {
  const value = process.env.TELEGRAM_BOT_TOKEN;
  if (!value) throw new Error("TELEGRAM_BOT_TOKEN is missing");
  return value;
}

async function send(chatId: number, text: string) {
  const response = await fetch(`https://api.telegram.org/bot${token()}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    cache: "no-store",
  });
  const json = await response.json();
  if (!json.ok) throw new Error(json.description || `Telegram ${response.status}`);
}

function withText(update: TgUpdate, text: string): TgUpdate {
  if (!update.message) return update;
  return { ...update, message: { ...update.message, text } };
}

function helpText() {
  return `🤖 <b>MikroTik Network Bot</b>\n━━━━━━━━━━━━━━━━━━\nاكتب بطريقتك العادية، ما تحتاج تحفظ الأوامر.\n\n<b>أمثلة طبيعية:</b>\n• كم واحد متصل الآن؟\n• افحص الكرت 15352951\n• كم مبيعات اليوم؟\n• شوف VLAN 202\n• ليش النت بطيء؟\n• وش معلومات الراوتر؟\n• اعرض شبكاتي ثم استخدم الثانية\n\n<b>الأوامر الأساسية:</b>\n/status — حالة الشبكة\n/diagnose — فحص حالة + Ping\n/online — المتصلون الآن\n/card 15352951 — فحص كرت وجلساته\n/sales — مبيعات اليوم\n/ping — اختبار الإنترنت\n/vlans — VLANs المفعلة\n/vlan 202 — تفاصيل VLAN\n/router — معلومات الراوتر\n/networks — شبكاتي\n/use 2 — تغيير الشبكة\n/add — إضافة شبكة\n/cancel — إلغاء الإعداد\n\n✅ يفهم العربية واللهجات والإنجليزية والأخطاء البسيطة بدون AI.`;
}

export async function handleTelegramCommandRouter(update: TgUpdate): Promise<boolean> {
  const message = update.message;
  if (!message?.text || !message.from) return false;
  const text = message.text.trim();
  if (!text.startsWith("/")) return false;

  const first = text.split(/\s+/)[0];
  const command = first.replace(/@\w+$/i, "").toLowerCase();
  const rest = text.slice(first.length).trim();

  if (["/help", "/home", "/menu", "/commands"].includes(command)) {
    await send(message.chat.id, helpText());
    return true;
  }

  const aliases: Record<string, string> = {
    "/health": "/status",
    "/network": "/status",
    "/users": "/online",
    "/active": "/online",
    "/clients": "/online",
    "/sale": "/sales",
    "/today": "/sales",
    "/vlanlist": "/vlans",
    "/vlanslist": "/vlans",
    "/device": "/router",
    "/version": "/router",
    "/test": "/ping",
    "/internet": "/ping",
  };

  if (aliases[command]) {
    const target = aliases[command] + (rest ? ` ${rest}` : "");
    if (target === "/online") return handleTelegramExtra(withText(update, target));
    if (target === "/vlans") return handleTelegramExtra(withText(update, target));
    if (target === "/router") return handleTelegramExtra(withText(update, target));
    if (target === "/sales") return handleTelegramSales(withText(update, target));
    await handleTelegramUpdate(withText(update, target));
    return true;
  }

  if (command === "/diagnose" || command === "/check") {
    await send(message.chat.id, "🔎 <b>فحص الشبكة</b>\nسأقرأ الحالة العامة ثم أختبر الاتصال. لن أغيّر أي إعداد.");
    await handleTelegramUpdate(withText(update, "/status"));
    await handleTelegramUpdate(withText(update, "/ping"));
    return true;
  }

  if (command === "/card" && !rest) {
    await send(
      message.chat.id,
      "🎫 <b>فحص كرت</b>\nأرسل الأمر مع رقم الكرت، مثلاً:\n<code>/card 15352951</code>\n\nأو اكتب طبيعي: «افحص لي الكرت 15352951».",
    );
    return true;
  }

  if (command === "/card" && rest) {
    return handleTelegramCardUniversal(withText(update, `/card ${rest.split(/\s+/)[0]}`));
  }

  return false;
}
