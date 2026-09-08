import { NextRequest, NextResponse } from "next/server";
import { GET as v1Installer } from "../install/route";
import { authenticateAgent } from "@/lib/router-agent";
import { dbPatch } from "@/lib/telegram-db";

export const runtime="nodejs";
export const dynamic="force-dynamic";

function replaceOnce(source:string,needle:string,replacement:string){if(!source.includes(needle))throw new Error(`user-admin-v2 template mismatch: ${needle.slice(0,60)}`);return source.replace(needle,replacement);}

export async function GET(req:NextRequest){
  if(req.nextUrl.searchParams.get("mode")==="activate"){
    const base=await v1Installer(req);if(!base.ok)return base;
    const network=req.nextUrl.searchParams.get("network")||"";const token=req.nextUrl.searchParams.get("token")||"";
    const auth=await authenticateAgent(network,token);if(!auth)return new NextResponse("unauthorized",{status:401});
    const now=new Date().toISOString();
    await dbPatch("tg_networks",{agent_user_admin_enabled:true,agent_user_admin_installed_at:now,agent_user_admin_version:"user-admin-v2",updated_at:now},{id:`eq.${network}`});
    return new NextResponse("USER_ADMIN_V2_OK");
  }

  const base=await v1Installer(req);if(!base.ok)return base;let script=await base.text();
  script=replaceOnce(script,"/api/router-agent/user-admin/result?network=","/api/router-agent/user-admin/result-v2?network=");
  script=replaceOnce(script,"/api/router-agent/user-admin/install?mode=activate&network=","/api/router-agent/user-admin/install-v2?mode=activate&network=");
  script=replaceOnce(script,'(($kind = "CHANGE_PROFILE") || ($kind = "CHANGE_PASSWORD") || ($kind = "DELETE_USER") || ($kind = "ADD_USER"))','(($kind = "CHANGE_PROFILE") || ($kind = "CHANGE_PASSWORD") || ($kind = "DELETE_USER") || ($kind = "ADD_USER") || ($kind = "RENEW_PROFILE"))');
  const marker='            :if ($kind != "DELETE_USER") do={ :set body ("id=" . $cmdId . "\\nstatus=ok\\nchanged=" . $changed) }';
  const renew='            :if ($kind = "RENEW_PROFILE") do={ :local np $a3; :if ($src = "user-manager-v6") do={ /tool user-manager user create-and-activate-profile customer=$a4 numbers=$uname profile=$np; :set changed 1 }; :if ($src = "user-manager-v7") do={ /user-manager user-profile add user=$uname profile=$np; :set changed 1 }; :if ($src = "hotspot") do={ :error "hotspot-renew-unsupported" } }\n';
  script=replaceOnce(script,marker,renew+marker);
  return new NextResponse(script,{status:200,headers:{"content-type":"text/plain; charset=utf-8","cache-control":"no-store"}});
}
