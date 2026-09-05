import { dbGet, dbPatch, dbUpsert } from "./telegram-db";
import { handleTelegramCardUniversal } from "./telegram-card-universal";
import { handleTelegramExtra, type TgUpdate } from "./telegram-extra";
import { handleTelegramSales } from "./telegram-sales";
import { handleTelegramUpdate } from "./telegram-bot";
import {
  normalizeLocalText,
  understandLocalMessage,
  type LocalIntent,
  type LocalNluContext,
} from "./telegram-nlu";

type BotUser = {
  telegram_user_id: number;
  setup_state: string;
  active_network_id?: string | null;
};

type Network = {
  id: string;
  label: string;
};

type ContextRow = LocalNluContext & {
  telegram_user_id: number;
  network_id?: string | null;
  last_command?: string | null;
  metadata?: Record<string, unknown> | null;
};

function botToken() {
  const value = process.env.TELEGRAM_BOT_TOKEN;
  if (!value) throw new Error("TELEGRAM_BOT_TOKEN is missing");
  return value;
}

async function send(chatId: number, text: string, reply_markup?: unknown) {
  const response = await fetch(`https://api.telegram.org/bot${botToken()}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup,
    }),
    cache: "no-store",
  });
  const json = await response.json();
  if (!json.ok) throw new Error(json.description || `Telegram ${response.status}`);
  return json.result;
}

function esc(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function withText(update: TgUpdate, text: string): TgUpdate {
  if (!update.message) return update;
  return { ...update, message: { ...update.message, text } };
}

async function loadUser(userId: number) {
  const rows = await dbGet<BotUser>("tg_users", {
    telegram_user_id: `eq.${userId}`,
    select: "telegram_user_id,setup_state,active_network_id",
    limit: "1",
  });
  return rows[0] ?? null;
}

async function loadContext(userId: number): Promise<ContextRow | null> {
  const rows = await dbGet<ContextRow>("tg_nlu_context", {
    telegram_user_id: `eq.${userId}`,
    select: "telegram_user_id,network_id,last_intent,last_entity_type,last_entity_value,last_command,metadata,updated_at",
    limit: "1",
  });
  return rows[0] ?? null;
}

async function remember(
  user: BotUser,
  intent: LocalIntent,
  command: string,
  entityType?: string,
  entityValue?: string,
  metadata: Record<string, unknown> = {},
) {
  await dbUpsert(
    "tg_nlu_context",
    {
      telegram_user_id: user.telegram_user_id,
      network_id: user.active_network_id ?? null,
      last_intent: intent,
      last_entity_type: entityType ?? null,
      last_entity_value: entityValue ?? null,
      last_command: command,
      metadata,
      updated_at: new Date().toISOString(),
    },
    "telegram_user_id",
  );
}

async function listNetworks(userId: number) {
  return dbGet<Network>("tg_networks", {
    telegram_user_id: `eq.${userId}`,
    select: "id,label",
    order: "created_at.asc",
  });
}

function bestNetworkIndex(networks: Network[], raw: string, explicitName?: string) {
  const normalized = normalizeLocalText(raw);
  const target = explicitName ? normalizeLocalText(explicitName) : "";

  let best = -1;
  let bestScore = 0;
  networks.forEach((network, index) => {
    const label = normalizeLocalText(network.label);
    let score = 0;
    if (target && label === target) score = 100;
    else if (target && (label.includes(target) || target.includes(label))) score = 80;
    else if (normalized.includes(label)) score = 70;
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best >= 0 ? best + 1 : null;
}

async function useNetworkNatural(
  update: TgUpdate,
  user: BotUser,
  index?: number,
  name?: string,
) {
  const chatId = update.message!.chat.id;
  const networks = await listNetworks(user.telegram_user_id);
  if (!networks.length) {
    await send(chatId, "📭 ما عندك شبكات مرتبطة حتى الآن. أرسل «أضف شبكة» أو استخدم /add.");
    return true;
  }

  const resolved = index || bestNetworkIndex(networks, update.message!.text || "", name);
  if (!resolved || resolved < 1 || resolved > networks.length) {
    await send(
      chatId,
      `📡 عندك <b>${networks.length}</b> شبكة. قل مثلاً «استخدم الثانية» أو اكتب اسم الشبكة كما يظهر في /networks.`,
    );
    await remember(user, "networks", "/networks");
    return true;
  }

  await handleTelegramUpdate(withText(update, `/use ${resolved}`));
  const chosen = networks[resolved - 1];
  await remember(user, "use_network", `/use ${resolved}`, "network", chosen.id, { label: chosen.label, index: resolved });
  return true;
}

async function handleUnknown(update: TgUpdate, normalized: string) {
  const chatId = update.message!.chat.id;
  let hint = "";
  if (/\d{5,20}/.test(normalized)) hint = "\n🎫 إذا هذا رقم كرت، اكتب فقط الرقم أو قل: «افحص الكرت 15352951».";
  else if (/vlan|فيلان|فلان/.test(normalized)) hint = "\n🧩 مثال: «شوف VLAN 202» أو «اعرض الفيلانات».";
  else if (/نت|شبك|internet|network/.test(normalized)) hint = "\n🌐 مثال: «افحص الشبكة» أو «ليش النت بطيء؟».";

  await send(
    chatId,
    `🤝 فهمت جزء من كلامك، لكن ما قدرت أحدد المطلوب بدقة كافية حتى ما أعطيك نتيجة غلط.${hint}\n\nتقدر تكتب بشكل طبيعي مثل:\n• كم واحد متصل الآن؟\n• افحص الكرت 15352951\n• كم مبيعات اليوم؟\n• شوف VLAN 202\n• ليش النت بطيء؟\n• وش معلومات الراوتر؟\n• اعرض شبكاتي ثم استخدم الثانية`,
  );
  return true;
}

export async function handleTelegramNaturalFallback(update: TgUpdate): Promise<boolean> {
  const message = update.message;
  if (!message?.text || !message.from) return false;
  const raw = message.text.trim();
  if (!raw || raw.startsWith("/")) return false;

  const user = await loadUser(message.from.id);
  if (!user) return false;
  const context = await loadContext(message.from.id);
  const parsed = understandLocalMessage(raw, context);

  // During the add-network wizard, do not steal ordinary answers such as label/host/username.
  // Natural-language cancellation remains allowed.
  if (user.setup_state && user.setup_state !== "idle" && parsed.intent !== "cancel") return false;

  const chatId = message.chat.id;

  if (parsed.intent === "greeting") {
    await send(
      chatId,
      `هلا ${esc(message.from.first_name || "")} 👋\nأنا جاهز للشبكة. اسألني بطريقتك؛ مثلاً «كم واحد متصل؟»، «افحص كرت»، «مبيعات اليوم»، أو «ليش النت بطيء؟».`,
    );
    await remember(user, "greeting", "greeting");
    return true;
  }

  if (parsed.intent === "thanks") {
    await send(chatId, "تسلم 🌟 أنا جاهز. إذا عندك أي شيء بالشبكة ارسله مباشرة.");
    await remember(user, "thanks", "thanks");
    return true;
  }

  if (parsed.intent === "cancel") {
    await handleTelegramUpdate(withText(update, "/cancel"));
    await remember(user, "cancel", "/cancel");
    return true;
  }

  if (parsed.intent === "add_network") {
    await handleTelegramUpdate(withText(update, "/add"));
    await remember(user, "add_network", "/add");
    return true;
  }

  if (parsed.intent === "networks") {
    await handleTelegramUpdate(withText(update, "/networks"));
    await remember(user, "networks", "/networks");
    return true;
  }

  if (parsed.intent === "use_network") {
    return useNetworkNatural(
      update,
      user,
      parsed.entities.network_index,
      parsed.entities.network_name,
    );
  }

  if (parsed.intent === "help") {
    await handleTelegramExtra(withText(update, "/help"));
    await remember(user, "help", "/help");
    return true;
  }

  if (parsed.intent === "card" && parsed.entities.card) {
    const card = parsed.entities.card;
    const handled = await handleTelegramCardUniversal(withText(update, `/card ${card}`));
    await remember(user, "card", `/card ${card}`, "card", card);
    return handled;
  }

  if (parsed.intent === "online") {
    const handled = await handleTelegramExtra(withText(update, "/online"));
    await remember(user, "online", "/online");
    return handled;
  }

  if (parsed.intent === "sales") {
    const handled = await handleTelegramSales(withText(update, "/sales"));
    await remember(user, "sales", "/sales");
    return handled;
  }

  if (parsed.intent === "vlan_detail" && parsed.entities.vlan_id) {
    const vlan = parsed.entities.vlan_id;
    await handleTelegramUpdate(withText(update, `/vlan ${vlan}`));
    await remember(user, "vlan_detail", `/vlan ${vlan}`, "vlan", String(vlan));
    return true;
  }

  if (parsed.intent === "vlans") {
    const handled = await handleTelegramExtra(withText(update, "/vlans"));
    await remember(user, "vlans", "/vlans");
    return handled;
  }

  if (parsed.intent === "router") {
    const handled = await handleTelegramExtra(withText(update, "/router"));
    await remember(user, "router", "/router");
    return handled;
  }

  if (parsed.intent === "ping") {
    // Current deterministic RouterOS command uses the safe default 8.8.8.8.
    // Custom targets are preserved in context for the next action-engine upgrade.
    await handleTelegramUpdate(withText(update, "/ping"));
    await remember(user, "ping", "/ping", parsed.entities.ping_host ? "host" : undefined, parsed.entities.ping_host);
    return true;
  }

  if (parsed.intent === "status") {
    await handleTelegramUpdate(withText(update, "/status"));
    await remember(user, "status", "/status");
    return true;
  }

  if (parsed.intent === "diagnose") {
    await send(chatId, "🔎 تمام، بفحص لك حالة الشبكة والإنترنت الآن بدون ما أغير أي إعداد.");
    await handleTelegramUpdate(withText(update, "/status"));
    await handleTelegramUpdate(withText(update, "/ping"));
    await remember(user, "diagnose", "/status + /ping");
    return true;
  }

  return handleUnknown(update, parsed.normalized);
}
