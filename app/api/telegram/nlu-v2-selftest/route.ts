import { NextResponse } from "next/server";
import { understandLocalMessage, type LocalIntent, type LocalNluContext } from "@/lib/telegram-nlu-v2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type C = { text: string; expected: LocalIntent; context?: LocalNluContext };
const cases: C[] = [
  { text: "كم الرام", expected: "router" },
  { text: "network status", expected: "status" },
  { text: "network is slow", expected: "diagnose" },
  { text: "troubleshoot the network", expected: "diagnose" },
  { text: "حول للشبكه 2", expected: "use_network" },
  { text: "الثالثة", expected: "use_network", context: { last_intent: "networks" } },
  { text: "my networks", expected: "networks" },
  { text: "شبكة 203", expected: "vlan_detail" },
  { text: "كيف الشبكة", expected: "status" },
  { text: "افحص الكرت 15352951", expected: "card" },
  { text: "كم واحد داخل الحين", expected: "online" },
  { text: "كم مبيعات اليوم", expected: "sales" }
];

export async function GET() {
  const rows = cases.map((c) => {
    const got = understandLocalMessage(c.text, c.context);
    return { text: c.text, expected: c.expected, got: got.intent, ok: got.intent === c.expected, confidence: got.confidence };
  });
  return NextResponse.json({ total: rows.length, passed: rows.filter((x) => x.ok).length, failures: rows.filter((x) => !x.ok) });
}
