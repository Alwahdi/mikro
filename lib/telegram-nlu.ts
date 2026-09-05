export type LocalIntent =
  | "card"
  | "online"
  | "sales"
  | "vlan_detail"
  | "vlans"
  | "router"
  | "ping"
  | "status"
  | "diagnose"
  | "networks"
  | "use_network"
  | "add_network"
  | "cancel"
  | "help"
  | "greeting"
  | "thanks"
  | "unknown";

export type LocalNluContext = {
  last_intent?: string | null;
  last_entity_type?: string | null;
  last_entity_value?: string | null;
  updated_at?: string | null;
};

export type LocalNluResult = {
  intent: LocalIntent;
  confidence: number;
  normalized: string;
  entities: {
    card?: string;
    vlan_id?: number;
    network_index?: number;
    network_name?: string;
    ping_host?: string;
  };
  reason: string;
};

const ARABIC_DIGITS: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};

export function normalizeLocalText(value: string) {
  return value
    .split("")
    .map((char) => ARABIC_DIGITS[char] ?? char)
    .join("")
    .toLowerCase()
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[ًٌٍَُِّْـ]/g, "")
    .replace(/[؟?!،,;؛()[\]{}"'`~_*+=\\/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(value: string) {
  return normalizeLocalText(value)
    .split(/\s+/)
    .filter(Boolean);
}

function tokenVariants(token: string) {
  const out = new Set<string>([token]);
  if (token.startsWith("ال") && token.length > 4) out.add(token.slice(2));
  if (token.startsWith("و") && token.length > 4) out.add(token.slice(1));
  if (token.startsWith("بال") && token.length > 5) out.add(token.slice(3));
  if (token.startsWith("لل") && token.length > 4) out.add(token.slice(2));
  return [...out];
}

function levenshtein(a: string, b: string) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const next = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    next[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      next[j] = Math.min(next[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = next[j];
  }
  return prev[b.length];
}

function tokenClose(a: string, b: string) {
  if (a === b) return true;
  if (a.length <= 3 || b.length <= 3) return false;
  const max = Math.max(a.length, b.length);
  const allowed = max >= 8 ? 2 : 1;
  return levenshtein(a, b) <= allowed;
}

function approxToken(textTokens: string[], wanted: string) {
  const target = normalizeLocalText(wanted);
  return textTokens.some((token) =>
    tokenVariants(token).some((variant) => tokenClose(variant, target)),
  );
}

function hasTerm(normalized: string, textTokens: string[], term: string) {
  const target = normalizeLocalText(term);
  if (!target) return false;
  if (target.includes(" ")) {
    if (normalized.includes(target)) return true;
    const targetTokens = target.split(" ").filter(Boolean);
    return targetTokens.every((part) => approxToken(textTokens, part));
  }
  return approxToken(textTokens, target);
}

function hasAny(normalized: string, textTokens: string[], terms: string[]) {
  return terms.some((term) => hasTerm(normalized, textTokens, term));
}

function extractCard(raw: string) {
  const normalizedDigits = raw
    .split("")
    .map((char) => ARABIC_DIGITS[char] ?? char)
    .join("");
  const matches = normalizedDigits.match(/(?<![\d.])\d{5,20}(?![\d.])/g);
  return matches?.[0] || null;
}

function extractVlan(raw: string, normalized: string) {
  const digitRaw = raw
    .split("")
    .map((char) => ARABIC_DIGITS[char] ?? char)
    .join("");
  const patterns = [
    /(?:vlan|في?لان|فيلان|فلان|v-lan)\s*#?\s*(\d{1,4})/i,
    /(?:شبكه|شبكة)\s*(?:رقم)?\s*(\d{1,4})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(digitRaw);
    if (!match) continue;
    const value = Number(match[1]);
    if (value >= 1 && value <= 4094) return value;
  }
  if (/(?:vlan|فيلان|فلان)/i.test(normalized)) {
    const small = digitRaw.match(/\b(\d{1,4})\b/);
    const value = Number(small?.[1] || 0);
    if (value >= 1 && value <= 4094) return value;
  }
  return null;
}

const ORDINALS: Array<[RegExp, number]> = [
  [/\b(?:الاول|اول|الاولي|اولي|first)\b/i, 1],
  [/\b(?:الثاني|الثانيه|ثاني|ثانيه|second)\b/i, 2],
  [/\b(?:الثالث|الثالثه|ثالث|ثالثه|third)\b/i, 3],
  [/\b(?:الرابع|الرابعه|رابع|رابعه|fourth)\b/i, 4],
  [/\b(?:الخامس|الخامسه|خامس|خامسه|fifth)\b/i, 5],
  [/\b(?:السادس|السادسه|سادس|سادسه|sixth)\b/i, 6],
  [/\b(?:السابع|السابعه|سابع|سابعه|seventh)\b/i, 7],
  [/\b(?:الثامن|الثامنه|ثامن|ثامنه|eighth)\b/i, 8],
  [/\b(?:التاسع|التاسعه|تاسع|تاسعه|ninth)\b/i, 9],
  [/\b(?:العاشر|العاشره|عاشر|عاشره|tenth)\b/i, 10],
];

function extractNetworkIndex(normalized: string) {
  for (const [pattern, index] of ORDINALS) if (pattern.test(normalized)) return index;
  const match = normalized.match(/(?:استخدم|اختار|اختر|حول|بدل|switch|use)\s+(?:الشبكه\s*)?(\d{1,2})\b/i);
  const value = Number(match?.[1] || 0);
  return value > 0 && value <= 99 ? value : null;
}

function extractNetworkName(normalized: string) {
  const patterns = [
    /(?:استخدم|اختار|اختر|حول|حوّل|بدل|switch to|use)\s+(?:شبكه|الشبكه|network)?\s*([\p{L}\d_-]{2,40})$/iu,
    /(?:روح|انتقل)\s+(?:ل|الى|الي)?\s*(?:شبكه|الشبكه)?\s*([\p{L}\d_-]{2,40})$/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    if (!match) continue;
    const value = match[1]?.trim();
    if (value && !/^\d+$/.test(value)) return value;
  }
  return null;
}

function extractPingHost(raw: string) {
  const digitRaw = raw
    .split("")
    .map((char) => ARABIC_DIGITS[char] ?? char)
    .join("");
  const ip = digitRaw.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0];
  if (ip) return ip;
  const host = digitRaw.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/i)?.[0];
  return host || null;
}

