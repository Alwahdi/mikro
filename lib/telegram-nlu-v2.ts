import {
  normalizeLocalText,
  understandLocalMessage as baseUnderstand,
  type LocalNluContext,
  type LocalNluResult,
} from "./telegram-nlu";

const ORDINALS: Array<[string[], number]> = [
  [["الاول", "اول", "الاولي", "اولي", "first"], 1],
  [["الثاني", "الثانيه", "ثاني", "ثانيه", "second"], 2],
  [["الثالث", "الثالثه", "ثالث", "ثالثه", "third"], 3],
  [["الرابع", "الرابعه", "رابع", "رابعه", "fourth"], 4],
  [["الخامس", "الخامسه", "خامس", "خامسه", "fifth"], 5],
  [["السادس", "السادسه", "سادس", "سادسه", "sixth"], 6],
  [["السابع", "السابعه", "سابع", "سابعه", "seventh"], 7],
  [["الثامن", "الثامنه", "ثامن", "ثامنه", "eighth"], 8],
  [["التاسع", "التاسعه", "تاسع", "تاسعه", "ninth"], 9],
  [["العاشر", "العاشره", "عاشر", "عاشره", "tenth"], 10],
];

function ordinalIndex(normalized: string) {
  const tokens = normalized.split(/\s+/).filter(Boolean);
  for (const [terms, index] of ORDINALS) {
    if (terms.some((term) => tokens.includes(term))) return index;
  }
  return null;
}

function switchIndex(normalized: string) {
  const match = normalized.match(/(?:استخدم|اختار|اختر|حول|بدل|انتقل|روح|switch|use)\s+(?:(?:ل|لل|الى|الي)?(?:الشبكه|شبكه|network)\s*)?(\d{1,2})(?:\s|$)/i);
  const value = Number(match?.[1] || 0);
  return value >= 1 && value <= 99 ? value : null;
}

function direct(
  intent: LocalNluResult["intent"],
  normalized: string,
  confidence: number,
  reason: string,
  entities: LocalNluResult["entities"] = {},
): LocalNluResult {
  return { intent, normalized, confidence, reason, entities };
}

export function understandLocalMessage(raw: string, context?: LocalNluContext | null): LocalNluResult {
  const normalized = normalizeLocalText(raw);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const index = switchIndex(normalized) || ordinalIndex(normalized);

  // Network switching must win over the colloquial "شبكة <number>" VLAN shortcut.
  if (
    index &&
    (/(?:استخدم|اختار|اختر|حول|بدل|انتقل|روح|switch|use)/i.test(normalized) || context?.last_intent === "networks")
  ) {
    return direct("use_network", normalized, 0.99, "explicit network switch", { network_index: index });
  }

  // Arabic word boundaries are not reliably represented by JS \b, so a bare
  // ordinal after /networks is handled with token matching.
  if (index && context?.last_intent === "networks") {
    return direct("use_network", normalized, 0.95, "network ordinal follow-up", { network_index: index });
  }

  // Prevent generic English "network" from fuzzy-matching the plural command
  // "networks" before health/diagnostic language is considered.
  const diagnostic = ["slow", "troubleshoot", "unstable", "disconnect", "lag", "problem", "issue"];
  if (tokens.includes("network") && diagnostic.some((term) => tokens.includes(term))) {
    return direct("diagnose", normalized, 0.98, "english network diagnostic phrase");
  }
  if (
    normalized === "network status" ||
    normalized === "network health" ||
    (tokens.includes("network") && tokens.includes("status"))
  ) {
    return direct("status", normalized, 0.98, "english network status phrase");
  }

  // Common Arabic pronunciation/transliteration for RAM.
  if (tokens.includes("رام") || tokens.includes("الرام")) {
    return direct("router", normalized, 0.97, "router RAM phrase");
  }

  const base = baseUnderstand(raw, context);

  // A lone English "network" should never imply the user's network list.
  if (base.intent === "networks" && tokens.includes("network") && !tokens.includes("networks")) {
    if (tokens.includes("status") || tokens.includes("health")) {
      return direct("status", normalized, 0.96, "corrected singular network status");
    }
    if (diagnostic.some((term) => tokens.includes(term))) {
      return direct("diagnose", normalized, 0.96, "corrected singular network diagnostic");
    }
  }

  return base;
}

export type { LocalIntent, LocalNluContext, LocalNluResult } from "./telegram-nlu";
export { normalizeLocalText } from "./telegram-nlu";
