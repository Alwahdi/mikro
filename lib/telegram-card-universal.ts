import { dbGet, dbInsert } from "./telegram-db";
import { handleTelegramCard } from "./telegram-card";
import type { TgUpdate } from "./telegram-extra";

type BotUser = {
  telegram_user_id: number;
  active_network_id?: string | null;
};

type Network = {
  id: string;
  telegram_user_id: number;
  label: string;
  connection_mode: "direct" | "agent";
  agent_last_seen_at?: string | null;
};

function token() {
  const value = process.env.TELEGRAM_BOT_TOKEN;
  if (!value) throw new Error("TELEGRAM_BOT_TOKEN is missing");
  return value;
}

function esc(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function send(chatId: number, text: string) {
  const response = await fetch(`https://api.telegram.org/bot${token()}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    cache: "no-store",
  });
  const json = await response.json();
  if (!json.ok) throw new Error(json.description || `Telegram ${response.status}`);
  return json.result;
}

async function activeNetwork(userId: number) {
  const users = await dbGet<BotUser>("tg_users", {
    telegram_user_id: `eq.${userId}`,
    select: "telegram_user_id,active_network_id",
    limit: "1",
  });
  const id = users[0]?.active_network_id;
  if (!id) return null;
  const networks = await dbGet<Network>("tg_networks", {
    id: `eq.${id}`,
    telegram_user_id: `eq.${userId}`,
    select: "id,telegram_user_id,label,connection_mode,agent_last_seen_at",
    limit: "1",
  });
  return networks[0] ?? null;
}

export async function handleTelegramCardUniversal(update: TgUpdate): Promise<boolean> {
  const message = update.message;
  if (!message?.from || !message.text) return false;
  const match = /^\/card(?:@\w+)?\s+([^\s]+)$/i.exec(message.text.trim());
  if (!match) return false;

  const username = match[1].replace(/[|\r\n]/g, "").slice(0, 128);
  const network = await activeNetwork(message.from.id);
  if (!network || network.connection_mode !== "agent") {
    return handleTelegramCard(update);
  }

  const lastSeen = network.agent_last_seen_at ? new Date(network.agent_last_seen_at).getTime() : 0;
  const agentOnline = Date.now() - lastSeen < 60_000;
  const waiting = await send(
    message.chat.id,
    `${agentOnline ? "🔎" : "🟠"} <b>${esc(network.label)}</b>\nجاري فحص الكرت <code>${esc(username)}</code> عبر Agent...`,
  );

  await dbInsert(
    "tg_agent_commands",
    {
      network_id: network.id,
      telegram_user_id: message.from.id,
      chat_id: message.chat.id,
      reply_message_id: waiting.message_id,
      kind: "card",
      payload: { username },
      status: "pending",
    },
    "id",
  );
  return true;
}
