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
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    cache: "no-store",
  });
  const json = await response.json();
  if (!json.ok) throw new Error(json.description || `Telegram ${response.status}`);
}

function withText(update: TgUpdate, text: string): TgUpdate {
  if (!update.message) return update;
  return { ...update, message: { ...update.message, text } };
}

export async function handleTelegramCommandRouter(update: TgUpdate): Promise<boolean> {
  const message = update.message;
  if (!message?.text || !message.from) return false;
  const text = message.text.trim();
  if (!text.startsWith("/")) return false;

  const command = text.split(/\s+/)[0].replace(/@\w+$/i, "").toLowerCase();
  const rest = text.slice(text.split(/\s+/)[0].length).trim();

  const aliases: Record<string, string> = {
    "/home": "/help",
    "/menu": "/help",
    "/commands": "/help",
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
    if (target === "/help") return handleTelegramExtra(withText(update, target));
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
