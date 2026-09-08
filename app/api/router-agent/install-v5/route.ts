import { NextRequest, NextResponse } from "next/server";
import { GET as v4Installer } from "../install-v4/route";

export const runtime="nodejs";
export const dynamic="force-dynamic";

const usersBlock=`
    :if ($kind = "USERS") do={
        :do {
            :local q $4; :local items ""; :local total 0; :local matched 0; :local count 0
            :foreach u in=[/ip hotspot user find] do={
                :set total ($total + 1); :local nm [/ip hotspot user get $u name]; :local ok 0
                :if ([:len $q] = 0) do={ :set ok 1 } else={ :local p [:find $nm $q]; :if ([:typeof $p] != "nil") do={ :set ok 1 } }
                :if ($ok = 1) do={
                    :set matched ($matched + 1)
                    :if ($count < 50) do={ :local prof ""; :local ds 0; :do { :set prof [/ip hotspot user get $u profile] } on-error={}; :do { :if ([/ip hotspot user get $u disabled] = true) do={ :set ds 1 } } on-error={}; :if ([:len $items] > 0) do={ :set items ($items . ";") }; :set items ($items . "H~" . $nm . "~" . $prof . "~" . $ds); :set count ($count + 1) }
                }
            }
            :do {
                :foreach u in=[/tool user-manager user find] do={
                    :set total ($total + 1); :local nm [/tool user-manager user get $u username]; :local ok 0
                    :if ([:len $q] = 0) do={ :set ok 1 } else={ :local p [:find $nm $q]; :if ([:typeof $p] != "nil") do={ :set ok 1 } }
                    :if ($ok = 1) do={
                        :set matched ($matched + 1)
                        :if ($count < 50) do={ :local prof ""; :local ds 0; :do { :set prof [/tool user-manager user get $u actual-profile] } on-error={}; :do { :if ([/tool user-manager user get $u disabled] = true) do={ :set ds 1 } } on-error={}; :if ([:len $items] > 0) do={ :set items ($items . ";") }; :set items ($items . "V6~" . $nm . "~" . $prof . "~" . $ds); :set count ($count + 1) }
                    }
                }
            } on-error={}
            :do {
                :foreach u in=[/user-manager user find] do={
                    :set total ($total + 1); :local nm [/user-manager user get $u name]; :local ok 0
                    :if ([:len $q] = 0) do={ :set ok 1 } else={ :local p [:find $nm $q]; :if ([:typeof $p] != "nil") do={ :set ok 1 } }
                    :if ($ok = 1) do={
                        :set matched ($matched + 1)
                        :if ($count < 50) do={ :local prof ""; :local ds 0; :do { :set prof [/user-manager user get $u group] } on-error={}; :do { :if ([/user-manager user get $u disabled] = true) do={ :set ds 1 } } on-error={}; :if ([:len $items] > 0) do={ :set items ($items . ";") }; :set items ($items . "V7~" . $nm . "~" . $prof . "~" . $ds); :set count ($count + 1) }
                    }
                }
            } on-error={}
            :set body ("id=" . $cmdId . "\\nstatus=ok\\ntotal=" . $total . "\\nmatched=" . $matched . "\\nitems=" . $items)
        } on-error={ :set body ("id=" . $cmdId . "\\nstatus=error\\nerror=users-read-failed") }
    }

`;

export async function GET(req:NextRequest){
  const response=await v4Installer(req);if(!response.ok)return response;
  let script=await response.text();
  script=script.replace('"/result-v4?network="','"/result-v5?network="');
  const poll=':local pollUrl ($base . "/poll?network=" . $network . "&token=" . $token . "&v=4")';
  const pollV5=':local pollUrl ($base . "/poll?network=" . $network . "&token=" . $token . "&v=5")';
  if(!script.includes(poll))return new NextResponse("agent v5 poll template mismatch",{status:500});
  script=script.replace(poll,pollV5);
  const marker=`    :do {\n        /tool fetch url=$resultUrl http-method=post`;
  if(!script.includes(marker))return new NextResponse("agent v5 installer template mismatch",{status:500});
  script=script.replace(marker,usersBlock+marker);
  return new NextResponse(script,{status:200,headers:{"content-type":"text/plain; charset=utf-8","cache-control":"no-store"}});
}
