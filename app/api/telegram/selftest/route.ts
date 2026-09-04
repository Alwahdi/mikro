import { NextRequest, NextResponse } from "next/server";
import { handleTelegramSales } from "@/lib/telegram-sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TEST_KEY = "P5exr2UkHrH0SmjklfOqxZTXZS_OrC4L";

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("key") !== TEST_KEY) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }

  const started = Date.now();
  try {
    const handled = await handleTelegramSales({
      update_id: Date.now(),
      message: {
        message_id: 0,
        chat: { id: 714096234 },
        from: {
          id: 714096234,
          username: "alwahdi4",
          first_name: "Abdullah",
          language_code: "ar",
        },
        text: "/sales",
      },
    });

    return NextResponse.json({ ok: handled, duration_ms: Date.now() - started });
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
