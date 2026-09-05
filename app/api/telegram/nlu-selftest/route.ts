import { NextRequest, NextResponse } from "next/server";
import { understandLocalMessage, type LocalIntent, type LocalNluContext } from "@/lib/telegram-nlu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEY = "nlu-regression-95-v1";

type Case = { text: string; expected: LocalIntent; context?: LocalNluContext };

const cases: Case[] = [
  { text: "كم في مستخدمين الان؟", expected: "online" },
  { text: "كم واحد داخل الحين", expected: "online" },
  { text: "مين شابك بالشبكة؟", expected: "online" },
  { text: "جيب المتصلين", expected: "online" },
  { text: "show online users", expected: "online" },
  { text: "how many active users", expected: "online" },
  { text: "عدد المشتركين المتصلين", expected: "online" },
  { text: "كم ناس داخلين", expected: "online" },
  { text: "من هم المستخدممين اونلاين", expected: "online" },
  { text: "مين متصل حاليا", expected: "online" },

  { text: "15352951", expected: "card" },
  { text: "افحص الكرت 15352951", expected: "card" },
  { text: "شوف لي اليوزر 15352951", expected: "card" },
  { text: "شيك بطاقه 15352951", expected: "card" },
  { text: "ليش الكرت 15352951 يفصل", expected: "card" },
  { text: "استهلاك المستخدم 15352951", expected: "card" },
  { text: "card 15352951 history", expected: "card" },
  { text: "check voucher 15352951", expected: "card" },
  { text: "وش جلسات الكرت 15352951", expected: "card" },
  { text: "كم باقي للكرت 15352951", expected: "card" },

  { text: "طيب هل هو متصل؟", expected: "card", context: { last_entity_type: "card", last_entity_value: "15352951", last_intent: "card" } },
  { text: "وش اخر جلسه؟", expected: "card", context: { last_entity_type: "card", last_entity_value: "15352951", last_intent: "card" } },
  { text: "ليش فصل؟", expected: "card", context: { last_entity_type: "card", last_entity_value: "15352951", last_intent: "card" } },
  { text: "افحصه اكثر", expected: "card", context: { last_entity_type: "card", last_entity_value: "15352951", last_intent: "card" } },
  { text: "هذا الكرت وش وضعه", expected: "card", context: { last_entity_type: "card", last_entity_value: "15352951", last_intent: "card" } },

  { text: "كم مبيعات اليوم", expected: "sales" },
  { text: "كم بعنا اليوم", expected: "sales" },
  { text: "كم كرت جديد دخل اليوم", expected: "sales" },
  { text: "مبيعاتنا اليوم كم", expected: "sales" },
  { text: "وش الكروت الجديدة", expected: "sales" },
  { text: "today sales", expected: "sales" },
  { text: "new cards today", expected: "sales" },
  { text: "كم كرت انباع", expected: "sales" },
  { text: "اول دخول اليوم", expected: "sales" },

  { text: "شوف vlan 202", expected: "vlan_detail" },
  { text: "فيلان 202", expected: "vlan_detail" },
  { text: "وش وضع VLAN 212", expected: "vlan_detail" },
  { text: "استهلاك فلان 220", expected: "vlan_detail" },
  { text: "شبكة 203", expected: "vlan_detail" },
  { text: "v-lan 30", expected: "vlan_detail" },
  { text: "كم استهلاكها", expected: "vlan_detail", context: { last_entity_type: "vlan", last_entity_value: "202", last_intent: "vlan_detail" } },
  { text: "مين عليها", expected: "vlan_detail", context: { last_entity_type: "vlan", last_entity_value: "202", last_intent: "vlan_detail" } },
  { text: "شوفها اكثر", expected: "vlan_detail", context: { last_entity_type: "vlan", last_entity_value: "202", last_intent: "vlan_detail" } },

  { text: "اعرض الفيلانات", expected: "vlans" },
  { text: "جيب كل VLANs", expected: "vlans" },
  { text: "قائمة الفيلانات", expected: "vlans" },
  { text: "vlan list", expected: "vlans" },
  { text: "كل الفيلانات", expected: "vlans" },

  { text: "وش معلومات الراوتر", expected: "router" },
  { text: "ايش اصدار المايكروتك", expected: "router" },
  { text: "كم الرام", expected: "router" },
  { text: "كم cpu", expected: "router" },
  { text: "router info", expected: "router" },
  { text: "routeros version", expected: "router" },
  { text: "كم uptime", expected: "router" },

  { text: "اختبر البنج", expected: "ping" },
  { text: "سوي ping", expected: "ping" },
  { text: "كم البنج", expected: "ping" },
  { text: "packet loss كم", expected: "ping" },
  { text: "اختبار النت", expected: "ping" },
  { text: "test internet", expected: "ping" },
  { text: "شوف التاخير", expected: "ping" },

  { text: "كيف الشبكة", expected: "status" },
  { text: "طمني على الشبكه", expected: "status" },
  { text: "النت شغال؟", expected: "status" },
  { text: "حالة النت", expected: "status" },
  { text: "network status", expected: "status" },
  { text: "كلشي تمام بالشبكة؟", expected: "status" },

  { text: "النت بطيء افحصه", expected: "diagnose" },
  { text: "ليش الشبكة تقطع", expected: "diagnose" },
  { text: "في تقطيع اليوم", expected: "diagnose" },
  { text: "شوف المشكلة بالشبكة", expected: "diagnose" },
  { text: "افحص كلشي", expected: "diagnose" },
  { text: "network is slow", expected: "diagnose" },
  { text: "troubleshoot the network", expected: "diagnose" },
  { text: "عندي لاق", expected: "diagnose" },

  { text: "شبكاتي", expected: "networks" },
  { text: "اعرض الشبكات عندي", expected: "networks" },
  { text: "وش الشبكات", expected: "networks" },
  { text: "my networks", expected: "networks" },
  { text: "الشبكة النشطة", expected: "networks" },
  { text: "استخدم الثانية", expected: "use_network" },
  { text: "حول للشبكه 2", expected: "use_network" },
  { text: "switch to second", expected: "use_network" },
  { text: "الثالثة", expected: "use_network", context: { last_intent: "networks" } },
  { text: "استخدم PRONET", expected: "use_network" },

  { text: "اضف شبكة", expected: "add_network" },
  { text: "اربط راوتر جديد", expected: "add_network" },
  { text: "add network", expected: "add_network" },
  { text: "شبكة جديدة", expected: "add_network" },

  { text: "الغاء", expected: "cancel" },
  { text: "خلاص الغي", expected: "cancel" },
  { text: "cancel", expected: "cancel" },

  { text: "وش تقدر تسوي", expected: "help" },
  { text: "ايش الاوامر", expected: "help" },
  { text: "ساعدني", expected: "help" },
  { text: "what can you do", expected: "help" },

  { text: "هلا", expected: "greeting" },
  { text: "السلام عليكم", expected: "greeting" },
  { text: "hello", expected: "greeting" },
  { text: "صباح الخير", expected: "greeting" },

  { text: "شكرا", expected: "thanks" },
  { text: "تسلم", expected: "thanks" },
  { text: "تمام", expected: "thanks" },
  { text: "thanks", expected: "thanks" },
];

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("key") !== KEY) return new NextResponse("not found", { status: 404 });

  const rows = cases.map((test) => {
    const got = understandLocalMessage(test.text, test.context);
    return {
      text: test.text,
      expected: test.expected,
      got: got.intent,
      confidence: got.confidence,
      ok: got.intent === test.expected,
      reason: got.reason,
    };
  });
  const passed = rows.filter((row) => row.ok).length;
  const failed = rows.filter((row) => !row.ok);
  return NextResponse.json({
    total: rows.length,
    passed,
    failed: failed.length,
    accuracy: Number(((passed / rows.length) * 100).toFixed(2)),
    failures: failed,
  });
}
