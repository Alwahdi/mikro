import { NextRequest, NextResponse } from "next/server";
import { handleTelegramAI } from "@/lib/telegram-ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const KEY = "ai-test-7rL2vQm9Kp4Z";

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("key") !== KEY) return new NextResponse("not found", { status: 404 });
  const started = Date.now();
  try {
    const handled = await handleTelegramAI({
      update_id: Date.now(),
      message: {
        message_id: 0,
        chat: { id: 714096234 },
        from: { id: 714096234, username: "alwahdi4", first_name: "Abdullah", language_code: "ar" },
        text: "كم في مستخدمين الان؟",
      },
    });
    return NextResponse.json({ ok: handled, duration_ms: Date.now() - started });
  } catch (error) {
    return NextResponse.json({ ok: false, duration_ms: Date.now() - started, error: String(error instanceof Error ? error.message : error) }, { status: 500 });
  }
}
