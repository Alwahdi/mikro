import { NextRequest, NextResponse } from "next/server";
import { runTelegramAITest } from "@/lib/telegram-ai-v2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const KEY = "ai-test-7rL2vQm9Kp4Z";
const PRONET_NETWORK_ID = "ed4252c3-685f-4b60-b007-cdce6b6665cc";

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("key") !== KEY) {
    return new NextResponse("not found", { status: 404 });
  }

  const text = req.nextUrl.searchParams.get("q") || "كم في مستخدمين الان؟";
  const started = Date.now();
  try {
    const result = await runTelegramAITest(714096234, PRONET_NETWORK_ID, text);
    return NextResponse.json({
      ok: true,
      duration_ms: Date.now() - started,
      tools: result.tools,
      answer: result.text,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        duration_ms: Date.now() - started,
        error: String(error instanceof Error ? error.message : error),
      },
      { status: 500 },
    );
  }
}
