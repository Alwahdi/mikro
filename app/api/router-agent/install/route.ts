import { NextRequest, NextResponse } from "next/server";
import { AGENT_BASE_URL, authenticateAgent } from "@/lib/router-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function buildScript(networkId: string, token: string) {
  return `# MikroTik Telegram Cloud Agent
# Compatible with RouterOS 6.43+ and RouterOS 7.x
/system scheduler remove [find where name="MT-TG-AGENT-POLL"]
/system script remove [find where name="MT-TG-AGENT"]
/system script add name="MT-TG-AGENT" policy=read,write,test,sensitive source={
    :local network "${networkId}"
    :local token "${token}"
    :local base "${AGENT_BASE_URL}/api/router-agent"
    :local pollUrl ($base . "/poll?network=" . $network . "&token=" . $token)
    :local resultUrl ($base . "/result?network=" . $network . "&token=" . $token)
    :local data ""

    :do {
        :local r [/tool fetch url=$pollUrl as-value output=user]
        :set data ($r->"data")
    } on-error={
        :log warning "MT-TG Agent poll failed"
        :return
    }

    :if (($data = "") || ($data = "NONE")) do={ :return }
    :if ([:pick $data 0 4] != "CMD|") do={ :return }

    :local p1 [:find $data "|" 4]
    :if ($p1 = nil) do={ :return }
    :local cmdId [:pick $data 4 $p1]
    :local rest [:pick $data ($p1 + 1) [:len $data]]
    :local p2 [:find $rest "|"]
    :local kind $rest
    :local arg ""
    :if ($p2 != nil) do={
        :set kind [:pick $rest 0 $p2]
        :set arg [:pick $rest ($p2 + 1) [:len $rest]]
    }

    :local body ("id=" . $cmdId . "\nstatus=error\nerror=unknown-command")

    :if ($kind = "STATUS") do={
        :do {
            :local ident [/system identity get name]
            :local ver [/system resource get version]
            :local uptime [/system resource get uptime]
            :local cpu [/system resource get cpu-load]
            :local freeMem [/system resource get free-memory]
            :local totalMem [/system resource get total-memory]
            :local online [:len [/ip hotspot active find]]
            :local replies [/ping 8.8.8.8 count=3]
            :local ppp 0
            :do { :set ppp [:len [/interface pppoe-client find where running=yes and disabled=no]] } on-error={ :set ppp 0 }
            :set body ("id=" . $cmdId . "\nstatus=ok\nidentity=" . $ident . "\nversion=" . $ver . "\nuptime=" . $uptime . "\ncpu=" . $cpu . "\nfree_memory=" . $freeMem . "\ntotal_memory=" . $totalMem . "\nonline=" . $online . "\nping_replies=" . $replies . "\npppoe_running=" . $ppp)
        } on-error={
            :set body ("id=" . $cmdId . "\nstatus=error\nerror=status-read-failed")
        }
    }

    :if ($kind = "PING") do={
        :do {
            :local replies [/ping 8.8.8.8 count=5]
            :local loss ((5 - $replies) * 20)
            :set body ("id=" . $cmdId . "\nstatus=ok\nreplies=" . $replies . "\nloss=" . $loss)
        } on-error={
            :set body ("id=" . $cmdId . "\nstatus=error\nerror=ping-failed")
        }
    }

    :if ($kind = "VLAN") do={
        :do {
            :local vlanId [:tonum $arg]
            :local found [/interface vlan find where vlan-id=$vlanId and disabled=no]
            :if ([:len $found] = 0) do={
                :set body ("id=" . $cmdId . "\nstatus=error\nerror=vlan-not-found")
            } else={
                :local vi [:pick $found 0]
                :local vn [/interface vlan get $vi name]
                :local ii [/interface find where name=$vn]
                :local rx 0
                :local tx 0
                :if ([:len $ii] > 0) do={
                    :set rx [/interface get [:pick $ii 0] rx-byte]
                    :set tx [/interface get [:pick $ii 0] tx-byte]
                }
                :local online 0
                :do { :set online [:len [/ip hotspot active find where server=$vn]] } on-error={ :set online 0 }
                :set body ("id=" . $cmdId . "\nstatus=ok\nvlan_id=" . $vlanId . "\nname=" . $vn . "\nrx=" . $rx . "\ntx=" . $tx . "\nonline=" . $online)
            }
        } on-error={
            :set body ("id=" . $cmdId . "\nstatus=error\nerror=vlan-read-failed")
        }
    }

    :if ($kind = "SALES") do={
        :local ver [/system resource get version]
        :local major [:pick $ver 0 1]
        :local today [/system clock get date]
        :local dlen [:len $today]
        :local seen "|"
        :local sales 0
        :local cards ""
        :local failed false

        :if ($major = "7") do={
            :do {
                :foreach s in=[/user-manager session find where started~$today] do={
                    :local uname [/user-manager session get $s user]
                    :local marker ("|" . $uname . "|")
                    :if ([:find $seen $marker] = nil) do={
                        :set seen ($seen . $uname . "|")
                        :local old false
                        :foreach os in=[/user-manager session find where user=$uname] do={
                            :local ot [/user-manager session get $os started]
                            :if (([:len $ot] >= $dlen) && ([:pick $ot 0 $dlen] != $today)) do={ :set old true; :break }
                        }
                        :if ($old = false) do={
                            :set sales ($sales + 1)
                            :if ($sales <= 30) do={
                                :if ([:len $cards] > 0) do={ :set cards ($cards . ",") }
                                :set cards ($cards . $uname)
                            }
                        }
                    }
                }
            } on-error={ :set failed true }
        } else={
            :do {
                :foreach s in=[/tool user-manager session find where from-time~$today] do={
                    :local uname [/tool user-manager session get $s user]
                    :local marker ("|" . $uname . "|")
                    :if ([:find $seen $marker] = nil) do={
                        :set seen ($seen . $uname . "|")
                        :local old false
                        :foreach os in=[/tool user-manager session find where user=$uname] do={
                            :local ot [/tool user-manager session get $os from-time]
                            :if (([:len $ot] >= $dlen) && ([:pick $ot 0 $dlen] != $today)) do={ :set old true; :break }
                        }
                        :if ($old = false) do={
                            :set sales ($sales + 1)
                            :if ($sales <= 30) do={
                                :if ([:len $cards] > 0) do={ :set cards ($cards . ",") }
                                :set cards ($cards . $uname)
                            }
                        }
                    }
                }
            } on-error={ :set failed true }
        }

        :if ($failed = true) do={
            :set body ("id=" . $cmdId . "\nstatus=error\nerror=user-manager-unavailable")
        } else={
            :set body ("id=" . $cmdId . "\nstatus=ok\ncount=" . $sales . "\ncards=" . $cards)
        }
    }

    :do {
        /tool fetch url=$resultUrl http-method=post http-header-field="Content-Type:text/plain" http-data=$body keep-result=no
    } on-error={
        :log warning "MT-TG Agent result upload failed"
    }
}
/system scheduler add name="MT-TG-AGENT-POLL" interval=15s start-time=startup on-event="/system script run MT-TG-AGENT" policy=read,write,test,sensitive
/system script run MT-TG-AGENT
:put "MT-TG Agent installed successfully"
`;
}

export async function GET(req: NextRequest) {
  const networkId = req.nextUrl.searchParams.get("network") || "";
  const token = req.nextUrl.searchParams.get("token") || "";
  if (!networkId || !token) return new NextResponse("missing credentials", { status: 400 });

  const network = await authenticateAgent(networkId, token);
  if (!network) return new NextResponse("unauthorized", { status: 401 });

  return new NextResponse(buildScript(networkId, token), {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
