import { decryptSecret } from "./telegram-crypto";
import { dbGet, dbInsert, dbUpsert } from "./telegram-db";
import { RouterOSClient } from "./routeros-api";
import type { TgUpdate } from "./telegram-extra";

type BotUser = {
  telegram_user_id: number;
  setup_state: string;
  active_network_id?: string | null;
};

type Network = {
  id: string;
  telegram_user_id: number;
  label: string;
  connection_mode: "direct" | "agent";
  host?: string | null;
  port?: number | null;
  username?: string | null;
  password_ciphertext?: string | null;
  protocol: "api" | "api-ssl";
  tls_verify: boolean;
  identity?: string | null;
  router_os_version?: string | null;
  agent_last_seen_at?: string | null;
  capabilities?: Record<string, unknown> | null;
};

type MemoryRow = {
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type GatewayMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

type AgentCommandRow = {
  id: string;
  status: "pending" | "claimed" | "success" | "error" | "expired";
  result?: Record<string, unknown> | null;
  error?: string | null;
};

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
const FAST_MODEL = "openai/gpt-5.5-fast";

function esc(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function botToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing");
  return token;
}

async function send(chatId: number, text: string) {
  const response = await fetch(`https://api.telegram.org/bot${botToken()}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: esc(text).slice(0, 4000),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
    cache: "no-store",
  });
  const json = await response.json();
  if (!json.ok) throw new Error(json.description || `Telegram ${response.status}`);
  return json.result;
}

async function sendTyping(chatId: number) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken()}/sendChatAction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
      cache: "no-store",
    });
  } catch {}
}

function gatewayCredential() {
  return process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || "";
}

async function gatewayChat(messages: GatewayMessage[], tools: unknown[]) {
  const credential = gatewayCredential();
  if (!credential) throw new Error("AI Gateway credentials are unavailable");

  const response = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: FAST_MODEL,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.1,
      max_tokens: 1800,
    }),
    cache: "no-store",
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(`AI Gateway ${response.status}: ${json?.error?.message || JSON.stringify(json).slice(0, 300)}`);
  }
  const message = json?.choices?.[0]?.message;
  if (!message) throw new Error("AI Gateway returned no assistant message");
  return message as GatewayMessage;
}

async function ensureUser(updateUser: {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
}) {
  await dbUpsert(
    "tg_users",
    {
      telegram_user_id: updateUser.id,
      username: updateUser.username ?? null,
      first_name: updateUser.first_name ?? null,
      last_name: updateUser.last_name ?? null,
      language_code: updateUser.language_code ?? null,
      updated_at: new Date().toISOString(),
    },
    "telegram_user_id",
  );
  const rows = await dbGet<BotUser>("tg_users", {
    telegram_user_id: `eq.${updateUser.id}`,
    select: "telegram_user_id,setup_state,active_network_id",
    limit: "1",
  });
  return rows[0] ?? null;
}

async function activeNetwork(user: BotUser) {
  if (user.active_network_id) {
    const rows = await dbGet<Network>("tg_networks", {
      id: `eq.${user.active_network_id}`,
      telegram_user_id: `eq.${user.telegram_user_id}`,
      select: "*",
      limit: "1",
    });
    if (rows[0]) return rows[0];
  }
  const rows = await dbGet<Network>("tg_networks", {
    telegram_user_id: `eq.${user.telegram_user_id}`,
    select: "*",
    order: "created_at.asc",
    limit: "1",
  });
  return rows[0] ?? null;
}

function clientFor(network: Network) {
  if (
    network.connection_mode !== "direct" ||
    !network.host ||
    !network.port ||
    !network.username ||
    !network.password_ciphertext
  ) {
    throw new Error("Direct API credentials are incomplete");
  }
  return new RouterOSClient({
    host: network.host,
    port: network.port,
    username: network.username,
    password: decryptSecret(network.password_ciphertext),
    tls: network.protocol === "api-ssl",
    rejectUnauthorized: network.tls_verify,
    timeoutMs: 15000,
  });
}

function safeHost(value: unknown) {
  const host = String(value || "8.8.8.8").trim();
  if (!/^[a-zA-Z0-9.-]{1,253}$/.test(host)) throw new Error("Invalid ping target");
  return host;
}

function asNumber(value: unknown) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function bytesText(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(2)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(2)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

async function directStatus(network: Network) {
  const client = clientFor(network);
  try {
    const [resource, identity, ping] = await Promise.all([
      client.command("/system/resource/print"),
      client.command("/system/identity/print"),
      client.command("/ping", ["=address=8.8.8.8", "=count=3"]),
    ]);
    let online: Record<string, string>[] = [];
    let ppp: Record<string, string>[] = [];
    try { online = await client.command("/ip/hotspot/active/print", ["=.proplist=.id"]); } catch {}
    try { ppp = await client.command("/interface/pppoe-client/print", ["=.proplist=name,running,disabled"]); } catch {}
    const r = resource[0] || {};
    const total = asNumber(r["total-memory"]);
    const free = asNumber(r["free-memory"]);
    return {
      identity: identity[0]?.name || network.label,
      router_os: r.version || network.router_os_version || null,
      board: r["board-name"] || r.platform || null,
      uptime: r.uptime || null,
      cpu_percent: asNumber(r["cpu-load"]),
      memory_used_percent: total > 0 ? Math.round((1 - free / total) * 100) : null,
      internet_ping_replies: ping.length,
      internet_ok: ping.length > 0,
      hotspot_online_users: online.length,
      running_pppoe_clients: ppp.filter((x) => x.running === "true" && x.disabled !== "true").map((x) => x.name),
    };
  } finally {
    client.close();
  }
}

async function directPing(network: Network, args: Record<string, unknown>) {
  const client = clientFor(network);
  try {
    const address = safeHost(args.address);
    const count = Math.max(1, Math.min(5, Number(args.count || 5)));
    const rows = await client.command("/ping", [`=address=${address}`, `=count=${count}`]);
    const times = rows
      .map((row) => parseFloat(String(row.time || "").replace("ms", "")))
      .filter(Number.isFinite);
    return {
      address,
      sent: count,
      received: rows.length,
      packet_loss_percent: Math.round(((count - rows.length) / count) * 100),
      average_ms: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
      min_ms: times.length ? Math.min(...times) : null,
      max_ms: times.length ? Math.max(...times) : null,
    };
  } finally {
    client.close();
  }
}

async function directOnline(network: Network, args: Record<string, unknown>) {
  const client = clientFor(network);
  try {
    const rows = await client.command("/ip/hotspot/active/print", [
      "=.proplist=user,address,mac-address,uptime,server,bytes-in,bytes-out,session-time-left",
    ]);
    const search = String(args.search || "").trim().toLowerCase();
    const filtered = search
      ? rows.filter((row) => [row.user, row.address, row["mac-address"], row.server].some((v) => String(v || "").toLowerCase().includes(search)))
      : rows;
    const limit = Math.max(1, Math.min(50, Number(args.limit || 20)));
    return {
      total_online: rows.length,
      matched: filtered.length,
      users: filtered.slice(0, limit).map((row) => ({
        username: row.user || null,
        ip: row.address || null,
        mac: row["mac-address"] || null,
        uptime: row.uptime || null,
        hotspot_server: row.server || null,
        bytes_in: asNumber(row["bytes-in"]),
        bytes_out: asNumber(row["bytes-out"]),
        session_time_left: row["session-time-left"] || null,
      })),
    };
  } finally {
    client.close();
  }
}

async function directRouterInfo(network: Network) {
  const client = clientFor(network);
  try {
    const [resource, identity] = await Promise.all([
      client.command("/system/resource/print"),
      client.command("/system/identity/print"),
    ]);
    let clock: Record<string, string>[] = [];
    try { clock = await client.command("/system/clock/print"); } catch {}
    const r = resource[0] || {};
    return {
      identity: identity[0]?.name || network.label,
      router_os: r.version || network.router_os_version || null,
      board: r["board-name"] || r.platform || null,
      architecture: r["architecture-name"] || null,
      cpu: r.cpu || null,
      cpu_count: asNumber(r["cpu-count"]),
      cpu_frequency_mhz: asNumber(r["cpu-frequency"]),
      cpu_load_percent: asNumber(r["cpu-load"]),
      uptime: r.uptime || null,
      total_memory: asNumber(r["total-memory"]),
      free_memory: asNumber(r["free-memory"]),
      timezone: clock[0]?.["time-zone-name"] || clock[0]?.["gmt-offset"] || null,
      current_date: clock[0]?.date || null,
      current_time: clock[0]?.time || null,
    };
  } finally {
    client.close();
  }
}

async function directVlans(network: Network, args: Record<string, unknown>) {
  const client = clientFor(network);
  try {
    const rows = await client.command("/interface/vlan/print", [
      "=.proplist=name,vlan-id,interface,disabled,running,comment",
    ]);
    const enabledOnly = args.enabled_only !== false;
    const filtered = enabledOnly ? rows.filter((x) => x.disabled !== "true") : rows;
    const limit = Math.max(1, Math.min(100, Number(args.limit || 50)));
    return {
      total: rows.length,
      enabled: rows.filter((x) => x.disabled !== "true").length,
      disabled: rows.filter((x) => x.disabled === "true").length,
      vlans: filtered
        .sort((a, b) => asNumber(a["vlan-id"]) - asNumber(b["vlan-id"]))
        .slice(0, limit)
        .map((x) => ({
          id: asNumber(x["vlan-id"]),
          name: x.name || null,
          parent_interface: x.interface || null,
          running: x.running !== "false",
          disabled: x.disabled === "true",
          comment: x.comment || null,
        })),
    };
  } finally {
    client.close();
  }
}

async function directVlan(network: Network, args: Record<string, unknown>) {
  const vlanId = Math.trunc(Number(args.vlan_id || 0));
  if (vlanId < 1 || vlanId > 4094) throw new Error("Invalid VLAN ID");
  const client = clientFor(network);
  try {
    const vlans = await client.command("/interface/vlan/print", ["=.proplist=name,vlan-id,interface,disabled,running,comment"]);
    const vlan = vlans.find((x) => asNumber(x["vlan-id"]) === vlanId);
    if (!vlan) return { found: false, vlan_id: vlanId };
    const stats = await client.command("/interface/print", ["=.proplist=name,rx-byte,tx-byte,rx-packet,tx-packet,rx-drop,tx-drop,rx-error,tx-error,running,disabled", `?name=${vlan.name}`]);
    let hotspotServers: Record<string, string>[] = [];
    let active: Record<string, string>[] = [];
    try { hotspotServers = await client.command("/ip/hotspot/print", ["=.proplist=name,interface,disabled"]); } catch {}
    const matchingServers = hotspotServers.filter((s) => s.interface === vlan.name).map((s) => s.name);
    try {
      const all = await client.command("/ip/hotspot/active/print", ["=.proplist=user,address,mac-address,server,uptime"]);
      active = matchingServers.length ? all.filter((a) => matchingServers.includes(a.server)) : [];
    } catch {}
    const s = stats[0] || {};
    return {
      found: true,
      vlan_id: vlanId,
      name: vlan.name,
      parent_interface: vlan.interface,
      running: vlan.running !== "false",
      disabled: vlan.disabled === "true",
      comment: vlan.comment || null,
      traffic: {
        rx_bytes: asNumber(s["rx-byte"]),
        tx_bytes: asNumber(s["tx-byte"]),
        rx_human: bytesText(asNumber(s["rx-byte"])),
        tx_human: bytesText(asNumber(s["tx-byte"])),
        rx_drops: asNumber(s["rx-drop"]),
        tx_drops: asNumber(s["tx-drop"]),
        rx_errors: asNumber(s["rx-error"]),
        tx_errors: asNumber(s["tx-error"]),
      },
      hotspot_servers: matchingServers,
      online_count: active.length,
      online_sample: active.slice(0, 20),
    };
  } finally {
    client.close();
  }
}

async function directInterfaces(network: Network) {
  const client = clientFor(network);
  try {
    const rows = await client.command("/interface/print", [
      "=.proplist=name,type,running,disabled,rx-byte,tx-byte,rx-drop,tx-drop,rx-error,tx-error,comment",
    ]);
    return {
      total: rows.length,
      interfaces: rows.slice(0, 100).map((x) => ({
        name: x.name,
        type: x.type,
        running: x.running === "true",
        disabled: x.disabled === "true",
        rx_bytes: asNumber(x["rx-byte"]),
        tx_bytes: asNumber(x["tx-byte"]),
        rx_drops: asNumber(x["rx-drop"]),
        tx_drops: asNumber(x["tx-drop"]),
        rx_errors: asNumber(x["rx-error"]),
        tx_errors: asNumber(x["tx-error"]),
        comment: x.comment || null,
      })),
    };
  } finally {
    client.close();
  }
}

async function directLogs(network: Network, args: Record<string, unknown>) {
  const client = clientFor(network);
  try {
    const rows = await client.command("/log/print", ["=.proplist=time,topics,message"]);
    const search = String(args.search || "").trim().toLowerCase();
    const filtered = search
      ? rows.filter((x) => `${x.topics || ""} ${x.message || ""}`.toLowerCase().includes(search))
      : rows;
    const limit = Math.max(1, Math.min(80, Number(args.limit || 30)));
    return {
      total_matching: filtered.length,
      logs: filtered.slice(-limit).map((x) => ({ time: x.time || null, topics: x.topics || null, message: x.message || null })),
    };
  } finally {
    client.close();
  }
}

function routerMajor(version?: string | null) {
  return Number(/^\d+/.exec(version || "")?.[0] || 0);
}

function sessionTime(row: Record<string, string>) {
  return row["from-time"] || row.started || row.start || row["start-time"] || "";
}

async function directInspectCard(network: Network, args: Record<string, unknown>) {
  const username = String(args.username || "").trim();
  if (!username || username.length > 128) throw new Error("A valid card username is required");
  const maxSessions = Math.max(1, Math.min(100, Number(args.max_sessions || 50)));
  const client = clientFor(network);
  try {
    const major = routerMajor(network.router_os_version);
    const candidates = major >= 7
      ? [
          { user: "/user-manager/user/print", sessions: "/user-manager/session/print" },
          { user: "/tool/user-manager/user/print", sessions: "/tool/user-manager/session/print" },
        ]
      : [
          { user: "/tool/user-manager/user/print", sessions: "/tool/user-manager/session/print" },
          { user: "/user-manager/user/print", sessions: "/user-manager/session/print" },
        ];

    let umUser: Record<string, string> | null = null;
    let sessions: Record<string, string>[] = [];
    let umVariant = "none";
    for (const candidate of candidates) {
      try {
        const users = await client.command(candidate.user, [`?username=${username}`]);
        const byName = users.length ? users : await client.command(candidate.user, [`?name=${username}`]);
        const sessionRows = await client.command(candidate.sessions, [`?user=${username}`]);
        if (byName.length || sessionRows.length) {
          umUser = byName[0] || null;
          sessions = sessionRows;
          umVariant = candidate.sessions.includes("/tool/") ? "v6" : "v7";
          break;
        }
      } catch {}
    }

    let hotspotActive: Record<string, string>[] = [];
    try {
      hotspotActive = await client.command("/ip/hotspot/active/print", [
        "=.proplist=user,address,mac-address,uptime,server,bytes-in,bytes-out,session-time-left,login-by",
        `?user=${username}`,
      ]);
    } catch {}

    let localHotspotUser: Record<string, string> | null = null;
    try {
      const local = await client.command("/ip/hotspot/user/print", [`?name=${username}`]);
      localHotspotUser = local[0] || null;
    } catch {}

    let hotspotServers: Record<string, string>[] = [];
    let vlans: Record<string, string>[] = [];
    try { hotspotServers = await client.command("/ip/hotspot/print", ["=.proplist=name,interface"]); } catch {}
    try { vlans = await client.command("/interface/vlan/print", ["=.proplist=name,vlan-id"]); } catch {}

    const active = hotspotActive[0] || null;
    let vlan: { id: number; name: string } | null = null;
    if (active?.server) {
      const hs = hotspotServers.find((x) => x.name === active.server);
      const v = hs ? vlans.find((x) => x.name === hs.interface) : null;
      if (v) vlan = { id: asNumber(v["vlan-id"]), name: v.name };
    }

    const sorted = [...sessions].sort((a, b) => sessionTime(a).localeCompare(sessionTime(b)));
    const totalDownload = sessions.reduce((sum, s) => sum + asNumber(s.download || s["download-bytes"] || s["bytes-out"]), 0);
    const totalUpload = sessions.reduce((sum, s) => sum + asNumber(s.upload || s["upload-bytes"] || s["bytes-in"]), 0);
    const terminateCounts: Record<string, number> = {};
    for (const s of sessions) {
      const cause = s["terminate-cause"] || s["terminate-reason"] || s.cause || "unknown";
      terminateCounts[cause] = (terminateCounts[cause] || 0) + 1;
    }

    const selected = sorted.slice(-maxSessions).reverse().map((s) => ({
      started: sessionTime(s) || null,
      ended: s["till-time"] || s.ended || s.end || null,
      uptime: s.uptime || null,
      download_bytes: asNumber(s.download || s["download-bytes"] || s["bytes-out"]),
      upload_bytes: asNumber(s.upload || s["upload-bytes"] || s["bytes-in"]),
      user_ip: s["user-ip"] || s.address || s["user-address"] || null,
      mac: s["calling-station-id"] || s["mac-address"] || null,
      nas_port_id: s["nas-port-id"] || null,
      terminate_cause: s["terminate-cause"] || s["terminate-reason"] || s.cause || null,
      status: s.status || null,
    }));

    return {
      username,
      found: Boolean(umUser || localHotspotUser || sessions.length || active),
      source: umVariant === "none" ? (localHotspotUser ? "hotspot-local" : "unknown") : `user-manager-${umVariant}`,
      profile: umUser?.["actual-profile"] || umUser?.profile || localHotspotUser?.profile || null,
      disabled: (umUser?.disabled || localHotspotUser?.disabled) === "true",
      last_seen: umUser?.["last-seen"] || null,
      active_now: Boolean(active),
      current_session: active ? {
        ip: active.address || null,
        mac: active["mac-address"] || null,
        uptime: active.uptime || null,
        hotspot_server: active.server || null,
        login_by: active["login-by"] || null,
        bytes_in: asNumber(active["bytes-in"]),
        bytes_out: asNumber(active["bytes-out"]),
        session_time_left: active["session-time-left"] || null,
        vlan,
      } : null,
      session_count: sessions.length,
      first_session: sorted[0] ? sessionTime(sorted[0]) : null,
      last_session: sorted.length ? sessionTime(sorted[sorted.length - 1]) : null,
      total_download_bytes: totalDownload,
      total_download_human: bytesText(totalDownload),
      total_upload_bytes: totalUpload,
      total_upload_human: bytesText(totalUpload),
      terminate_causes: terminateCounts,
      sessions_returned: selected.length,
      sessions: selected,
    };
  } finally {
    client.close();
  }
}

async function directSalesToday(network: Network) {
  const client = clientFor(network);
  try {
    let clock: Record<string, string>[] = [];
    try { clock = await client.command("/system/clock/print"); } catch {}
    const date = clock[0]?.date || "";
    const offset = clock[0]?.["gmt-offset"] || "+00:00";
    const dateMatchOld = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\/(\d{2})\/(\d{4})$/i.exec(date);
    let key = date;
    if (dateMatchOld) {
      const months: Record<string, string> = { jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12" };
      key = `${dateMatchOld[3]}-${months[dateMatchOld[1].toLowerCase()]}-${dateMatchOld[2]}`;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
      return { date_from_router: date, count: null, note: "Could not normalize router date" };
    }
    const start = new Date(`${key}T00:00:00${/^[-+]\d{2}:\d{2}$/.test(offset) ? offset : "+00:00"}`);
    const end = new Date(start.getTime() + 86400000);
    const rows = await dbGet<{ username: string; first_seen_at: string; first_profile?: string | null; first_vlan_id?: number | null }>("tg_cards", {
      network_id: `eq.${network.id}`,
      first_seen_at: `gte.${start.toISOString()}`,
      "first_seen_at.1": `lt.${end.toISOString()}`,
      select: "username,first_seen_at,first_profile,first_vlan_id",
      order: "first_seen_at.asc",
    });
    return { date: key, count: rows.length, cards: rows.slice(0, 50) };
  } finally {
    client.close();
  }
}

async function queueAgentAndWait(userId: number, network: Network, kind: string, payload: Record<string, unknown> = {}) {
  const inserted = await dbInsert<{ id: string }>(
    "tg_agent_commands",
    {
      network_id: network.id,
      telegram_user_id: userId,
      chat_id: 0,
      reply_message_id: null,
      kind,
      payload,
      status: "pending",
    },
    "id",
  );
  const id = inserted[0]?.id;
  if (!id) throw new Error("Could not queue Agent command");

  const deadline = Date.now() + 38000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const rows = await dbGet<AgentCommandRow>("tg_agent_commands", {
      id: `eq.${id}`,
      select: "id,status,result,error",
      limit: "1",
    });
    const row = rows[0];
    if (!row) continue;
    if (row.status === "success") return row.result || { status: "ok" };
    if (["error", "expired"].includes(row.status)) throw new Error(row.error || "Agent command failed");
  }
  throw new Error("Agent did not return the result in time");
}

async function runTool(user: BotUser, network: Network, name: string, args: Record<string, unknown>) {
  if (network.connection_mode === "agent") {
    const map: Record<string, { kind: string; payload?: Record<string, unknown> }> = {
      network_status: { kind: "status" },
      ping: { kind: "ping" },
      online_users: { kind: "online" },
      router_info: { kind: "router" },
      list_vlans: { kind: "vlans" },
      vlan_details: { kind: "vlan", payload: { vlan_id: Number(args.vlan_id || 0) } },
      sales_today: { kind: "sales" },
      inspect_card: { kind: "card", payload: { username: String(args.username || "") } },
    };
    const command = map[name];
    if (!command) return { unavailable: true, reason: `${name} is not yet available through Agent transport` };
    return queueAgentAndWait(user.telegram_user_id, network, command.kind, command.payload || {});
  }

  if (name === "network_status") return directStatus(network);
  if (name === "ping") return directPing(network, args);
  if (name === "online_users") return directOnline(network, args);
  if (name === "router_info") return directRouterInfo(network);
  if (name === "list_vlans") return directVlans(network, args);
  if (name === "vlan_details") return directVlan(network, args);
  if (name === "inspect_card") return directInspectCard(network, args);
  if (name === "sales_today") return directSalesToday(network);
  if (name === "interfaces_overview") return directInterfaces(network);
  if (name === "recent_logs") return directLogs(network, args);
  throw new Error(`Unknown tool: ${name}`);
}

const tools = [
  {
    type: "function",
    function: {
      name: "network_status",
      description: "Read the current health of the active MikroTik network: internet ping, CPU, memory, uptime, Hotspot online count and PPPoE state. Use for status, health, internet-down or broad diagnostic questions.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "online_users",
      description: "Read current Hotspot active users. Use for how many users are online, who is online, or searching a current user by username/IP/MAC/server.",
      parameters: {
        type: "object",
        properties: {
          search: { type: "string", description: "Optional username, IP, MAC or server substring to search" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_card",
      description: "Perform a comprehensive read-only investigation of a Hotspot/User Manager card: profile, current session, MAC/IP/server, all available historical sessions, traffic totals, first/last use and termination causes. Use whenever the user mentions a card/username and asks to inspect, diagnose, check history, sessions, usage, or why it disconnects.",
      parameters: {
        type: "object",
        required: ["username"],
        properties: {
          username: { type: "string" },
          max_sessions: { type: "integer", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "router_info",
      description: "Read RouterOS version, board, architecture, CPU, memory, timezone and uptime.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "list_vlans",
      description: "List VLAN interfaces and their IDs, names, running/disabled status and parent interfaces.",
      parameters: {
        type: "object",
        properties: {
          enabled_only: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vlan_details",
      description: "Read detailed status and traffic counters for one VLAN, including errors/drops and currently active Hotspot users when discoverable.",
      parameters: {
        type: "object",
        required: ["vlan_id"],
        properties: { vlan_id: { type: "integer", minimum: 1, maximum: 4094 } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ping",
      description: "Ping an IP address or hostname from the router and return packet loss and latency. Default target is 8.8.8.8.",
      parameters: {
        type: "object",
        properties: {
          address: { type: "string" },
          count: { type: "integer", minimum: 1, maximum: 5 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sales_today",
      description: "Return today's first-ever-seen cards recorded by the cloud sales ledger for the active network. Use for today's sales/new cards/first logins.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "interfaces_overview",
      description: "Read interface states, traffic counters, drops and errors. Useful when diagnosing slowness, link problems, interface errors or general network health.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "recent_logs",
      description: "Read recent RouterOS log messages, optionally filtered by a word. Useful for login failures, errors, warnings, DHCP, PPP, Hotspot and system incidents.",
      parameters: {
        type: "object",
        properties: {
          search: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 80 },
        },
        additionalProperties: false,
      },
    },
  },
];

function systemPrompt(network: Network) {
  return `You are an expert MikroTik network operations assistant living inside Telegram.

The active network is ${network.identity || network.label}. RouterOS is ${network.router_os_version || "unknown"}. Transport is ${network.connection_mode}.

Your job is to understand natural language in ANY language or dialect, including informal Yemeni/Gulf Arabic, English, mixed Arabic-English and misspellings. Reply in the same language and roughly the same dialect/formality as the user unless clarity requires standard technical terms.

CRITICAL RULES:
- You have READ-ONLY tools. Never claim that you changed, restarted, disconnected, deleted, enabled or disabled anything.
- Never invent live router values. For any current fact, call the appropriate tool.
- If the user asks for a diagnosis, use multiple tools when useful instead of giving generic advice.
- If a user mentions a specific card/username and asks about it, use inspect_card. Analyze its sessions and termination causes, not just the current state.
- Distinguish evidence from hypothesis. Say what the data shows, then what is likely.
- Avoid dumping raw JSON. Explain the result like a skilled network engineer speaking to a network owner.
- Be concise for simple questions. Be detailed for diagnosis requests.
- Do not expose passwords, tokens, stored credentials or internal implementation details.
- If a requested action is destructive or modifies the router, explain that it needs a confirmed write action; do not execute it.
- If a tool is unavailable on this RouterOS/network, explain the limitation and use available evidence instead.
- When a follow-up says things like "افحصها", "الثاني", "هذا الكرت", use conversation context to resolve the reference.
- Use plain text and emojis only. Do not output Markdown tables or HTML tags.
`;
}

async function loadMemory(userId: number, networkId: string) {
  const rows = await dbGet<MemoryRow>("tg_ai_messages", {
    telegram_user_id: `eq.${userId}`,
    network_id: `eq.${networkId}`,
    select: "role,content,created_at",
    order: "created_at.desc",
    limit: "10",
  });
  return rows.reverse();
}

async function remember(userId: number, networkId: string, role: "user" | "assistant", content: string) {
  await dbInsert("tg_ai_messages", {
    telegram_user_id: userId,
    network_id: networkId,
    role,
    content: content.slice(0, 12000),
  });
}

function parseArguments(raw: string) {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function runAgent(user: BotUser, network: Network, userText: string) {
  const memory = await loadMemory(user.telegram_user_id, network.id);
  const messages: GatewayMessage[] = [
    { role: "system", content: systemPrompt(network) },
    ...memory.map((m) => ({ role: m.role, content: m.content } as GatewayMessage)),
    { role: "user", content: userText },
  ];

  for (let step = 0; step < 6; step++) {
    const assistant = await gatewayChat(messages, tools);
    const calls = assistant.tool_calls || [];
    if (!calls.length) {
      const answer = String(assistant.content || "لم أستطع تكوين إجابة واضحة من البيانات المتاحة.").trim();
      return answer;
    }

    messages.push({ role: "assistant", content: assistant.content ?? null, tool_calls: calls });
    const results = await Promise.all(
      calls.slice(0, 5).map(async (call) => {
        const args = parseArguments(call.function.arguments);
        try {
          const result = await runTool(user, network, call.function.name, args);
          return { call, result };
        } catch (error) {
          return {
            call,
            result: { error: String(error instanceof Error ? error.message : error) },
          };
        }
      }),
    );

    for (const { call, result } of results) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, 30000),
      });
    }
  }

  return "جمعت البيانات المطلوبة لكن التحليل احتاج خطوات أكثر من الحد الآمن. جرّب تقسيم السؤال إلى جزءين وسأكمل معك من نفس السياق.";
}

export async function handleTelegramAI(update: TgUpdate): Promise<boolean> {
  const message = update.message;
  if (!message?.from || !message.text) return false;
  const text = message.text.trim();
  if (!text || text.startsWith("/")) return false;

  const user = await ensureUser(message.from);
  if (!user) return false;
  // Never steal text that belongs to the router setup wizard.
  if (user.setup_state && user.setup_state !== "idle") return false;

  const network = await activeNetwork(user);
  if (!network) {
    await send(message.chat.id, "ما عندك شبكة نشطة حتى الآن. استخدم /add أولاً لربط MikroTik، وبعدها تقدر تسألني بأي صيغة أو لهجة.");
    return true;
  }

  if (!gatewayCredential()) {
    // Leave old deterministic bot flows available, but explain natural-language mode clearly.
    await send(message.chat.id, "الذكاء الطبيعي غير مفعّل في بيئة التشغيل حتى الآن. الأوامر التقليدية ما زالت تعمل، مثل /status و /online و /sales.");
    return true;
  }

  await sendTyping(message.chat.id);
  try {
    await remember(user.telegram_user_id, network.id, "user", text);
    const answer = await runAgent(user, network, text);
    await remember(user.telegram_user_id, network.id, "assistant", answer);
    await send(message.chat.id, answer);
    return true;
  } catch (error) {
    console.error("Telegram AI agent failed", error);
    await send(
      message.chat.id,
      `تعذر تشغيل التحليل الذكي الآن، لكن اتصال الشبكة والأوامر التقليدية لم تتأثر. الخطأ: ${String(error instanceof Error ? error.message : error).slice(0, 220)}`,
    );
    return true;
  }
}
