import { normalizeLocalText, understandLocalMessage as understandV2, type LocalNluContext } from "./telegram-nlu-v2";

export type ProIntent =
  | "card" | "online" | "sales" | "vlan_detail" | "vlans" | "router" | "ping" | "status" | "diagnose"
  | "networks" | "use_network" | "add_network" | "cancel" | "help" | "greeting" | "thanks"
  | "backup" | "schedule" | "show_schedules" | "cancel_schedule" | "logs" | "interfaces" | "dhcp" | "hotspot" | "top_usage" | "unknown";

export type ProResult = {
  intent: ProIntent;
  confidence: number;
  normalized: string;
  reason: string;
  entities: {
    card?: string;
    vlan_id?: number;
    network_index?: number;
    network_name?: string;
    ping_host?: string;
    backup_type?: "rsc" | "binary" | "cloud-binary";
    schedule?: ScheduleSpec;
    scheduled_task?: "status" | "sales" | "backup_rsc" | "backup_binary" | "diagnose";
    schedule_id?: string;
  };
};

export type ScheduleSpec =
  | { kind: "interval"; minutes: number; text: string }
  | { kind: "daily"; hour: number; minute: number; text: string }
  | { kind: "weekly"; weekday: number; hour: number; minute: number; text: string };

const CARD_NOUNS = ["كرت","الكرت","بطاقه","بطاقة","بطاق","يوزر","اليوزر","المستخدم","مستخدم","مشترك","الحساب","حساب","voucher","card","user","account"];
const CARD_VERBS = ["افحص","افحصلي","افحص لي","شيك","شيكلي","شيك لي","شوف","شوفلي","شوف لي","راجع","راجعلي","راجع لي","دور","دورلي","دور لي","طلع","طلعلي","طلع لي","جيب","جيبلي","جيب لي","check","inspect","lookup","find","show"];
const BACKUP_WORDS = [
  "نسخه احتياطيه","نسخة احتياطية","نسخه احتياطية","نسخة احتياطيه",
  "نسخه rsc","نسخة rsc","rsc نسخه","rsc نسخة","export rsc","export",
  "نسخه binary","نسخة binary","نسخه باينري","نسخة باينري","binary backup","system backup",
  "باك اب","باكاب","باك اب","backup","back up","نسخه من الاعدادات","نسخة من الاعدادات",
];
const BLOCKED_CARD_WORDS = new Set([
  "الان","الحين","اليوم","امس","بكره","غدا","النت","الانترنت","انترنت","internet",
  "شبكه","الشبكه","شبكة","الشبكة","network","networks","راوتر","الراوتر","router","mikrotik","مايكروتك",
  "vlan","فيلان","فلان","dhcp","hotspot","هوتسبوت","هوت","status","حاله","حالة","ping","بنج","backup",
  "rsc","binary","logs","log","السجلات","المتصلين","اونلاين","online","مبيعات","sales","تمام","شكرا","هلا","مرحبا","hello","hi",
]);

function isCardCandidate(value: string) {
  if (!value || value.length < 2 || value.length > 128) return false;
  if (!/^[\p{L}\p{N}_.@:+-]+$/u.test(value)) return false;
  const n = normalizeLocalText(value);
  if (BLOCKED_CARD_WORDS.has(n)) return false;
  return true;
}

