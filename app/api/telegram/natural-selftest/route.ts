import { NextRequest, NextResponse } from "next/server";
import { handleTelegramNaturalFallback } from "@/lib/telegram-natural-fallback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const KEY = "natural-test-Y8pL4nR2";

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("key") !== KEY) return new NextResponse("not found", { status: 404 });
  const q = req.nextUrl.searchParams.get("q") || "كم في مستخدمين الان؟";
  const started = Date.now();
  try {
    const handled = await handleTelegramNaturalFallback({
      update_id: Date.now(),
      message: {
        message_id: 0,
        chat: { id: 714096234 },
        from: { id: 775795104, username: "pronet-test", first_name: "PRONET" },
        text: q,
      },
    });
    return NextResponse.json({ ok: handled, duration_ms: Date.now() - started });
  } catch (error) {
    return NextResponse.json({ ok: false, duration_ms: Date.now() - started, error: String(error instanceof Error ? error.message : error) }, { status: 500 });
  }
}
