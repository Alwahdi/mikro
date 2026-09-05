import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { GET as v3Installer } from "../install-v3/route";
import { authenticateAgent, AGENT_BASE_URL } from "@/lib/router-agent";
import { decryptSecret } from "@/lib/telegram-crypto";
import { dbGet, dbPatch } from "@/lib/telegram-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type InstallToken = {
  id: string;
  network_id: string;
  telegram_user_id: number;
  purpose: string;
  token_hash: string;
  expires_at: string;
  used_at?: string | null;
};

type Network = {
  id: string;
  telegram_user_id: number;
  connection_mode: "direct" | "agent";
  agent_secret_ciphertext?: string | null;
};

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

const privilegedBlock = `
    :if ($kind = "PRIV_PREVIEW_USER") do={
        :do {
            :local uname $arg
            :local found 0
            :local source ""
            :local profile "-"
            :local disabled 0
            :local active 0
            :local ip ""
            :local ver [/system resource get version]
            :local major [:pick $ver 0 1]
            :local aa [/ip hotspot active find where user=$uname]
            :set active [:len $aa]
            :if ($active > 0) do={ :do { :set ip [/ip hotspot active get [:pick $aa 0] address] } on-error={} }
            :local hu [/ip hotspot user find where name=$uname]
            :if ([:len $hu] > 0) do={
                :set found 1
                :set source "hotspot"
                :local h [:pick $hu 0]
                :do { :set profile [/ip hotspot user get $h profile] } on-error={}
                :do { :if ([/ip hotspot user get $h disabled] = true) do={ :set disabled 1 } } on-error={}
            } else={
                :if ($major = "7") do={
                    :do {
                        :local uu [/user-manager user find where name=$uname]
                        :if ([:len $uu] > 0) do={
                            :set found 1
                            :set source "user-manager-v7"
                            :local u [:pick $uu 0]
                            :do { :set profile [/user-manager user get $u group] } on-error={}
                            :do { :if ([/user-manager user get $u disabled] = true) do={ :set disabled 1 } } on-error={}
                        }
                    } on-error={}
                } else={
                    :do {
                        :local uu [/tool user-manager user find where username=$uname]
                        :if ([:len $uu] > 0) do={
                            :set found 1
                            :set source "user-manager-v6"
                            :local u [:pick $uu 0]
                            :do { :set profile [/tool user-manager user get $u actual-profile] } on-error={}
                            :do { :if ([/tool user-manager user get $u disabled] = true) do={ :set disabled 1 } } on-error={}
                        }
                    } on-error={}
                }
            }
            :if (($found = 0) && ($active = 0)) do={
                :set body ("id=" . $cmdId . "\\nstatus=error\\nerror=user-not-found")
            } else={
                :set body ("id=" . $cmdId . "\\nstatus=ok\\nusername=" . $uname . "\\nsource=" . $source . "\\nprofile=" . $profile . "\\ndisabled=" . $disabled . "\\nactive=" . $active . "\\nip=" . $ip)
            }
        } on-error={ :set body ("id=" . $cmdId . "\\nstatus=error\\nerror=user-preview-failed") }
    }

    :if ($kind = "PRIV_PREVIEW_VLAN") do={
        :do {
            :local vid [:tonum $arg]
            :local vv [/interface vlan find where vlan-id=$vid]
            :if ([:len $vv] = 0) do={
                :set body ("id=" . $cmdId . "\\nstatus=error\\nerror=vlan-not-found")
            } else={
                :local v [:pick $vv 0]
                :local name [/interface vlan get $v name]
                :local parent [/interface vlan get $v interface]
                :local dis 0
                :if ([/interface vlan get $v disabled] = true) do={ :set dis 1 }
                :local affected 0
                :do {
                    :foreach hs in=[/ip hotspot find where interface=$name and disabled=no] do={
                        :local sn [/ip hotspot get $hs name]
                        :set affected ($affected + [:len [/ip hotspot active find where server=$sn]])
                    }
                } on-error={}
                :set body ("id=" . $cmdId . "\\nstatus=ok\\nvlan_id=" . $vid . "\\nname=" . $name . "\\nparent=" . $parent . "\\ndisabled=" . $dis . "\\naffected=" . $affected)
            }
        } on-error={ :set body ("id=" . $cmdId . "\\nstatus=error\\nerror=vlan-preview-failed") }
    }

    :if ($kind = "PRIV_DISCONNECT_USER") do={
        :do {
            :local changed 0
            :foreach a in=[/ip hotspot active find where user=$arg] do={ /ip hotspot active remove $a; :set changed ($changed + 1) }
            :set body ("id=" . $cmdId . "\\nstatus=ok\\ntarget=" . $arg . "\\nchanged=" . $changed)
        } on-error={ :set body ("id=" . $cmdId . "\\nstatus=error\\nerror=disconnect-failed") }
    }

    :if (($kind = "PRIV_DISABLE_USER") || ($kind = "PRIV_ENABLE_USER")) do={
        :do {
            :local uname $arg
            :local enable false
            :if ($kind = "PRIV_ENABLE_USER") do={ :set enable true }
            :local changed 0
            :local source ""
            :local hu [/ip hotspot user find where name=$uname]
            :if ([:len $hu] > 0) do={
                :local u [:pick $hu 0]
                :if ($enable = true) do={ /ip hotspot user enable $u } else={ /ip hotspot user disable $u }
                :set source "hotspot"
                :set changed 1
            } else={
                :local ver [/system resource get version]
                :local major [:pick $ver 0 1]
                :if ($major = "7") do={
                    :local uu [/user-manager user find where name=$uname]
                    :if ([:len $uu] > 0) do={
                        :local u [:pick $uu 0]
                        :if ($enable = true) do={ /user-manager user set $u disabled=no } else={ /user-manager user set $u disabled=yes }
                        :set source "user-manager-v7"
                        :set changed 1
                    }
                } else={
                    :local uu [/tool user-manager user find where username=$uname]
                    :if ([:len $uu] > 0) do={
                        :local u [:pick $uu 0]
                        :if ($enable = true) do={ /tool user-manager user enable $u } else={ /tool user-manager user disable $u }
                        :set source "user-manager-v6"
                        :set changed 1
                    }
                }
            }
            :if ($changed = 0) do={ :set body ("id=" . $cmdId . "\\nstatus=error\\nerror=user-not-found") } else={ :set body ("id=" . $cmdId . "\\nstatus=ok\\ntarget=" . $uname . "\\nsource=" . $source . "\\nchanged=1") }
        } on-error={ :set body ("id=" . $cmdId . "\\nstatus=error\\nerror=user-state-change-failed") }
    }

    :if (($kind = "PRIV_DISABLE_VLAN") || ($kind = "PRIV_ENABLE_VLAN")) do={
        :do {
            :local vid [:tonum $arg]
            :local vv [/interface vlan find where vlan-id=$vid]
            :if ([:len $vv] = 0) do={
                :set body ("id=" . $cmdId . "\\nstatus=error\\nerror=vlan-not-found")
            } else={
                :local v [:pick $vv 0]
                :if ($kind = "PRIV_ENABLE_VLAN") do={ /interface vlan enable $v } else={ /interface vlan disable $v }
                :local name [/interface vlan get $v name]
                :set body ("id=" . $cmdId . "\\nstatus=ok\\nvlan_id=" . $vid . "\\nname=" . $name . "\\nchanged=1")
            }
        } on-error={ :set body ("id=" . $cmdId . "\\nstatus=error\\nerror=vlan-state-change-failed") }
    }

`;

