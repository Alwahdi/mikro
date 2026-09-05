import { dbGet } from "./telegram-db";
import { handleTelegramExtra, type TgUpdate } from "./telegram-extra";
import { handleTelegramUpdate } from "./telegram-bot";
import { handleTelegramNaturalFallback } from "./telegram-natural-fallback";
import { understandLocalMessage, type LocalNluContext } from "./telegram-nlu-v2";

type ContextRow = LocalNluContext & { telegram_user_id: number };

function withText(update: TgUpdate, text: string): TgUpdate {
  if (!update.message) return update;
  return { ...update, message: { ...update.message, text } };
}

async function loadContext(userId: number) {
  const rows = await dbGet<ContextRow>("tg_nlu_context", {
    telegram_user_id: `eq.${userId}`,
    select: "telegram_user_id,last_intent,last_entity_type,last_entity_value,updated_at",
    limit: "1",
  });
  return rows[0] ?? null;
}

export async function handleTelegramNaturalFallbackV2(update: TgUpdate): Promise<boolean> {
  const message = update.message;
  if (!message?.text || !message.from) return false;
  const raw = message.text.trim();
  if (!raw || raw.startsWith("/")) return false;

  const context = await loadContext(message.from.id);
  const parsed = understandLocalMessage(raw, context);

  // These are ambiguity corrections that the base fallback cannot safely infer.
  // All other intents are delegated to the mature contextual fallback.
  if (parsed.intent === "use_network" && parsed.entities.network_index) {
    await handleTelegramUpdate(withText(update, `/use ${parsed.entities.network_index}`));
    return true;
  }

  if (parsed.intent === "router" && /(?:رام|ram)/i.test(parsed.normalized)) {
    return handleTelegramExtra(withText(update, "/router"));
  }

  if (parsed.intent === "status" && /\bnetwork\b/i.test(parsed.normalized)) {
    await handleTelegramUpdate(withText(update, "/status"));
    return true;
  }

  if (parsed.intent === "diagnose" && /\bnetwork\b/i.test(parsed.normalized)) {
    await handleTelegramUpdate(withText(update, "/status"));
    await handleTelegramUpdate(withText(update, "/ping"));
    return true;
  }

  return handleTelegramNaturalFallback(update);
}
