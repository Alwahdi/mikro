import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, markAgentSeen } from "@/lib/router-agent";
import { dbGet, dbPatch } from "@/lib/telegram-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AgentCommand = {
  id: string;
  kind: "status" | "ping" | "vlan" | "sales";
  payload: Record<string, unknown> | null;
};

export async function GET(req: NextRequest) {
  const networkId = req.nextUrl.searchParams.get("network") || "";
  const token = req.nextUrl.searchParams.get("token") || "";
  if (!networkId || !token) return new NextResponse("missing credentials", { status: 400 });

  const network = await authenticateAgent(networkId, token);
  if (!network) return new NextResponse("unauthorized", { status: 401 });

  await markAgentSeen(networkId);

  const staleBefore = new Date(Date.now() - 3 * 60_000).toISOString();
  await dbPatch(
    "tg_agent_commands",
    { status: "expired", error: "command-timeout", completed_at: new Date().toISOString() },
    { network_id: `eq.${networkId}`, status: "eq.pending", created_at: `lt.${staleBefore}` },
  );

  const commands = await dbGet<AgentCommand>("tg_agent_commands", {
    network_id: `eq.${networkId}`,
    status: "eq.pending",
    select: "id,kind,payload",
    order: "created_at.asc",
    limit: "1",
  });

  const command = commands[0];
  if (!command) {
    return new NextResponse("NONE", {
      headers: { "content-type": "text/plain", "cache-control": "no-store" },
    });
  }

  await dbPatch(
    "tg_agent_commands",
    { status: "claimed", claimed_at: new Date().toISOString() },
    { id: `eq.${command.id}`, status: "eq.pending" },
  );

  let body = `CMD|${command.id}|${command.kind.toUpperCase()}`;
  if (command.kind === "vlan") {
    const vlanId = Number(command.payload?.vlan_id || 0);
    body += `|${vlanId}`;
  }

  return new NextResponse(body, {
    headers: { "content-type": "text/plain", "cache-control": "no-store" },
  });
}
