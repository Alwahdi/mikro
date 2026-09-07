import { NextRequest, NextResponse } from "next/server";
import { GET as v3Installer } from "../install-v3/route";

export const runtime="nodejs";
export const dynamic="force-dynamic";

const networkOpsBlock=`
    :if ($kind = "WAN") do={
        :do {
            :local pt 0; :local pr 0; :local dt 0; :local db 0; :local dr 0; :local ar 0; :local items ""; :local count 0
            :foreach p in=[/interface pppoe-client find] do={
                :set pt ($pt + 1); :local rn 0; :local ds 0
                :do { :if ([/interface pppoe-client get $p running] = true) do={ :set rn 1; :set pr ($pr + 1) } } on-error={}
                :do { :if ([/interface pppoe-client get $p disabled] = true) do={ :set ds 1 } } on-error={}
                :if ($count < 20) do={ :local nm [/interface pppoe-client get $p name]; :local intf [/interface pppoe-client get $p interface]; :if ([:len $items] > 0) do={ :set items ($items . ";") }; :set items ($items . "ppp:" . $nm . "@" . $intf . "@" . $rn . "@" . $ds); :set count ($count + 1) }
            }
            :foreach d in=[/ip dhcp-client find] do={
                :set dt ($dt + 1); :local st ""; :local addr ""; :local gw ""; :local intf [/ip dhcp-client get $d interface]
                :do { :set st [/ip dhcp-client get $d status] } on-error={}; :if ($st = "bound") do={ :set db ($db + 1) }
                :do { :set addr [/ip dhcp-client get $d address] } on-error={}; :do { :set gw [/ip dhcp-client get $d gateway] } on-error={}
                :if ($count < 35) do={ :if ([:len $items] > 0) do={ :set items ($items . ";") }; :set items ($items . "dhcp:" . $intf . "@" . $st . "@" . $addr . "@" . $gw); :set count ($count + 1) }
            }
            :foreach r in=[/ip route find where dst-address="0.0.0.0/0"] do={ :set dr ($dr + 1); :do { :if ([/ip route get $r active] = true) do={ :set ar ($ar + 1) } } on-error={} }
            :set body ("id=" . $cmdId . "\\nstatus=ok\\nppp_total=" . $pt . "\\nppp_running=" . $pr . "\\ndhcp_total=" . $dt . "\\ndhcp_bound=" . $db . "\\ndefault_routes=" . $dr . "\\nactive_defaults=" . $ar . "\\nitems=" . $items)
        } on-error={ :set body ("id=" . $cmdId . "\\nstatus=error\\nerror=wan-read-failed") }
    }

    :if ($kind = "ROUTES") do={
        :do {
            :local total 0; :local active 0; :local items ""; :local count 0
            :foreach r in=[/ip route find] do={
                :set total ($total + 1); :local ac 0; :local ds 0; :local dy 0
                :do { :if ([/ip route get $r active] = true) do={ :set ac 1; :set active ($active + 1) } } on-error={}
                :do { :if ([/ip route get $r disabled] = true) do={ :set ds 1 } } on-error={}
                :do { :if ([/ip route get $r dynamic] = true) do={ :set dy 1 } } on-error={}
                :if ($count < 50) do={ :local dst [/ip route get $r dst-address]; :local gw ""; :local dist ""; :do { :set gw [/ip route get $r gateway] } on-error={}; :do { :set dist [/ip route get $r distance] } on-error={}; :if ([:len $items] > 0) do={ :set items ($items . ";") }; :set items ($items . $dst . "@" . $gw . "@" . $dist . "@" . $ac . "@" . $ds . "@" . $dy); :set count ($count + 1) }
            }
            :set body ("id=" . $cmdId . "\\nstatus=ok\\ntotal=" . $total . "\\nactive=" . $active . "\\nitems=" . $items)
        } on-error={ :set body ("id=" . $cmdId . "\\nstatus=error\\nerror=routes-read-failed") }
    }

    :if ($kind = "DNS") do={
        :do {
            :local servers ""; :local dyn ""; :local remote "false"; :local resolved ""
            :do { :set servers [/ip dns get servers] } on-error={}; :do { :set dyn [/ip dns get dynamic-servers] } on-error={}; :do { :set remote [/ip dns get allow-remote-requests] } on-error={}; :do { :set resolved [:resolve google.com] } on-error={}
            :set body ("id=" . $cmdId . "\\nstatus=ok\\nservers=" . $servers . "\\ndynamic=" . $dyn . "\\nremote=" . $remote . "\\nresolved=" . $resolved)
        } on-error={ :set body ("id=" . $cmdId . "\\nstatus=error\\nerror=dns-read-failed") }
    }

    :if ($kind = "FIREWALL") do={
        :do {
            :local filter 0; :local nat 0; :local mangle 0; :local raw 0; :local al 0
            :do { :set filter [:len [/ip firewall filter find]] } on-error={}; :do { :set nat [:len [/ip firewall nat find]] } on-error={}; :do { :set mangle [:len [/ip firewall mangle find]] } on-error={}; :do { :set raw [:len [/ip firewall raw find]] } on-error={}; :do { :set al [:len [/ip firewall address-list find]] } on-error={}
            :set body ("id=" . $cmdId . "\\nstatus=ok\\nfilter=" . $filter . "\\nnat=" . $nat . "\\nmangle=" . $mangle . "\\nraw=" . $raw . "\\naddress_lists=" . $al)
        } on-error={ :set body ("id=" . $cmdId . "\\nstatus=error\\nerror=firewall-read-failed") }
    }

    :if ($kind = "QUEUES") do={
        :do {
            :local total 0; :local enabled 0; :local trees 0; :local items ""; :local count 0
            :foreach q in=[/queue simple find] do={
                :set total ($total + 1); :local ds 0; :do { :if ([/queue simple get $q disabled] = true) do={ :set ds 1 } } on-error={}; :if ($ds = 0) do={ :set enabled ($enabled + 1) }
                :if ($count < 35) do={ :local nm [/queue simple get $q name]; :local target ""; :local max ""; :do { :set target [/queue simple get $q target] } on-error={}; :do { :set max [/queue simple get $q max-limit] } on-error={}; :if ([:len $items] > 0) do={ :set items ($items . ";") }; :set items ($items . $nm . "@" . $target . "@" . $max . "@" . $ds); :set count ($count + 1) }
            }
            :do { :set trees [:len [/queue tree find]] } on-error={}
            :set body ("id=" . $cmdId . "\\nstatus=ok\\ntotal=" . $total . "\\nenabled=" . $enabled . "\\ntrees=" . $trees . "\\nitems=" . $items)
        } on-error={ :set body ("id=" . $cmdId . "\\nstatus=error\\nerror=queues-read-failed") }
    }

`;

export async function GET(req:NextRequest){const response=await v3Installer(req);if(!response.ok)return response;let script=await response.text();script=script.replace('"/result-v2?network="','"/result-v4?network="');const marker=`    :do {\n        /tool fetch url=$resultUrl http-method=post`;if(!script.includes(marker))return new NextResponse("agent v4 installer template mismatch",{status:500});script=script.replace(marker,networkOpsBlock+marker);return new NextResponse(script,{status:200,headers:{"content-type":"text/plain; charset=utf-8","cache-control":"no-store"}});}
