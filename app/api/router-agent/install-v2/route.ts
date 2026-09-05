import { NextRequest, NextResponse } from "next/server";
import { GET as baseInstaller } from "../install/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cardBlock = `
    :if ($kind = "CARD") do={
        :local uname $arg
        :local found false
        :local profile "-"
        :local sessionCount 0
        :local firstSession ""
        :local lastSession ""
        :local totalDown 0
        :local totalUp 0
        :local sessionItems ""
        :local itemCount 0
        :local active 0
        :local currentIp ""
        :local currentMac ""
        :local currentServer ""
        :local currentUptime ""
        :local failed false

        :do {
            :local aa [/ip hotspot active find where user=$uname]
            :if ([:len $aa] > 0) do={
                :local a [:pick $aa 0]
                :set active 1
                :set found true
                :do { :set currentIp [/ip hotspot active get $a address] } on-error={}
                :do { :set currentMac [/ip hotspot active get $a mac-address] } on-error={}
                :do { :set currentServer [/ip hotspot active get $a server] } on-error={}
                :do { :set currentUptime [/ip hotspot active get $a uptime] } on-error={}
            }
        } on-error={}

        :local ver [/system resource get version]
        :local major [:pick $ver 0 1]

        :if ($major = "7") do={
            :do {
                :local uu [/user-manager user find where name=$uname]
                :if ([:len $uu] > 0) do={
                    :set found true
                    :local u [:pick $uu 0]
                    :do { :set profile [/user-manager user get $u group] } on-error={}
                }

                :foreach s in=[/user-manager session find where user=$uname] do={
                    :set found true
                    :set sessionCount ($sessionCount + 1)
                    :local st ""
                    :local up ""
                    :local ip ""
                    :local cause ""
                    :local dl 0
                    :local ul 0
                    :do { :set st [/user-manager session get $s started] } on-error={}
                    :do { :set up [/user-manager session get $s uptime] } on-error={}
                    :do { :set ip [/user-manager session get $s user-address] } on-error={}
                    :do { :set cause [/user-manager session get $s terminate-cause] } on-error={}
                    :do { :set dl [:tonum [/user-manager session get $s download]] } on-error={ :set dl 0 }
                    :do { :set ul [:tonum [/user-manager session get $s upload]] } on-error={ :set ul 0 }
                    :set totalDown ($totalDown + $dl)
                    :set totalUp ($totalUp + $ul)
                    :if ([:len $firstSession] = 0) do={ :set firstSession $st }
                    :set lastSession $st
                    :if ($itemCount < 10) do={
                        :if ([:len $sessionItems] > 0) do={ :set sessionItems ($sessionItems . ";") }
                        :set sessionItems ($sessionItems . $st . "@" . $up . "@" . $ip . "@" . $cause)
                        :set itemCount ($itemCount + 1)
                    }
                }
            } on-error={ :set failed true }
        } else={
            :do {
                :local uu [/tool user-manager user find where username=$uname]
                :if ([:len $uu] > 0) do={
                    :set found true
                    :local u [:pick $uu 0]
                    :do { :set profile [/tool user-manager user get $u actual-profile] } on-error={}
                }

                :foreach s in=[/tool user-manager session find where user=$uname] do={
                    :set found true
                    :set sessionCount ($sessionCount + 1)
                    :local st ""
                    :local up ""
                    :local ip ""
                    :local cause ""
                    :local dl 0
                    :local ul 0
                    :do { :set st [/tool user-manager session get $s from-time] } on-error={}
                    :do { :set up [/tool user-manager session get $s uptime] } on-error={}
                    :do { :set ip [/tool user-manager session get $s user-ip] } on-error={}
                    :do { :set cause [/tool user-manager session get $s terminate-cause] } on-error={}
                    :do { :set dl [:tonum [/tool user-manager session get $s download]] } on-error={ :set dl 0 }
                    :do { :set ul [:tonum [/tool user-manager session get $s upload]] } on-error={ :set ul 0 }
                    :set totalDown ($totalDown + $dl)
                    :set totalUp ($totalUp + $ul)
                    :if ([:len $firstSession] = 0) do={ :set firstSession $st }
                    :set lastSession $st
                    :if ($itemCount < 10) do={
                        :if ([:len $sessionItems] > 0) do={ :set sessionItems ($sessionItems . ";") }
                        :set sessionItems ($sessionItems . $st . "@" . $up . "@" . $ip . "@" . $cause)
                        :set itemCount ($itemCount + 1)
                    }
                }
            } on-error={ :set failed true }
        }

        :if (($found = false) && ($failed = false)) do={
            :do {
                :local hu [/ip hotspot user find where name=$uname]
                :if ([:len $hu] > 0) do={
                    :set found true
                    :local h [:pick $hu 0]
                    :do { :set profile [/ip hotspot user get $h profile] } on-error={}
                }
            } on-error={}
        }

        :if ($found = false) do={
            :set body ("id=" . $cmdId . "\\nstatus=error\\nerror=card-not-found")
        } else={
            :set body ("id=" . $cmdId . "\\nstatus=ok\\nusername=" . $uname . "\\nprofile=" . $profile . "\\nactive=" . $active . "\\nsession_count=" . $sessionCount . "\\nfirst_session=" . $firstSession . "\\nlast_session=" . $lastSession . "\\ndownload=" . $totalDown . "\\nupload=" . $totalUp . "\\ncurrent_ip=" . $currentIp . "\\ncurrent_mac=" . $currentMac . "\\ncurrent_server=" . $currentServer . "\\ncurrent_uptime=" . $currentUptime . "\\nsessions=" . $sessionItems)
        }
    }

`;

export async function GET(req: NextRequest) {
  const response = await baseInstaller(req);
  if (!response.ok) return response;

  let script = await response.text();

  // RouterOS 6.43 introduced fetch as-value, while http-header-field arrived in
  // 6.44. The result endpoint reads raw text, so no custom header is necessary.
  script = script.replace(' http-header-field="Content-Type:text/plain"', "");

  // Inject the CARD command before the common result-upload block. This keeps
  // the base Agent small and lets this compatibility wrapper evolve safely.
  const marker = `    :do {\n        /tool fetch url=$resultUrl http-method=post`;
  if (!script.includes(marker)) {
    return new NextResponse("agent installer template mismatch", { status: 500 });
  }
  script = script.replace(marker, cardBlock + marker);

  return new NextResponse(script, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
