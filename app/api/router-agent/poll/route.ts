import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, markAgentSeen } from "@/lib/router-agent";
import { dbGet, dbPatch } from "@/lib/telegram-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AgentKind =
  | "status" | "ping" | "vlan" | "sales" | "online" | "vlans" | "router" | "card" | "users"
  | "logs" | "interfaces" | "dhcp" | "hotspot" | "top_usage" | "backup_binary"
  | "wan" | "routes" | "dns" | "firewall" | "queues"
  | "priv_preview_user" | "priv_preview_vlan"
  | "priv_disconnect_user" | "priv_disable_user" | "priv_enable_user"
  | "priv_disable_vlan" | "priv_enable_vlan";

type AgentCommand = { id: string; kind: AgentKind; payload: Record<string, unknown> | null };
type NetworkState = { agent_privileged_enabled?: boolean | null; agent_version?: number | null };

const V4_ONLY = new Set<AgentKind>(["wan", "routes", "dns", "firewall", "queues", "users"]);
function isPrivileged(kind: string) { return kind.startsWith("priv_") && !kind.startsWith("priv_preview_"); }
function safeArg(value: unknown) { return String(value ?? "").replace(/[|\r\n]/g, "").slice(0, 128); }

export async function GET(req: NextRequest) {
  const networkId = req.nextUrl.searchParams.get("network") || "";
  const token = req.nextUrl.searchParams.get("token") || "";
  const reportedVersion = Math.max(0, Math.min(99, Number(req.nextUrl.searchParams.get("v") || 0) || 0));
  if (!networkId || !token) return new NextResponse("missing credentials", { status: 400 });

  const network = await authenticateAgent(networkId, token);
  if (!network) return new NextResponse("unauthorized", { status: 401 });
  await markAgentSeen(networkId);
  if (reportedVersion > 0) {
    await dbPatch("tg_networks", { agent_version: reportedVersion, updated_at: new Date().toISOString() }, { id: `eq.${networkId}` });
  }
  const now = new Date().toISOString();

  const retryBefore = new Date(Date.now() - 60_000).toISOString();
  await dbPatch("tg_agent_commands", { status: "pending", claimed_at: null, error: null }, { network_id: `eq.${networkId}`, status: "eq.claimed", claimed_at: `lt.${retryBefore}` });
  const expireBefore = new Date(Date.now() - 5 * 60_000).toISOString();
  await dbPatch("tg_agent_commands", { status: "expired", error: "command-timeout", completed_at: now }, { network_id: `eq.${networkId}`, status: "eq.pending", created_at: `lt.${expireBefore}` });

  const commands = await dbGet<AgentCommand>("tg_agent_commands", { network_id: `eq.${networkId}`, status: "eq.pending", select: "id,kind,payload", order: "created_at.asc", limit: "1" });
  const command = commands[0];
  if (!command) return new NextResponse("NONE", { headers: { "content-type": "text/plain", "cache-control": "no-store" } });

  const states = await dbGet<NetworkState>("tg_networks", { id: `eq.${networkId}`, select: "agent_privileged_enabled,agent_version", limit: "1" });
  const state = states[0] || {};
  const effectiveVersion = reportedVersion || Number(state.agent_version || 0);

  if (V4_ONLY.has(command.kind) && effectiveVersion < 4) {
    await dbPatch("tg_agent_commands", { status: "error", error: "agent-upgrade-required", completed_at: now }, { id: `eq.${command.id}`, status: "eq.pending" });
    return new NextResponse("NONE", { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
  }

  if (isPrivileged(command.kind) && !state.agent_privileged_enabled) {
    await dbPatch("tg_agent_commands", { status: "error", error: "privileged-agent-not-enabled", completed_at: now }, { id: `eq.${command.id}`, status: "eq.pending" });
    return new NextResponse("NONE", { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
  }

  await dbPatch("tg_agent_commands", { status: "claimed", claimed_at: now }, { id: `eq.${command.id}`, status: "eq.pending" });
  let body = `CMD|${command.id}|${command.kind.toUpperCase()}`;
  if (command.kind === "vlan") body += `|${Number(command.payload?.vlan_id || 0)}`;
  if (command.kind === "card") body += `|${safeArg(command.payload?.username)}`;
  if (command.kind === "users") body += `|${safeArg(command.payload?.query)}`;
  const userKinds = new Set(["priv_preview_user", "priv_disconnect_user", "priv_disable_user", "priv_enable_user"]);
  const vlanKinds = new Set(["priv_preview_vlan", "priv_disable_vlan", "priv_enable_vlan"]);
  if (userKinds.has(command.kind)) body += `|${safeArg(command.payload?.target)}`;
  if (vlanKinds.has(command.kind)) body += `|${Number(command.payload?.target || 0)}`;

  return new NextResponse(body, { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
}
