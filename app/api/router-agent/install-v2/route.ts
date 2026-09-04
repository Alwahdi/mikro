import { NextRequest, NextResponse } from "next/server";
import { GET as baseInstaller } from "../install/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const response = await baseInstaller(req);
  if (!response.ok) return response;

  // RouterOS 6.43 introduced fetch as-value, but http-header-field arrived in
  // 6.44. The result endpoint consumes raw text regardless of Content-Type, so
  // remove the custom header and preserve full 6.43 compatibility.
  const script = (await response.text()).replace(
    ' http-header-field="Content-Type:text/plain"',
    "",
  );

  return new NextResponse(script, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
