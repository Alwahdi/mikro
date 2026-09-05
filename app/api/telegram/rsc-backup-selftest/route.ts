import { NextRequest, NextResponse } from "next/server";
import { runRscBackup } from "@/lib/telegram-backup";
export const runtime="nodejs"; export const dynamic="force-dynamic"; export const maxDuration=300;
const KEY="pronet-rsc-safe-test-20260905";
export async function GET(req:NextRequest){if(req.nextUrl.searchParams.get("key")!==KEY)return new NextResponse("not found",{status:404});const started=Date.now();try{const ok=await runRscBackup(714096234,714096234,true);return NextResponse.json({ok,duration_ms:Date.now()-started});}catch(e){return NextResponse.json({ok:false,error:String(e instanceof Error?e.message:e),duration_ms:Date.now()-started},{status:500});}}