async function install(req: NextRequest) {
  const networkId = req.nextUrl.searchParams.get("network") || "";
  const installToken = req.nextUrl.searchParams.get("install") || "";
  const purpose = req.nextUrl.searchParams.get("purpose") === "readonly" ? "readonly" : "privileged";
  if (!networkId || !installToken) return new NextResponse("missing credentials", { status: 400 });

  const rows = await dbGet<InstallToken>("tg_agent_install_tokens", {
    network_id: `eq.${networkId}`,
    purpose: `eq.${purpose}`,
    token_hash: `eq.${hash(installToken)}`,
    used_at: "is.null",
    select: "*",
    order: "created_at.desc",
    limit: "1",
  });
  const tokenRow = rows[0];
  if (!tokenRow || new Date(tokenRow.expires_at).getTime() < Date.now()) {
    return new NextResponse("installer token expired or invalid", { status: 401 });
  }

  const networks = await dbGet<Network>("tg_networks", {
    id: `eq.${networkId}`,
    telegram_user_id: `eq.${tokenRow.telegram_user_id}`,
    connection_mode: "eq.agent",
    select: "id,telegram_user_id,connection_mode,agent_secret_ciphertext",
    limit: "1",
  });
  const network = networks[0];
  if (!network?.agent_secret_ciphertext) return new NextResponse("agent is not configured", { status: 409 });

  const agentSecret = decryptSecret(network.agent_secret_ciphertext);
  const internalUrl = new URL("/api/router-agent/install-v3", req.nextUrl.origin);
  internalUrl.searchParams.set("network", networkId);
  internalUrl.searchParams.set("token", agentSecret);
  const base = await v3Installer(new NextRequest(internalUrl));
  if (!base.ok) return base;
  let script = await base.text();

  if (purpose === "privileged") {
    script = script.replace('policy=read,test,sensitive source={', 'policy=read,write,test,sensitive source={');
    script = script.replace('policy=read,test,sensitive\n/system script run MT-TG-AGENT', 'policy=read,write,test,sensitive\n/system script run MT-TG-AGENT');
    const marker = `    :do {\n        /tool fetch url=$resultUrl http-method=post`;
    if (!script.includes(marker)) return new NextResponse("privileged installer template mismatch", { status: 500 });
    script = script.replace(marker, privilegedBlock + marker);
  }

  const activation = `${AGENT_BASE_URL}/api/router-agent/privileged?mode=activate&network=${encodeURIComponent(networkId)}&token=${encodeURIComponent(agentSecret)}&level=${purpose}`;
  script += `\n:do { /tool fetch url="${activation}" keep-result=no } on-error={ :log warning "MT-TG privilege activation callback failed" }\n`;

  await dbPatch("tg_agent_install_tokens", { used_at: new Date().toISOString() }, { id: `eq.${tokenRow.id}`, used_at: "is.null" });
  await dbPatch("tg_networks", { agent_privileged_requested_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { id: `eq.${networkId}` });

  return new NextResponse(script, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

async function activate(req: NextRequest) {
  const networkId = req.nextUrl.searchParams.get("network") || "";
  const token = req.nextUrl.searchParams.get("token") || "";
  const level = req.nextUrl.searchParams.get("level") === "readonly" ? "readonly" : "privileged";
  if (!networkId || !token) return new NextResponse("missing credentials", { status: 400 });
  const network = await authenticateAgent(networkId, token);
  if (!network) return new NextResponse("unauthorized", { status: 401 });
  const now = new Date().toISOString();
  await dbPatch("tg_networks", {
    agent_privileged_enabled: level === "privileged",
    agent_privileged_installed_at: now,
    agent_privileged_version: level === "privileged" ? "privileged-v1" : null,
    agent_last_seen_at: now,
    updated_at: now,
  }, { id: `eq.${networkId}` });
  return new NextResponse(level === "privileged" ? "PRIVILEGED_OK" : "READONLY_OK", {
    status: 200,
    headers: { "content-type": "text/plain", "cache-control": "no-store" },
  });
}

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get("mode") || "install";
  if (mode === "activate") return activate(req);
  return install(req);
}
