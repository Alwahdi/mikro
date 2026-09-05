import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, markAgentSeen } from "@/lib/router-agent";
import { dbGet, dbPatch } from "@/lib/telegram-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AgentKind =
  | "status" | "ping" | "vlan" | "sales" | "online" | "vlans" | "router" | "card"
  | "logs" | "interfaces" | "dhcp" | "hotspot" | "top_usage" | "backup_binary"
  | "priv_preview_user" | "priv_preview_vlan"
  | "priv_disconnect_user" | "priv_disable_user" | "priv_enable_user"
  | "priv_disable_vlan" | "priv_enable_vlan";

type AgentCommand = { id: string; kind: AgentKind; payload: Record<string, unknown> | null };
type PrivState = { agent_privileged_enabled: boolean };

function isPrivileged(kind: string) {
  return kind.startsWith("priv_") && !kind.startsWith("priv_preview_");
}

function safeArg(value: unknown) {
  return String(value ?? "").replace(/[|\r\n]/g, "").slice(0, 128);
}

export async function GET(req: NextRequest) {
  const networkId = req.nextUrl.searchParams.get("network") || "";
  const token = req.nextUrl.searchParams.get("token") || "";
  if (!networkId || !token) return new NextResponse("missing credentials", { status: 400 });

  const network = await authenticateAgent(networkId, token);
  if (!network) return new NextResponse("unauthorized", { status: 401 });
  await markAgentSeen(networkId);
  const now = new Date().toISOString();

  const retryBefore = new Date(Date.now() - 60_000).toISOString();
  await dbPatch(
    "tg_agent_commands",
    { status: "pending", claimed_at: null, error: null },
    { network_id: `eq.${networkId}`, status: "eq.claimed", claimed_at: `lt.${retryBefore}` },
  );
  const expireBefore = new Date(Date.now() - 5 * 60_000).toISOString();
  await dbPatch(
    "tg_agent_commands",
    { status: "expired", error: "command-timeout", completed_at: now },
    { network_id: `eq.${networkId}`, status: "eq.pending", created_at: `lt.${expireBefore}` },
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
    return new NextResponse("NONE", { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
  }

  if (isPrivileged(command.kind)) {
    const states = await dbGet<PrivState>("tg_networks", {
      id: `eq.${networkId}`,
      select: "agent_privileged_enabled",
      limit: "1",
    });
    if (!states[0]?.agent_privileged_enabled) {
      await dbPatch(
        "tg_agent_commands",
        { status: "error", error: "privileged-agent-not-enabled", completed_at: now },
        { id: `eq.${command.id}`, status: "eq.pending" },
      );
      return new NextResponse("NONE", { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
    }
  }

  await dbPatch(
    "tg_agent_commands",
    { status: "claimed", claimed_at: now },
    { id: `eq.${command.id}`, status: "eq.pending" },
  );

  let body = `CMD|${command.id}|${command.kind.toUpperCase()}`;
  if (command.kind === "vlan") body += `|${Number(command.payload?.vlan_id || 0)}`;
  if (command.kind === "card") body += `|${safeArg(command.payload?.username)}`;

  const userKinds = new Set([
    "priv_preview_user",
    "priv_disconnect_user",
    "priv_disable_user",
    "priv_enable_user",
  ]);
  const vlanKinds = new Set([
    "priv_preview_vlan",
    "priv_disable_vlan",
    "priv_enable_vlan",
  ]);
  if (userKinds.has(command.kind)) body += `|${safeArg(command.payload?.target)}`;
  if (vlanKinds.has(command.kind)) body += `|${Number(command.payload?.target || 0)}`;

  return new NextResponse(body, {
    headers: { "content-type": "text/plain", "cache-control": "no-store" },
  });
}