function extractNamedCard(raw: string) {
  const clean = raw.trim();
  const quoted = clean.match(/["'«](.{2,128}?)["'»]/u)?.[1]?.trim();
  if (quoted && isCardCandidate(quoted)) return quoted;

  const nounPattern = /(?:كرت|الكرت|بطاق(?:ه|ة)?|يوزر|اليوزر|المستخدم|مستخدم|مشترك|الحساب|حساب|voucher|card|user|account)\s*(?:رقم|اسمه|اسم|number|name)?\s*[:#-]?\s*([\p{L}\p{N}_.@:+-]{2,128})/iu;
  const nounMatch = nounPattern.exec(clean)?.[1];
  if (nounMatch && isCardCandidate(nounMatch)) return nounMatch;

  const verbPattern = /(?:افحص(?:لي|\s+لي)?|شيك(?:لي|\s+لي)?|شوف(?:لي|\s+لي)?|راجع(?:لي|\s+لي)?|دور(?:لي|\s+لي)?|طلع(?:لي|\s+لي)?|جيب(?:لي|\s+لي)?|check|inspect|lookup|find|show)\s*(?:هذا|هذي|ذا|the)?\s*([\p{L}\p{N}_.@:+-]{2,128})/iu;
  const verbMatch = verbPattern.exec(clean)?.[1];
  if (verbMatch && isCardCandidate(verbMatch)) return verbMatch;

  if (/^[\p{L}\p{N}_.@:+-]{2,128}$/u.test(clean) && isCardCandidate(clean)) {
    if (/\d/.test(clean) || /[_.@:+-]/.test(clean) || /^[A-Za-z]{5,}$/i.test(clean)) return clean;
  }
  return null;
}

function parseHour(raw: string) {
  const n = normalizeLocalText(raw);
  let hour: number | null = null;
  let minute = 0;
  const hm = n.match(/(?:الساعه|ساعة|الساعة|عند|at)?\s*(\d{1,2})(?::(\d{1,2}))?/i);
  if (hm) { hour = Number(hm[1]); minute = Number(hm[2] || 0); }
  if (hour === null || !Number.isInteger(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const pm = /(?:مساء|المساء|ليل|بالليل|pm)/i.test(n);
  const am = /(?:صباح|الصباح|فجر|الفجر|am)/i.test(n);
  if (pm && hour >= 1 && hour <= 11) hour += 12;
  if (am && hour === 12) hour = 0;
  return { hour, minute };
}

function parseSchedule(raw: string): ScheduleSpec | null {
  const n = normalizeLocalText(raw);
  const interval = n.match(/(?:كل|every)\s*(\d{1,3})?\s*(دقيقه|دقيقة|دقايق|دقائق|minutes?|ساعه|ساعة|ساعات|hours?)/i);
  if (interval) {
    const amount = Number(interval[1] || 1);
    const unit = interval[2];
    const minutes = /ساع|hour/i.test(unit) ? amount * 60 : amount;
    if (minutes >= 5 && minutes <= 10080) return { kind: "interval", minutes, text: raw.trim() };
  }
  if (/(?:كل ساعتين|every two hours)/i.test(n)) return { kind: "interval", minutes: 120, text: raw.trim() };
  if (/(?:كل ساعه|كل ساعة|hourly)/i.test(n)) return { kind: "interval", minutes: 60, text: raw.trim() };

  const weekdays: Array<[RegExp, number]> = [
    [/(?:الاحد|الأحد|sunday)/i,0], [/(?:الاثنين|الإثنين|monday)/i,1], [/(?:الثلاثاء|tuesday)/i,2],
    [/(?:الاربعاء|الأربعاء|wednesday)/i,3], [/(?:الخميس|thursday)/i,4], [/(?:الجمعه|الجمعة|friday)/i,5], [/(?:السبت|saturday)/i,6],
  ];
  const time = parseHour(raw);
  for (const [re, weekday] of weekdays) {
    if (/(?:كل|every|اسبوع|أسبوع|weekly)/i.test(n) && re.test(n)) {
      return { kind: "weekly", weekday, hour: time?.hour ?? 8, minute: time?.minute ?? 0, text: raw.trim() };
    }
  }
  if (/(?:كل يوم|يوميا|يومي|بشكل يومي|daily|every day)/i.test(n)) {
    return { kind: "daily", hour: time?.hour ?? 8, minute: time?.minute ?? 0, text: raw.trim() };
  }
  return null;
}

function backupType(n: string): "rsc" | "binary" | "cloud-binary" | undefined {
  if (/(?:binary|باينري|ثنائيه|ثنائية|\.backup|system backup)/i.test(n)) return "binary";
  if (/(?:rsc|export|تصدير|نصيه|نصية)/i.test(n)) return "rsc";
  return undefined;
}

function hasBackupLanguage(n: string) {
  return BACKUP_WORDS.some((w) => n.includes(normalizeLocalText(w))) ||
    /(?:خذ|خد|سوي|سويلي|سوي لي|اعمل|اعمللي|اعمل لي|طلع|طلعلي|طلع لي|احفظ|ارسل|ارسللي|ارسل لي|send|make|create|take)\s+.*(?:نسخه|نسخة|backup|rsc|binary|باينري)/i.test(n);
}

function scheduledTask(n: string): ProResult["entities"]["scheduled_task"] {
  if (hasBackupLanguage(n)) return backupType(n) === "binary" ? "backup_binary" : "backup_rsc";
  if (/(?:مبيعات|sales|كم بعنا|كروت جديده|كروت جديدة)/i.test(n)) return "sales";
  if (/(?:فحص|افحص|diagnose|تقطيع|بطي|slow|check network|اختبر الشبكه|اختبر الشبكة)/i.test(n)) return "diagnose";
  if (/(?:حاله|حالة|status|تقرير|report|ملخص الشبكه|ملخص الشبكة)/i.test(n)) return "status";
  return undefined;
}

export function understandProfessionalMessage(raw: string, context?: LocalNluContext | null): ProResult {
  const normalized = normalizeLocalText(raw);

  if (/(?:جدولي|جداولي|المهام المجدوله|المهام المجدولة|المواعيد|scheduled tasks|my schedules|show schedules)/i.test(normalized)) {
    return { intent:"show_schedules", confidence:0.99, normalized, reason:"schedule list", entities:{} };
  }
  const cancelSchedule = normalized.match(/(?:الغ|الغي|احذف|وقف|عطل|cancel|delete|disable)\s*(?:الجدول|المهمه|المهمة|schedule|task)?\s*#?\s*([0-9a-f-]{6,36}|\d{1,3})/i);
  if (cancelSchedule) {
    return { intent:"cancel_schedule", confidence:0.98, normalized, reason:"cancel schedule", entities:{ schedule_id: cancelSchedule[1] } };
  }

  const schedule = parseSchedule(raw);
  if (schedule) {
    const task = scheduledTask(normalized);
    if (task) return { intent:"schedule", confidence:0.995, normalized, reason:"deterministic recurrence + task", entities:{ schedule, scheduled_task:task, backup_type: backupType(normalized) } };
  }

  if (hasBackupLanguage(normalized)) {
    return { intent:"backup", confidence:0.995, normalized, reason:"backup phrase", entities:{ backup_type:backupType(normalized) } };
  }

  if (/(?:السجلات|اللوقات|اللوق|logs|log errors|اخطاء الراوتر|أخطاء الراوتر|اخر الاخطاء|آخر الأخطاء)/i.test(normalized)) {
    return { intent:"logs", confidence:0.97, normalized, reason:"router logs", entities:{} };
  }
  if (/(?:الانترفيسات|الواجهات|interfaces|ports|البورتات|منافذ الراوتر)/i.test(normalized)) {
    return { intent:"interfaces", confidence:0.95, normalized, reason:"interfaces", entities:{} };
  }
  if (/(?:dhcp|دي اتش سي بي|ليسات|leases|عناوين موزعه|عناوين موزعة)/i.test(normalized)) {
    return { intent:"dhcp", confidence:0.96, normalized, reason:"dhcp", entities:{} };
  }
  if (/(?:hotspot|هوتسبوت|هوت سبوت)/i.test(normalized) && !/(?:كرت|يوزر|user)/i.test(normalized)) {
    return { intent:"hotspot", confidence:0.95, normalized, reason:"hotspot overview", entities:{} };
  }
  if (/(?:اكثر.*استهلاك|أكثر.*استهلاك|top.*usage|top.*consumer|مين.*يسحب|مين.*يستهلك|اعلى.*استهلاك|أعلى.*استهلاك)/i.test(normalized)) {
    return { intent:"top_usage", confidence:0.96, normalized, reason:"top usage", entities:{} };
  }

  const card = extractNamedCard(raw);
  const hasCardLanguage = CARD_NOUNS.some((x) => normalized.includes(normalizeLocalText(x))) || CARD_VERBS.some((x) => normalized.includes(normalizeLocalText(x)));
  if (card && (hasCardLanguage || /^[\p{L}\p{N}_.@:+-]{2,128}$/u.test(raw.trim()))) {
    const greetingOnly = /^(?:hello|hi|hey|هلا|مرحبا|السلام)$/i.test(normalized);
    if (!greetingOnly) return { intent:"card", confidence:0.995, normalized, reason:"alphanumeric card/user entity", entities:{ card } };
  }

  // Explicit generic diagnostics must win over all-letter card extraction.
  if (/(?:افحص|شيك|شوف|راجع).*(?:الشبكه|الشبكة|النت|الانترنت|الراوتر|router|network|internet)/i.test(normalized)) {
    if (/(?:راوتر|router)/i.test(normalized) && !/(?:مشكله|مشكلة|بطي|تقطيع|يفصل)/i.test(normalized)) {
      return { intent:"router", confidence:0.96, normalized, reason:"explicit router inspection", entities:{} };
    }
    return { intent:"diagnose", confidence:0.98, normalized, reason:"explicit network diagnostic", entities:{} };
  }

  const base = understandV2(raw, context);
  return { intent: base.intent as ProIntent, confidence: base.confidence, normalized: base.normalized, reason: base.reason, entities: { ...base.entities } };
}
