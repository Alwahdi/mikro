import { NextRequest, NextResponse } from "next/server";
import { GET as v2Installer } from "../install-v2/route";

export const runtime="nodejs";
export const dynamic="force-dynamic";

const opsBlock=`
    :if ($kind = "LOGS") do={
        :do {
            :local ids [/log find]
            :local n [:len $ids]
            :local start ($n - 25)
            :if ($start < 0) do={ :set start 0 }
            :local items ""
            :if ($n > 0) do={
                :for i from=$start to=($n - 1) do={
                    :local l [:pick $ids $i]
                    :local tm [/log get $l time]
                    :local tp [/log get $l topics]
                    :local msg [/log get $l message]
                    :if ([:len $msg] > 180) do={ :set msg [:pick $msg 0 180] }
                    :if ([:len $items] > 0) do={ :set items ($items . ";") }
                    :set items ($items . $tm . "@" . $tp . "@" . $msg)
                }
            }
            :set body ("id=" . $cmdId . "\\nstatus=ok\\nitems=" . $items)
        } on-error={ :set body ("id=" . $cmdId . "\\nstatus=error\\nerror=logs-read-failed") }
    }

    :if ($kind = "INTERFACES") do={
        :do {
            :local total 0
            :local running 0
            :local count 0
            :local items ""
            :foreach i in=[/interface find] do={
                :set total ($total + 1)
                :local rn 0
                :local ds 0
                :do { :if ([/interface get $i running] = true) do={ :set rn 1; :set running ($running + 1) } } on-error={}
                :do { :if ([/interface get $i disabled] = true) do={ :set ds 1 } } on-error={}
                :if ($count < 50) do={
                    :local nm [/interface get $i name]
                    :local tp [/interface get $i type]
                    :local mtu "-"
                    :do { :set mtu [/interface get $i actual-mtu] } on-error={}
                    :if ([:len $items] > 0) do={ :set items ($items . ";") }
                    :set items ($items . $nm . "@" . $tp . "@" . $rn . "@" . $ds . "@" . $mtu)
                    :set count ($count + 1)
                }
            }
            :set body ("id=" . $cmdId . "\\nstatus=ok\\ntotal=" . $total . "\\nrunning=" . $running . "\\nitems=" . $items)
        } on-error={ :set body ("id=" . $cmdId . "\\nstatus=error\\nerror=interfaces-read-failed") }
    }

    :if ($kind = "DHCP") do={
        :do {
            :local total 0
            :local bound 0
            :local count 0
            :local items ""
            :foreach l in=[/ip dhcp-server lease find] do={
                :set total ($total + 1)
                :local st [/ip dhcp-server lease get $l status]
                :if ($st = "bound") do={
                    :set bound ($bound + 1)
                    :if ($count < 50) do={
                        :local ip [/ip dhcp-server lease get $l address]
                        :local mac [/ip dhcp-server lease get $l mac-address]
                        :local host ""
                        :local srv ""
                        :do { :set host [/ip dhcp-server lease get $l host-name] } on-error={}
                        :do { :set srv [/ip dhcp-server lease get $l server] } on-error={}
                        :if ([:len $items] > 0) do={ :set items ($items . ";") }
                        :set items ($items . $ip . "@" . $mac . "@" . $host . "@" . $srv)
                        :set count ($count + 1)
                    }
                }
            }
            :set body ("id=" . $cmdId . "\\nstatus=ok\\ntotal=" . $total . "\\nbound=" . $bound . "\\nitems=" . $items)
        } on-error={ :set body ("id=" . $cmdId . "\\nstatus=error\\nerror=dhcp-read-failed") }
    }

    :if ($kind = "HOTSPOT") do={
        :do {
            :local sc 0
            :local ac 0
            :local uc 0
            :local dc 0
            :local items ""
            :local count 0
            :do { :set ac [:len [/ip hotspot active find]] } on-error={}
            :do { :set uc [:len [/ip hotspot user find]] } on-error={}
            :foreach u in=[/ip hotspot user find] do={ :do { :if ([/ip hotspot user get $u disabled] = true) do={ :set dc ($dc + 1) } } on-error={} }
            :foreach s in=[/ip hotspot find] do={
                :set sc ($sc + 1)
                :if ($count < 30) do={
                    :local nm [/ip hotspot get $s name]
                    :local intf [/ip hotspot get $s interface]
                    :local ds 0
                    :do { :if ([/ip hotspot get $s disabled] = true) do={ :set ds 1 } } on-error={}
                    :if ([:len $items] > 0) do={ :set items ($items . ";") }
                    :set items ($items . $nm . "@" . $intf . "@" . $ds)
                    :set count ($count + 1)
                }
            }
            :set body ("id=" . $cmdId . "\\nstatus=ok\\nservers=" . $sc . "\\nactive=" . $ac . "\\nusers=" . $uc . "\\ndisabled=" . $dc . "\\nitems=" . $items)
        } on-error={ :set body ("id=" . $cmdId . "\\nstatus=error\\nerror=hotspot-read-failed") }
    }

    :if ($kind = "TOP_USAGE") do={
        :do {
            :local items ""
            :local count 0
            :foreach a in=[/ip hotspot active find] do={
                :if ($count < 50) do={
                    :local u [/ip hotspot active get $a user]
                    :local ip [/ip hotspot active get $a address]
                    :local srv [/ip hotspot active get $a server]
                    :local bi 0
                    :local bo 0
                    :do { :set bi [:tonum [/ip hotspot active get $a bytes-in]] } on-error={}
                    :do { :set bo [:tonum [/ip hotspot active get $a bytes-out]] } on-error={}
                    :local total ($bi + $bo)
                    :if ([:len $items] > 0) do={ :set items ($items . ";") }
                    :set items ($items . $u . "@" . $ip . "@" . $srv . "@" . $total)
                    :set count ($count + 1)
                }
            }
            :set body ("id=" . $cmdId . "\\nstatus=ok\\nitems=" . $items)
        } on-error={ :set body ("id=" . $cmdId . "\\nstatus=error\\nerror=usage-read-failed") }
    }

`;

export async function GET(req:NextRequest){
  const response=await v2Installer(req);if(!response.ok)return response;
  let script=await response.text();
  script=script.replace('"/result?network="','"/result-v2?network="');
  const marker=`    :do {\n        /tool fetch url=$resultUrl http-method=post`;
  if(!script.includes(marker))return new NextResponse("agent v3 installer template mismatch",{status:500});
  script=script.replace(marker,opsBlock+marker);
  return new NextResponse(script,{status:200,headers:{"content-type":"text/plain; charset=utf-8","cache-control":"no-store"}});
}
