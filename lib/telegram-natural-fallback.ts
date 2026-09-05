import { handleTelegramCardUniversal } from "./telegram-card-universal";
import { handleTelegramExtra, type TgUpdate } from "./telegram-extra";
import { handleTelegramSales } from "./telegram-sales";
import { handleTelegramUpdate } from "./telegram-bot";

function normalized(value: string) {
  return value
    .toLowerCase()
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[ًٌٍَُِّْـ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function withText(update: TgUpdate, text: string): TgUpdate {
  if (!update.message) return update;
  return { ...update, message: { ...update.message, text } };
}

function firstLargeNumber(text: string) {
  return text.match(/\b\d{5,20}\b/g)?.[0] || null;
}

function vlanNumber(text: string) {
  const patterns = [
    /(?:vlan|في?لان|فيلان|فلان)\s*#?\s*(\d{1,4})/i,
    /(?:شبكه|شبكة)\s+(\d{1,4})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const value = Number(match[1]);
    if (value >= 1 && value <= 4094) return value;
  }
  return null;
}

function includesAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
}

export async function handleTelegramNaturalFallback(update: TgUpdate): Promise<boolean> {
  const message = update.message;
  if (!message?.text || !message.from) return false;
  const raw = message.text.trim();
  if (!raw || raw.startsWith("/")) return false;
  const text = normalized(raw);

  const card = firstLargeNumber(raw);
  if (
    card &&
    includesAny(text, [
      "كرت", "بطاق", "يوزر", "مستخدم", "مشترك", "افحص", "شيك", "شوف", "جلس", "استهلاك",
      "card", "voucher", "user", "session", "check", "inspect", "history",
    ])
  ) {
    return handleTelegramCardUniversal(withText(update, `/card ${card}`));
  }

  const asksOnline =
    (includesAny(text, ["كم", "كام", "عدد", "how many", "who", "مين", "من هم"]) &&
      includesAny(text, ["مستخدم", "متصل", "اونلاين", "online", "user", "مشترك", "ناس", "داخل"])) ||
    includesAny(text, ["المتصلين الان", "المتصلون الان", "online users", "active users", "مين داخل"]);
  if (asksOnline) return handleTelegramExtra(withText(update, "/online"));

  if (
    includesAny(text, [
      "مبيعات اليوم", "المبيعات اليوم", "كم بعنا", "كم مبيعات", "كروت جديد", "اول دخول", "أول دخول",
      "sales today", "today sales", "new cards", "first login",
    ])
  ) {
    return handleTelegramSales(withText(update, "/sales"));
  }

  const vlan = vlanNumber(raw);
  if (vlan !== null) return handleTelegramExtra(withText(update, `/vlan ${vlan}`));
  if (includesAny(text, ["الفيلانات", "فيلانات", "vlans", "vlan list", "قائمه vlan", "قائمة vlan"])) {
    return handleTelegramExtra(withText(update, "/vlans"));
  }

  if (
    includesAny(text, [
      "اصدار الراوتر", "اصدار المايكروتك", "معلومات الراوتر", "موديل الراوتر", "نوع الراوتر",
      "router version", "router info", "router model", "routeros version", "مايكروتك اصدار",
    ])
  ) {
    return handleTelegramExtra(withText(update, "/router"));
  }

  if (
    includesAny(text, [
      "بنج", "ping", "اختبر النت", "اختبار النت", "افحص النت", "فحص الانترنت", "فحص الإنترنت",
      "test internet", "internet test", "packet loss",
    ])
  ) {
    await handleTelegramUpdate(withText(update, "/ping"));
    return true;
  }

  if (
    includesAny(text, [
      "حاله الشبكه", "حالة الشبكة", "وضع الشبكه", "وضع الشبكة", "كيف الشبكه", "كيف الشبكة",
      "النت شغال", "الانترنت شغال", "حاله النت", "status", "network status", "network health",
    ])
  ) {
    await handleTelegramUpdate(withText(update, "/status"));
    return true;
  }

  if (
    includesAny(text, [
      "النت بطي", "الشبكه بطي", "الشبكة بطي", "تقطيع", "يقطع", "متقطع", "slow internet",
      "network slow", "disconnect", "unstable", "lag", "بنق عالي", "ping عالي",
    ])
  ) {
    await handleTelegramUpdate(withText(update, "/status"));
    return true;
  }

  return false;
}