function contextFresh(context?: LocalNluContext | null) {
  if (!context?.updated_at) return Boolean(context);
  const at = new Date(context.updated_at).getTime();
  return Number.isFinite(at) && Date.now() - at < 6 * 60 * 60 * 1000;
}

function result(
  intent: LocalIntent,
  confidence: number,
  normalized: string,
  entities: LocalNluResult["entities"],
  reason: string,
): LocalNluResult {
  return { intent, confidence, normalized, entities, reason };
}

export function understandLocalMessage(raw: string, context?: LocalNluContext | null): LocalNluResult {
  const normalized = normalizeLocalText(raw);
  const textTokens = words(normalized);
  const card = extractCard(raw);
  const vlan = extractVlan(raw, normalized);
  const networkIndex = extractNetworkIndex(normalized);
  const networkName = extractNetworkName(normalized);
  const pingHost = extractPingHost(raw);
  const ctx = contextFresh(context) ? context : null;

  const isVeryShort = textTokens.length <= 4;

  if (hasAny(normalized, textTokens, ["الغاء", "الغي", "كنسل", "cancel", "وقف الاعداد", "خلاص الغي"])) {
    return result("cancel", 0.99, normalized, {}, "cancel phrase");
  }

  if (hasAny(normalized, textTokens, ["اضف شبكه", "ضيف شبكه", "اربط شبكه", "شبكه جديده", "add network", "connect router", "ربط راوتر"])) {
    return result("add_network", 0.98, normalized, {}, "add network phrase");
  }

  const switchTerms = ["استخدم", "اختار", "اختر", "حول", "بدل", "انتقل", "روح", "switch", "use"];
  if (
    (networkIndex || networkName) &&
    (hasAny(normalized, textTokens, switchTerms) || ctx?.last_intent === "networks")
  ) {
    return result(
      "use_network",
      0.97,
      normalized,
      { network_index: networkIndex || undefined, network_name: networkName || undefined },
      "network switch phrase",
    );
  }

  if (hasAny(normalized, textTokens, ["شبكاتي", "قائمه الشبكات", "قائمة الشبكات", "ايش الشبكات", "وش الشبكات", "الشبكات عندي", "networks", "my networks", "الشبكه النشطه", "الشبكة النشطة"])) {
    return result("networks", 0.96, normalized, {}, "network list phrase");
  }

  const cardWords = [
    "كرت", "الكرت", "بطاقه", "بطاق", "يوزر", "user", "voucher", "card", "مشترك", "حساب",
    "جلسه", "جلسات", "session", "history", "استهلاك", "متبقي", "باقي", "فصل", "يفصل", "انتهى",
    "افحص", "شيك", "شوف", "راجع", "inspect", "check",
  ];
  const cardFollowups = [
    "هو متصل", "متصل الحين", "كم باقي", "وش باقي", "استهلاكه", "استهلاك", "اخر جلسه", "آخر جلسه",
    "ليش فصل", "ليش يفصل", "وش مشكلته", "افحصه", "شيكه", "شوفه", "هذا الكرت", "نفس الكرت", "نفسه",
  ];
  if (card && (hasAny(normalized, textTokens, cardWords) || /^\s*[٠-٩۰-۹\d]{5,20}\s*$/.test(raw))) {
    return result("card", 0.995, normalized, { card }, "card id + card language");
  }
  if (
    !card &&
    ctx?.last_entity_type === "card" &&
    ctx.last_entity_value &&
    hasAny(normalized, textTokens, cardFollowups)
  ) {
    return result("card", 0.94, normalized, { card: ctx.last_entity_value }, "card follow-up context");
  }

  const vlanTerms = ["vlan", "فيلان", "فلان", "شبكه", "شبكة"];
  const vlanFollowups = ["استهلاكها", "كم استهلاك", "كم فيها", "المتصلين عليها", "مين عليها", "شوفها", "افحصها", "حالها", "وضعها"];
  if (vlan && hasAny(normalized, textTokens, vlanTerms)) {
    return result("vlan_detail", 0.99, normalized, { vlan_id: vlan }, "explicit vlan id");
  }
  if (
    !vlan &&
    ctx?.last_entity_type === "vlan" &&
    ctx.last_entity_value &&
    hasAny(normalized, textTokens, vlanFollowups)
  ) {
    const value = Number(ctx.last_entity_value);
    if (value >= 1 && value <= 4094) {
      return result("vlan_detail", 0.93, normalized, { vlan_id: value }, "vlan follow-up context");
    }
  }

  const onlineNouns = ["مستخدم", "مستخدمين", "مشترك", "مشتركين", "متصل", "متصلين", "اونلاين", "داخل", "داخليين", "شابك", "شابكين", "ناس", "user", "users", "online", "active"];
  const onlineQuestions = ["كم", "كام", "عدد", "مين", "من", "منهم", "اعرض", "اظهر", "هات", "جيب", "who", "how many", "list", "show"];
  if (
    (hasAny(normalized, textTokens, onlineNouns) && hasAny(normalized, textTokens, onlineQuestions)) ||
    hasAny(normalized, textTokens, ["المتصلين الان", "المتصلون الان", "مين داخل", "مين شابك", "كم واحد داخل", "كم واحد شابك", "online users", "active users"])
  ) {
    return result("online", 0.97, normalized, {}, "online users phrase");
  }

  const salesWords = ["مبيعات", "مبيعات اليوم", "بيع", "بعنا", "انباع", "انباعة", "كروت جديده", "كروت جديدة", "كرت جديد", "اول دخول", "أول دخول", "first login", "sales", "sold", "new cards", "today sales"];
  if (hasAny(normalized, textTokens, salesWords)) {
    return result("sales", 0.97, normalized, {}, "sales phrase");
  }

  if (hasAny(normalized, textTokens, ["الفيلانات", "فيلانات", "كل vlan", "كل الفيلانات", "قائمه vlan", "قائمة vlan", "vlans", "vlan list"])) {
    return result("vlans", 0.97, normalized, {}, "vlan list phrase");
  }

  const routerWords = [
    "معلومات الراوتر", "معلومات المايكروتك", "اصدار الراوتر", "اصدار المايكروتك", "موديل الراوتر", "نوع الراوتر",
    "router info", "router version", "router model", "routeros", "uptime", "cpu", "ram", "ذاكره", "ذاكرة",
    "المعالج", "الهاردوير", "board",
  ];
  if (hasAny(normalized, textTokens, routerWords)) {
    return result("router", 0.95, normalized, {}, "router info phrase");
  }

  const diagnoseWords = [
    "مشكله", "مشكلة", "ليش النت", "ليش الشبكه", "ليش الشبكة", "بطي", "بطيء", "بطئ", "يقطع", "تقطيع",
    "متقطع", "لاق", "lag", "slow", "unstable", "disconnect", "يفصل", "ما يفتح", "مايفتح", "افحص كلشي",
    "افحص كل شي", "شوف المشكله", "شوف المشكلة", "شخص المشكله", "شخص المشكلة", "diagnose", "troubleshoot",
  ];
  if (hasAny(normalized, textTokens, diagnoseWords)) {
    return result("diagnose", 0.96, normalized, { ping_host: pingHost || undefined }, "diagnostic phrase");
  }

  const pingWords = ["بنج", "بينج", "ping", "packet loss", "فقد", "latency", "تاخير", "تأخير", "اختبر النت", "اختبار النت", "اختبر الانترنت", "اختبار الانترنت", "test internet"];
  if (hasAny(normalized, textTokens, pingWords)) {
    return result("ping", 0.96, normalized, { ping_host: pingHost || undefined }, "ping phrase");
  }

  const statusWords = [
    "حاله الشبكه", "حالة الشبكة", "وضع الشبكه", "وضع الشبكة", "كيف الشبكه", "كيف الشبكة", "الشبكه شغاله",
    "الشبكة شغالة", "النت شغال", "الانترنت شغال", "حاله النت", "حالة النت", "status", "network status",
    "network health", "وضع النت", "طمني على الشبكه", "طمني على الشبكة", "كلشي تمام", "كل شي تمام",
  ];
  if (hasAny(normalized, textTokens, statusWords)) {
    return result("status", 0.95, normalized, {}, "network status phrase");
  }

  const helpWords = ["مساعده", "مساعدة", "ساعدني", "وش تقدر", "ايش تقدر", "وش تسوي", "ايش تسوي", "وش الاوامر", "ايش الاوامر", "الاوامر", "help", "commands", "what can you do"];
  if (hasAny(normalized, textTokens, helpWords)) {
    return result("help", 0.97, normalized, {}, "help phrase");
  }

  if (isVeryShort && hasAny(normalized, textTokens, ["هلا", "هلو", "مرحبا", "السلام عليكم", "سلام", "هاي", "hello", "hi", "hey", "صباح الخير", "مساء الخير"])) {
    return result("greeting", 0.96, normalized, {}, "greeting");
  }

  if (isVeryShort && hasAny(normalized, textTokens, ["شكرا", "مشكور", "يعطيك العافيه", "تسلم", "تمام", "اوكي", "اوك", "thanks", "thank you", "thx", "ok", "great"])) {
    return result("thanks", 0.9, normalized, {}, "acknowledgement");
  }

  // Generic context follow-ups. These are intentionally conservative.
  if (ctx?.last_entity_type === "card" && ctx.last_entity_value && hasAny(normalized, textTokens, ["هذا", "نفسه", "طيب", "وبعدين", "اكثر", "زياده", "تفاصيل"])) {
    return result("card", 0.78, normalized, { card: ctx.last_entity_value }, "generic card context follow-up");
  }
  if (ctx?.last_entity_type === "vlan" && ctx.last_entity_value && hasAny(normalized, textTokens, ["هذا", "نفسها", "طيب", "تفاصيل", "اكثر", "زياده"])) {
    const value = Number(ctx.last_entity_value);
    if (value >= 1 && value <= 4094) return result("vlan_detail", 0.78, normalized, { vlan_id: value }, "generic vlan context follow-up");
  }
  if (ctx?.last_intent === "networks" && networkIndex) {
    return result("use_network", 0.86, normalized, { network_index: networkIndex }, "network ordinal follow-up");
  }

  return result("unknown", 0.2, normalized, {}, "no confident deterministic intent");
}
