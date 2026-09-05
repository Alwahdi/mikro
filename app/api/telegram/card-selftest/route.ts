import { NextRequest, NextResponse } from "next/server";
import { handleTelegramCardUniversal } from "@/lib/telegram-card-universal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const KEY = "card-test-J3mQ8kV1";

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("key") !== KEY) {
    return new NextResponse("not found", { status: 404 });
  }
  const username = (req.nextUrl.searchParams.get("card") || "15352951").trim();
  const started = Date.now();
  try {
    const handled = await handleTelegramCardUniversal({
      update_id: Date.now(),
      message: {
        message_id: 0,
        chat: { id: 714096234 },
        from: { id: 775795104, username: "pronet-test", first_name: "PRONET" },
        text: `/card ${username}`,
      },
    });
    return NextResponse.json({ ok: handled, duration_ms: Date.now() - started });
  } catch (error) {
    return NextResponse.json(
      { ok: false, duration_ms: Date.now() - started, error: String(error instanceof Error ? error.message : error) },
      { status: 500 },
    );
  }
}
