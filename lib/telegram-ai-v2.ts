import { ToolLoopAgent, jsonSchema, stepCountIs, tool } from "ai";
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
  status?: string | null;
  agent_last_seen_at?: string | null;
  capabilities?: Record<string, unknown> | null;
};

type MemoryRow = {
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

type AgentCommandRow = {
  id: string;
  status: "pending" | "claimed" | "success" | "error" | "expired";
  result?: Record<string, unknown> | null;
  error?: string | null;
};

type EmptyInput = Record<string, never>;
type OnlineInput = { search?: string; limit?: number };
type PingInput = { address?: string; count?: number };
type VlanInput = { vlan_id: number };
type VlanListInput = { enabled_only?: boolean; limit?: number };
type CardInput = { username: string; max_sessions?: number };
type LogInput = { search?: string; limit?: number };

const MODEL = "openai/gpt-5.5-fast";

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function botToken() {
  const value = process.env.TELEGRAM_BOT_TOKEN;
  if (!value) throw new Error("TELEGRAM_BOT_TOKEN is missing");
  return value;
}

async function telegram(method: string, payload: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const json = await response.json();
  if (!json.ok) throw new Error(json.description || `Telegram ${response.status}`);
  return json.result;
}

async function send(chatId: number, text: string) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text: escapeHtml(text).slice(0, 4000),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

async function sendTyping(chatId: number) {
  try {
    await telegram("sendChatAction", { chat_id: chatId, action: "typing" });
  } catch {}
}

async function ensureUser(input: {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
}) {
  await dbUpsert(
    "tg_users",
    {
      telegram_user_id: input.id,
      username: input.username ?? null,
      first_name: input.first_name ?? null,
      last_name: input.last_name ?? null,
      language_code: input.language_code ?? null,
      updated_at: new Date().toISOString(),
    },
    "telegram_user_id",
  );

  const rows = await dbGet<BotUser>("tg_users", {
    telegram_user_id: `eq.${input.id}`,
    select: "telegram_user_id,setup_state,active_network_id",
    limit: "1",
  });
  return rows[0] ?? null;
}

async function getNetworkById(userId: number, networkId: string) {
  const rows = await dbGet<Network>("tg_networks", {
    id: `eq.${networkId}`,
    telegram_user_id: `eq.${userId}`,
    select: "*",
    limit: "1",
  });
  return rows[0] ?? null;
}

async function activeNetwork(user: BotUser) {
  if (user.active_network_id) {
    const selected = await getNetworkById(user.telegram_user_id, user.active_network_id);
    if (selected) return selected;
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

function asNumber(value: unknown) {
  const result = Number(value || 0);
  return Number.isFinite(result) ? result : 0;
}

function humanBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(2)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(2)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function safeHost(value: unknown) {
  const host = String(value || "8.8.8.8").trim();
  if (!/^[a-zA-Z0-9.-]{1,253}$/.test(host)) throw new Error("Invalid ping target");
  return host;
}

async function readStatus(network: Network) {
  const client = clientFor(network);
  try {
    const resource = await client.command("/system/resource/print");
    const identity = await client.command("/system/identity/print");
    const ping = await client.command("/ping", ["=address=8.8.8.8", "=count=3"]);

    let active: Record<string, string>[] = [];
    let ppp: Record<string, string>[] = [];
    try { active = await client.command("/ip/hotspot/active/print", ["=.proplist=.id"]); } catch {}
    try { ppp = await client.command("/interface/pppoe-client/print", ["=.proplist=name,running,disabled"]); } catch {}

    const row = resource[0] || {};
    const totalMemory = asNumber(row["total-memory"]);
    const freeMemory = asNumber(row["free-memory"]);
    return {
      identity: identity[0]?.name || network.label,
      router_os: row.version || network.router_os_version || null,
      board: row["board-name"] || row.platform || null,
      uptime: row.uptime || null,
      cpu_load_percent: asNumber(row["cpu-load"]),
      memory_used_percent: totalMemory > 0 ? Math.round((1 - freeMemory / totalMemory) * 100) : null,
      internet_test: {
        target: "8.8.8.8",
        sent: 3,
        received: ping.length,
        packet_loss_percent: Math.round(((3 - ping.length) / 3) * 100),
      },
      hotspot_online_count: active.length,
      running_pppoe_clients: ppp
        .filter((item) => item.running === "true" && item.disabled !== "true")
        .map((item) => item.name),
    };
  } finally {
    client.close();
  }
}

async function readOnline(network: Network, input: OnlineInput) {
  const client = clientFor(network);
  try {
    const rows = await client.command("/ip/hotspot/active/print", [
      "=.proplist=user,address,mac-address,uptime,server,bytes-in,bytes-out,session-time-left,login-by",
    ]);
    const search = String(input.search || "").trim().toLowerCase();
    const matched = search
      ? rows.filter((row) =>
          [row.user, row.address, row["mac-address"], row.server]
            .some((value) => String(value || "").toLowerCase().includes(search)),
        )
      : rows;
    const limit = Math.max(1, Math.min(50, Number(input.limit || 20)));
    return {
      total_online: rows.length,
      matched_count: matched.length,
      users: matched.slice(0, limit).map((row) => ({
        username: row.user || null,
        ip: row.address || null,
        mac: row["mac-address"] || null,
        uptime: row.uptime || null,
        hotspot_server: row.server || null,
        login_by: row["login-by"] || null,
        bytes_in: asNumber(row["bytes-in"]),
        bytes_out: asNumber(row["bytes-out"]),
        session_time_left: row["session-time-left"] || null,
      })),
    };
  } finally {
    client.close();
  }
}

async function readPing(network: Network, input: PingInput) {
  const client = clientFor(network);
  try {
    const address = safeHost(input.address);
    const count = Math.max(1, Math.min(5, Number(input.count || 5)));
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

async function readRouterInfo(network: Network) {
  const client = clientFor(network);
  try {
    const resource = await client.command("/system/resource/print");
    const identity = await client.command("/system/identity/print");
    let clock: Record<string, string>[] = [];
    try { clock = await client.command("/system/clock/print"); } catch {}
    const row = resource[0] || {};
    return {
      identity: identity[0]?.name || network.label,
      router_os: row.version || network.router_os_version || null,
      board: row["board-name"] || row.platform || null,
      architecture: row["architecture-name"] || null,
      cpu: row.cpu || null,
      cpu_count: asNumber(row["cpu-count"]),
      cpu_frequency_mhz: asNumber(row["cpu-frequency"]),
      cpu_load_percent: asNumber(row["cpu-load"]),
      uptime: row.uptime || null,
      total_memory: asNumber(row["total-memory"]),
      free_memory: asNumber(row["free-memory"]),
      timezone: clock[0]?.["time-zone-name"] || clock[0]?.["gmt-offset"] || null,
      date: clock[0]?.date || null,
      time: clock[0]?.time || null,
    };
  } finally {
    client.close();
  }
}

async function readVlans(network: Network, input: VlanListInput) {
  const client = clientFor(network);
  try {
    const rows = await client.command("/interface/vlan/print", [
      "=.proplist=name,vlan-id,interface,disabled,running,comment",
    ]);
    const enabledOnly = input.enabled_only !== false;
    const visible = enabledOnly ? rows.filter((row) => row.disabled !== "true") : rows;
    const limit = Math.max(1, Math.min(100, Number(input.limit || 60)));
    return {
      total: rows.length,
      enabled: rows.filter((row) => row.disabled !== "true").length,
      disabled: rows.filter((row) => row.disabled === "true").length,
      vlans: visible
        .sort((a, b) => asNumber(a["vlan-id"]) - asNumber(b["vlan-id"]))
        .slice(0, limit)
        .map((row) => ({
          vlan_id: asNumber(row["vlan-id"]),
          name: row.name || null,
          parent_interface: row.interface || null,
          running: row.running !== "false",
          disabled: row.disabled === "true",
          comment: row.comment || null,
        })),
    };
  } finally {
    client.close();
  }
}

async function readVlan(network: Network, input: VlanInput) {
  const vlanId = Math.trunc(Number(input.vlan_id));
  if (vlanId < 1 || vlanId > 4094) throw new Error("Invalid VLAN ID");
  const client = clientFor(network);
  try {
    const vlans = await client.command("/interface/vlan/print", [
      "=.proplist=name,vlan-id,interface,disabled,running,comment",
    ]);
    const vlan = vlans.find((row) => asNumber(row["vlan-id"]) === vlanId);
    if (!vlan) return { found: false, vlan_id: vlanId };

    const interfaces = await client.command("/interface/print", [
      "=.proplist=name,rx-byte,tx-byte,rx-drop,tx-drop,rx-error,tx-error,running,disabled",
      `?name=${vlan.name}`,
    ]);
    const stats = interfaces[0] || {};

    let hotspotServers: Record<string, string>[] = [];
    let active: Record<string, string>[] = [];
    try { hotspotServers = await client.command("/ip/hotspot/print", ["=.proplist=name,interface,disabled"]); } catch {}
    const serverNames = hotspotServers.filter((item) => item.interface === vlan.name).map((item) => item.name);
    try {
      const all = await client.command("/ip/hotspot/active/print", ["=.proplist=user,address,mac-address,server,uptime"]);
      active = serverNames.length ? all.filter((item) => serverNames.includes(item.server)) : [];
    } catch {}

    return {
      found: true,
      vlan_id: vlanId,
      name: vlan.name || null,
      parent_interface: vlan.interface || null,
      running: vlan.running !== "false",
      disabled: vlan.disabled === "true",
      comment: vlan.comment || null,
      traffic: {
        rx_bytes: asNumber(stats["rx-byte"]),
        tx_bytes: asNumber(stats["tx-byte"]),
        rx_human: humanBytes(asNumber(stats["rx-byte"])),
        tx_human: humanBytes(asNumber(stats["tx-byte"])),
        rx_drops: asNumber(stats["rx-drop"]),
        tx_drops: asNumber(stats["tx-drop"]),
        rx_errors: asNumber(stats["rx-error"]),
        tx_errors: asNumber(stats["tx-error"]),
      },
      hotspot_servers: serverNames,
      online_count: active.length,
      online_sample: active.slice(0, 20),
    };
  } finally {
    client.close();
  }
}

async function readInterfaces(network: Network) {
  const client = clientFor(network);
  try {
    const rows = await client.command("/interface/print", [
      "=.proplist=name,type,running,disabled,rx-byte,tx-byte,rx-drop,tx-drop,rx-error,tx-error,comment",
    ]);
    return {
      total: rows.length,
      interfaces: rows.slice(0, 100).map((row) => ({
        name: row.name || null,
        type: row.type || null,
        running: row.running === "true",
        disabled: row.disabled === "true",
        rx_bytes: asNumber(row["rx-byte"]),
        tx_bytes: asNumber(row["tx-byte"]),
        rx_drops: asNumber(row["rx-drop"]),
        tx_drops: asNumber(row["tx-drop"]),
        rx_errors: asNumber(row["rx-error"]),
        tx_errors: asNumber(row["tx-error"]),
        comment: row.comment || null,
      })),
    };
  } finally {
    client.close();
  }
}

async function readLogs(network: Network, input: LogInput) {
  const client = clientFor(network);
  try {
    const rows = await client.command("/log/print", ["=.proplist=time,topics,message"]);
    const search = String(input.search || "").trim().toLowerCase();
    const filtered = search
      ? rows.filter((row) => `${row.topics || ""} ${row.message || ""}`.toLowerCase().includes(search))
      : rows;
    const limit = Math.max(1, Math.min(80, Number(input.limit || 30)));
    return {
      matching_count: filtered.length,
      logs: filtered.slice(-limit).map((row) => ({
        time: row.time || null,
        topics: row.topics || null,
        message: row.message || null,
      })),
    };
  } finally {
    client.close();
  }
}

function routerMajor(version?: string | null) {
  return Number(/^\d+/.exec(version || "")?.[0] || 0);
}

function sessionStart(row: Record<string, string>) {
  return row["from-time"] || row.started || row.start || row["start-time"] || "";
}

async function inspectCard(network: Network, input: CardInput) {
  const username = String(input.username || "").trim();
  if (!username || username.length > 128) throw new Error("A valid card username is required");
  const maxSessions = Math.max(1, Math.min(100, Number(input.max_sessions || 50)));
  const client = clientFor(network);
  try {
    const major = routerMajor(network.router_os_version);
    const candidates = major >= 7
      ? [
          { users: "/user-manager/user/print", sessions: "/user-manager/session/print", variant: "v7" },
          { users: "/tool/user-manager/user/print", sessions: "/tool/user-manager/session/print", variant: "v6" },
        ]
      : [
          { users: "/tool/user-manager/user/print", sessions: "/tool/user-manager/session/print", variant: "v6" },
          { users: "/user-manager/user/print", sessions: "/user-manager/session/print", variant: "v7" },
        ];

    let umUser: Record<string, string> | null = null;
    let sessions: Record<string, string>[] = [];
    let source = "none";

    for (const candidate of candidates) {
      try {
        let users = await client.command(candidate.users, [`?username=${username}`]);
        if (!users.length) users = await client.command(candidate.users, [`?name=${username}`]);
        const history = await client.command(candidate.sessions, [`?user=${username}`]);
        if (users.length || history.length) {
          umUser = users[0] || null;
          sessions = history;
          source = `user-manager-${candidate.variant}`;
          break;
        }
      } catch {}
    }

    let activeRows: Record<string, string>[] = [];
    let localUser: Record<string, string> | null = null;
    try {
      activeRows = await client.command("/ip/hotspot/active/print", [
        "=.proplist=user,address,mac-address,uptime,server,bytes-in,bytes-out,session-time-left,login-by",
        `?user=${username}`,
      ]);
    } catch {}
    try {
      const rows = await client.command("/ip/hotspot/user/print", [`?name=${username}`]);
      localUser = rows[0] || null;
    } catch {}

    let hotspotServers: Record<string, string>[] = [];
    let vlans: Record<string, string>[] = [];
    try { hotspotServers = await client.command("/ip/hotspot/print", ["=.proplist=name,interface"]); } catch {}
    try { vlans = await client.command("/interface/vlan/print", ["=.proplist=name,vlan-id"]); } catch {}

    const active = activeRows[0] || null;
    let currentVlan: { vlan_id: number; name: string } | null = null;
    if (active?.server) {
      const server = hotspotServers.find((item) => item.name === active.server);
      const vlan = server ? vlans.find((item) => item.name === server.interface) : null;
      if (vlan) currentVlan = { vlan_id: asNumber(vlan["vlan-id"]), name: vlan.name };
    }

    const sorted = [...sessions].sort((a, b) => sessionStart(a).localeCompare(sessionStart(b)));
    const download = sessions.reduce(
      (sum, row) => sum + asNumber(row.download || row["download-bytes"] || row["bytes-out"]),
      0,
    );
    const upload = sessions.reduce(
      (sum, row) => sum + asNumber(row.upload || row["upload-bytes"] || row["bytes-in"]),
      0,
    );
    const causes: Record<string, number> = {};
    for (const row of sessions) {
      const cause = row["terminate-cause"] || row["terminate-reason"] || row.cause || "unknown";
      causes[cause] = (causes[cause] || 0) + 1;
    }

    const selected = sorted.slice(-maxSessions).reverse().map((row) => ({
      started: sessionStart(row) || null,
      ended: row["till-time"] || row.ended || row.end || null,
      uptime: row.uptime || null,
      download_bytes: asNumber(row.download || row["download-bytes"] || row["bytes-out"]),
      upload_bytes: asNumber(row.upload || row["upload-bytes"] || row["bytes-in"]),
      user_ip: row["user-ip"] || row.address || row["user-address"] || null,
      mac: row["calling-station-id"] || row["mac-address"] || null,
      nas_port_id: row["nas-port-id"] || null,
      terminate_cause: row["terminate-cause"] || row["terminate-reason"] || row.cause || null,
      status: row.status || null,
    }));

    return {
      username,
      found: Boolean(umUser || localUser || sessions.length || active),
      source: source === "none" ? (localUser ? "hotspot-local" : "unknown") : source,
      profile: umUser?.["actual-profile"] || umUser?.profile || localUser?.profile || null,
      disabled: (umUser?.disabled || localUser?.disabled) === "true",
      last_seen: umUser?.["last-seen"] || null,
      active_now: Boolean(active),
      current_session: active
        ? {
            ip: active.address || null,
            mac: active["mac-address"] || null,
            uptime: active.uptime || null,
            hotspot_server: active.server || null,
            login_by: active["login-by"] || null,
            bytes_in: asNumber(active["bytes-in"]),
            bytes_out: asNumber(active["bytes-out"]),
            session_time_left: active["session-time-left"] || null,
            vlan: currentVlan,
          }
        : null,
      session_count: sessions.length,
      first_session: sorted[0] ? sessionStart(sorted[0]) : null,
      last_session: sorted.length ? sessionStart(sorted[sorted.length - 1]) : null,
      total_download_bytes: download,
      total_download_human: humanBytes(download),
      total_upload_bytes: upload,
      total_upload_human: humanBytes(upload),
      terminate_causes: causes,
      sessions_returned: selected.length,
      sessions: selected,
    };
  } finally {
    client.close();
  }
}

async function readSalesToday(network: Network) {
  const client = clientFor(network);
  try {
    let clock: Record<string, string>[] = [];
    try { clock = await client.command("/system/clock/print"); } catch {}
    const rawDate = clock[0]?.date || "";
    const rawOffset = clock[0]?.["gmt-offset"] || "+00:00";
    const old = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\/(\d{2})\/(\d{4})$/i.exec(rawDate);
    let dateKey = rawDate;
    if (old) {
      const months: Record<string, string> = {
        jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
        jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
      };
      dateKey = `${old[3]}-${months[old[1].toLowerCase()]}-${old[2]}`;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      return { count: null, router_date: rawDate, note: "Router date could not be normalized" };
    }
    const offset = /^[-+]\d{2}:\d{2}$/.test(rawOffset) ? rawOffset : "+00:00";
    const start = new Date(`${dateKey}T00:00:00${offset}`);
    const end = new Date(start.getTime() + 86400000);
    const cards = await dbGet<{
      username: string;
      first_seen_at: string;
      first_profile?: string | null;
      first_vlan_id?: number | null;
    }>("tg_cards", {
      network_id: `eq.${network.id}`,
      first_seen_at: `gte.${start.toISOString()}`,
      "first_seen_at.1": `lt.${end.toISOString()}`,
      select: "username,first_seen_at,first_profile,first_vlan_id",
      order: "first_seen_at.asc",
    });
    return { date: dateKey, count: cards.length, cards: cards.slice(0, 50) };
  } finally {
    client.close();
  }
}

async function queueAgentAndWait(
  userId: number,
  network: Network,
  kind: "status" | "ping" | "online" | "router" | "vlans" | "vlan" | "sales",
  payload: Record<string, unknown> = {},
) {
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
  const commandId = inserted[0]?.id;
  if (!commandId) throw new Error("Could not queue Agent command");

  const deadline = Date.now() + 38000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const rows = await dbGet<AgentCommandRow>("tg_agent_commands", {
      id: `eq.${commandId}`,
      select: "id,status,result,error",
      limit: "1",
    });
    const row = rows[0];
    if (!row) continue;
    if (row.status === "success") return row.result || { status: "ok" };
    if (row.status === "error" || row.status === "expired") {
      throw new Error(row.error || "Agent command failed");
    }
  }
  throw new Error("Agent did not return a result in time");
}

async function executeTool(
  user: BotUser,
  network: Network,
  name: string,
  input: Record<string, unknown>,
) {
  if (network.connection_mode === "agent") {
    if (name === "network_status") return queueAgentAndWait(user.telegram_user_id, network, "status");
    if (name === "ping") return queueAgentAndWait(user.telegram_user_id, network, "ping");
    if (name === "online_users") return queueAgentAndWait(user.telegram_user_id, network, "online");
    if (name === "router_info") return queueAgentAndWait(user.telegram_user_id, network, "router");
    if (name === "list_vlans") return queueAgentAndWait(user.telegram_user_id, network, "vlans");
    if (name === "vlan_details") {
      return queueAgentAndWait(user.telegram_user_id, network, "vlan", { vlan_id: Number(input.vlan_id || 0) });
    }
    if (name === "sales_today") return queueAgentAndWait(user.telegram_user_id, network, "sales");
    return {
      unavailable: true,
      reason: `${name} needs the newer Agent version and is not available on this router yet`,
    };
  }

  if (name === "network_status") return readStatus(network);
  if (name === "online_users") return readOnline(network, input as OnlineInput);
  if (name === "ping") return readPing(network, input as PingInput);
  if (name === "router_info") return readRouterInfo(network);
  if (name === "list_vlans") return readVlans(network, input as VlanListInput);
  if (name === "vlan_details") return readVlan(network, input as VlanInput);
  if (name === "inspect_card") return inspectCard(network, input as CardInput);
  if (name === "sales_today") return readSalesToday(network);
  if (name === "interfaces_overview") return readInterfaces(network);
  if (name === "recent_logs") return readLogs(network, input as LogInput);
  throw new Error(`Unknown tool ${name}`);
}

function buildTools(user: BotUser, network: Network, trace: string[]) {
  const run = async (name: string, input: Record<string, unknown>) => {
    trace.push(name);
    try {
      return await executeTool(user, network, name, input);
    } catch (error) {
      return { error: String(error instanceof Error ? error.message : error) };
    }
  };

  return {
    network_status: tool({
      description:
        "Get current overall network health from MikroTik: ping to 8.8.8.8, CPU, memory, uptime, Hotspot online count and PPPoE state. Use for broad health, internet down, network slow, or status questions.",
      inputSchema: jsonSchema<EmptyInput>({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => run("network_status", {}),
    }),
    online_users: tool({
      description:
        "Get current Hotspot active users. Use for how many users are online, who is connected now, or finding a current user by username, IP, MAC or server.",
      inputSchema: jsonSchema<OnlineInput>({
        type: "object",
        properties: {
          search: { type: "string", description: "Optional username, IP, MAC or server text to filter" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      }),
      execute: async (input) => run("online_users", input),
    }),
    inspect_card: tool({
      description:
        "Comprehensively inspect one Hotspot/User Manager card or username: profile, current connection, IP, MAC, VLAN/server, all available session history, first and last session, traffic totals and termination causes. ALWAYS use when a user asks to inspect/check/diagnose a specific card, its sessions, usage or disconnections.",
      inputSchema: jsonSchema<CardInput>({
        type: "object",
        properties: {
          username: { type: "string", description: "Exact card username or Hotspot/User Manager username" },
          max_sessions: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["username"],
        additionalProperties: false,
      }),
      execute: async (input) => run("inspect_card", input),
    }),
    ping: tool({
      description:
        "Ping an address from the MikroTik itself and report packet loss and latency. Default target is 8.8.8.8.",
      inputSchema: jsonSchema<PingInput>({
        type: "object",
        properties: {
          address: { type: "string" },
          count: { type: "integer", minimum: 1, maximum: 5 },
        },
        additionalProperties: false,
      }),
      execute: async (input) => run("ping", input),
    }),
    router_info: tool({
      description: "Get RouterOS version, hardware board, CPU, memory, uptime, architecture, date and timezone.",
      inputSchema: jsonSchema<EmptyInput>({ type: "object", properties: {}, additionalProperties: false }),
      execute: async () => run("router_info", {}),
    }),
    list_vlans: tool({
      description: "List VLANs and their IDs, names, parent interfaces, enabled/running state and comments.",
      inputSchema: jsonSchema<VlanListInput>({
        type: "object",
        properties: {
          enabled_only: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      }),
      execute: async (input) => run("list_vlans", input),
    }),
    vlan_details: tool({
      description:
        "Inspect one VLAN in detail: state, interface counters, errors/drops and connected Hotspot users when discoverable. Use when a VLAN number is mentioned with a health/usage/problem question.",
      inputSchema: jsonSchema<VlanInput>({
        type: "object",
        properties: { vlan_id: { type: "integer", minimum: 1, maximum: 4094 } },
        required: ["vlan_id"],
        additionalProperties: false,
      }),
      execute: async (input) => run("vlan_details", input),
    }),
    sales_today: tool({
      description:
        "Get today's sales/new cards from the cloud first-seen ledger. A sale means a card whose first-ever recorded use is today.",
      inputSchema: jsonSchema<EmptyInput>({ type: "object", properties: {}, additionalProperties: false }),
      execute: async () => run("sales_today", {}),
    }),
    interfaces_overview: tool({
      description:
        "Get interface state, traffic, drops and errors across the router. Useful in diagnosing network slowness, physical/interface problems or unexplained instability.",
      inputSchema: jsonSchema<EmptyInput>({ type: "object", properties: {}, additionalProperties: false }),
      execute: async () => run("interfaces_overview", {}),
    }),
    recent_logs: tool({
      description:
        "Get recent RouterOS logs, optionally filtered. Use for login failures, PPP, DHCP, Hotspot, system errors, warnings and incident investigation.",
      inputSchema: jsonSchema<LogInput>({
        type: "object",
        properties: {
          search: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 80 },
        },
        additionalProperties: false,
      }),
      execute: async (input) => run("recent_logs", input),
    }),
  };
}

function instructions(network: Network) {
  return `You are a highly capable MikroTik network operations engineer inside Telegram.

ACTIVE NETWORK
Name: ${network.identity || network.label}
RouterOS: ${network.router_os_version || "unknown"}
Transport: ${network.connection_mode}
Known capabilities: ${JSON.stringify(network.capabilities || {})}

LANGUAGE AND UX
- Understand ANY language or dialect, especially informal Yemeni/Gulf Arabic, Modern Standard Arabic, English, mixed Arabic-English, abbreviations and common spelling mistakes.
- Reply naturally in the same language and roughly the same dialect/formality as the user.
- Simple question = short direct answer. Diagnostic request = structured useful report.
- Explain technical evidence in plain language for a network owner. Do not dump raw JSON.

TRUTH AND EVIDENCE
- NEVER invent current router data. Current facts must come from a tool call.
- Separate what the data proves from what you infer. Use wording like “البيانات تظهر…” versus “الأرجح…”.
- If data is unavailable, say that clearly instead of guessing.
- If the user asks “why” or asks for diagnosis, combine multiple tools when useful.
- If a specific card/username is mentioned, prefer inspect_card. Analyze history and terminate causes, not only whether it is online now.
- If network slowness is reported, usually inspect network_status and, when useful, interfaces_overview, ping, logs, or a named VLAN/card.

SAFETY
- Every available tool is READ-ONLY. Never claim you changed, rebooted, disconnected, deleted, enabled, disabled or fixed router configuration.
- If asked to modify the network, explain what action would be needed and that a confirmed write action is required. Do not execute it.
- Never reveal stored credentials, tokens, passwords, internal secrets or backend implementation details.

CONTEXT
- Resolve follow-ups like “افحصها”, “الثاني”, “هذا الكرت”, “طيب هو؟” from recent conversation context.
- Keep exact card numbers, VLAN IDs, IPs and MACs intact.
- Do not ask a clarifying question when the intended target can be inferred safely from context or found using read-only tools.

OUTPUT
- Plain conversational text with light emoji where useful.
- No Markdown tables and no HTML.
- For a comprehensive card report, prioritize: status now, profile, first/last use, session count, traffic totals, recent sessions, termination patterns, evidence-based diagnosis, then the next useful check.
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

async function remember(
  userId: number,
  networkId: string,
  role: "user" | "assistant",
  content: string,
) {
  await dbInsert("tg_ai_messages", {
    telegram_user_id: userId,
    network_id: networkId,
    role,
    content: content.slice(0, 12000),
  });
}

function promptWithMemory(memory: MemoryRow[], text: string) {
  if (!memory.length) return text;
  const history = memory
    .map((item) => `${item.role === "user" ? "User" : "Assistant"}: ${item.content}`)
    .join("\n");
  return `Recent conversation context:\n${history}\n\nCurrent user message:\n${text}`;
}

async function runIntelligentAgent(user: BotUser, network: Network, text: string) {
  const trace: string[] = [];
  const tools = buildTools(user, network, trace);
  const agent = new ToolLoopAgent({
    model: MODEL,
    instructions: instructions(network),
    tools,
    stopWhen: stepCountIs(6),
    maxOutputTokens: 1800,
    reasoning: "minimal",
  });

  const memory = await loadMemory(user.telegram_user_id, network.id);
  const result = await agent.generate({
    prompt: promptWithMemory(memory, text),
    timeout: 55000,
  });

  return {
    text: result.text?.trim() || "لم أستطع تكوين إجابة واضحة من البيانات المتاحة.",
    tools: trace,
  };
}

export async function runTelegramAITest(
  telegramUserId: number,
  networkId: string,
  text: string,
) {
  const userRows = await dbGet<BotUser>("tg_users", {
    telegram_user_id: `eq.${telegramUserId}`,
    select: "telegram_user_id,setup_state,active_network_id",
    limit: "1",
  });
  const user = userRows[0];
  if (!user) throw new Error("Telegram user not found");
  const network = await getNetworkById(telegramUserId, networkId);
  if (!network) throw new Error("Network not found for Telegram user");
  return runIntelligentAgent(user, network, text);
}

export async function handleTelegramAIV2(update: TgUpdate): Promise<boolean> {
  const message = update.message;
  if (!message?.from || !message.text) return false;
  const text = message.text.trim();
  if (!text || text.startsWith("/")) return false;

  const user = await ensureUser(message.from);
  if (!user) return false;
  // Router connection wizard must remain deterministic and must own its text input.
  if (user.setup_state && user.setup_state !== "idle") return false;

  const network = await activeNetwork(user);
  if (!network) {
    await send(
      message.chat.id,
      "ما عندك شبكة نشطة حتى الآن. استخدم /add لربط MikroTik، وبعدها كلّم البوت بطريقتك الطبيعية.",
    );
    return true;
  }

  await sendTyping(message.chat.id);
  try {
    await remember(user.telegram_user_id, network.id, "user", text);
    const result = await runIntelligentAgent(user, network, text);
    await remember(user.telegram_user_id, network.id, "assistant", result.text);
    await send(message.chat.id, result.text);
    return true;
  } catch (error) {
    console.error("Telegram AI v2 failed", error);
    await send(
      message.chat.id,
      `تعذر التحليل الذكي الآن، لكن الشبكة والأوامر التقليدية ما زالت تعمل. ${String(
        error instanceof Error ? error.message : error,
      ).slice(0, 180)}`,
    );
    return true;
  }
}
