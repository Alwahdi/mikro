import { randomBytes, timingSafeEqual } from "crypto";
import { decryptSecret, encryptSecret } from "./telegram-crypto";
import { dbGet, dbPatch } from "./telegram-db";

export const AGENT_BASE_URL = "https://mikro-nine.vercel.app";

export type AgentNetwork = {
  id: string;
  telegram_user_id: number;
  label: string;
  connection_mode: "direct" | "agent";
  agent_secret_ciphertext?: string | null;
  agent_last_seen_at?: string | null;
  identity?: string | null;
  router_os_version?: string | null;
};

export function newAgentSecret() {
  return randomBytes(24).toString("base64url");
}

export function encryptAgentSecret(secret: string) {
  return encryptSecret(secret);
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function authenticateAgent(networkId: string, token: string) {
  const rows = await dbGet<AgentNetwork>("tg_networks", {
    id: `eq.${networkId}`,
    connection_mode: "eq.agent",
    select: "id,telegram_user_id,label,connection_mode,agent_secret_ciphertext,agent_last_seen_at,identity,router_os_version",
    limit: "1",
  });
  const network = rows[0];
  if (!network?.agent_secret_ciphertext) return null;
  let expected = "";
  try { expected = decryptSecret(network.agent_secret_ciphertext); } catch { return null; }
  if (!safeEqual(expected, token)) return null;
  return network;
}

export async function markAgentSeen(networkId: string) {
  const now = new Date().toISOString();
  await dbPatch("tg_networks", { status: "online", agent_last_seen_at: now, last_connected_at: now, last_error: null, updated_at: now }, { id: `eq.${networkId}` });
}

export function agentInstallCommand(networkId: string, secret: string) {
  const url = `${AGENT_BASE_URL}/api/router-agent/install-v3?network=${encodeURIComponent(networkId)}&token=${encodeURIComponent(secret)}`;
  return `/tool fetch url="${url}" dst-path=mt-tg-agent.rsc; /import file-name=mt-tg-agent.rsc`;
}
