import { NextRequest, NextResponse } from "next/server";
import { runDueTasks } from "@/lib/telegram-scheduler";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
const KEY="scheduler-e2e-20260905";
export async function GET(req:NextRequest){
  if(req.nextUrl.searchParams.get("key")!==KEY)return new NextResponse("not found",{status:404});
  const results=await runDueTasks();
  return NextResponse.json({ok:true,processed:results.length,results});
}
