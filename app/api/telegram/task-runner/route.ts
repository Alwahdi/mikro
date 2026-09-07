import { NextRequest, NextResponse } from "next/server";
import { runAgentTargetAlertChecks } from "@/lib/telegram-alert-agent-targets";
import { runAlertChecksV2 } from "@/lib/telegram-alert-worker-v2";
import { dbGet } from "@/lib/telegram-db";
import { runDueTasksSafe } from "@/lib/telegram-task-runner-safe";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;

type Config={key:string;value:string};
export async function POST(req:NextRequest){
  const rows=await dbGet<Config>("tg_system_config",{key:"eq.task_runner_secret",select:"key,value",limit:"1"});
  const expected=rows[0]?.value; const supplied=req.headers.get("x-runner-secret");
  if(!expected||supplied!==expected)return NextResponse.json({ok:false},{status:401});
  const results=await runDueTasksSafe();
  const alerts=await runAlertChecksV2();
  // The primary worker intentionally treats Agent interface/VLAN targets as
  // unavailable. This supplemental pass consumes v3 Agent telemetry and owns
  // only those target-specific Agent rules, without changing Direct behavior.
  const agentTargets=await runAgentTargetAlertChecks();
  return NextResponse.json({ok:true,processed:results.length,results,alert_networks:alerts.length,alerts,agent_target_alerts:agentTargets});
}
