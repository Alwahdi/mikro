import type { TgUpdate } from "./telegram-extra";
import { handleTelegramCardUniversal } from "./telegram-card-universal";
import { handleTelegramCommandRouter } from "./telegram-command-router";
import { handleTelegramSales } from "./telegram-sales";

const GEMINI_MODEL = "gemini-3.7-flash";
const INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

type JsonSchema = Record<string, unknown>;
type GeminiInput =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mime_type: string }
  | { type: "document"; data: string; mime_type: string };

type TemplateLayout = {
  username: { x: number; y: number; width: number; height: number; font_scale: number; align: "left" | "center" | "right" };
  password?: { x: number; y: number; width: number; height: number; font_scale: number; align: "left" | "center" | "right" } | null;
  confidence: number;
  notes?: string;
};

function apiKey() {
  return process.env.GEMINI_API_KEY?.trim() || "";
}

function clamp01(value: unknown, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

function extractText(payload: any) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  for (const step of payload?.steps || []) {
    if (step?.type !== "model_output") continue;
    for (const block of step?.content || []) {
      if (block?.type === "text" && typeof block?.text === "string") return block.text;
    }
  }
  return "";
}

async function geminiJson<T>(input: GeminiInput[], schema: JsonSchema): Promise<T | null> {
  const key = apiKey();
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch(INTERACTIONS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": key,
        "Api-Revision": "2026-05-20",
      },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        input,
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema,
        },
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const text = extractText(payload);
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function analyzeCardTemplate(bytes: Uint8Array, mimeType: string, hasPassword: boolean): Promise<TemplateLayout> {
  const isPdf = mimeType === "application/pdf";
  const media: GeminiInput = {
    type: isPdf ? "document" : "image",
    data: Buffer.from(bytes).toString("base64"),
    mime_type: mimeType,
  } as GeminiInput;
  const prompt = `You are analyzing a prepaid Wi-Fi card template for printing. Find the best blank/readable area for the dynamic username${hasPassword ? " and password" : " only"}. Return normalized coordinates from TOP-LEFT, each between 0 and 1. Do not place dynamic text over logos, prices, instructions, QR codes, or decorative text. Prefer an existing empty login/number box. font_scale is relative to the card height and should usually be 0.035-0.08. If there is no password field, password must be null.`;
  const schema: JsonSchema = {
    type: "object",
    properties: {
      username: {
        type: "object",
        properties: {
          x: { type: "number", minimum: 0, maximum: 1 },
          y: { type: "number", minimum: 0, maximum: 1 },
          width: { type: "number", minimum: 0.05, maximum: 1 },
          height: { type: "number", minimum: 0.02, maximum: 0.5 },
          font_scale: { type: "number", minimum: 0.015, maximum: 0.15 },
          align: { type: "string", enum: ["left", "center", "right"] },
        },
        required: ["x", "y", "width", "height", "font_scale", "align"],
      },
      password: {
        type: ["object", "null"],
        properties: {
          x: { type: "number", minimum: 0, maximum: 1 },
          y: { type: "number", minimum: 0, maximum: 1 },
          width: { type: "number", minimum: 0.05, maximum: 1 },
          height: { type: "number", minimum: 0.02, maximum: 0.5 },
          font_scale: { type: "number", minimum: 0.015, maximum: 0.15 },
          align: { type: "string", enum: ["left", "center", "right"] },
        },
      },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      notes: { type: "string" },
    },
    required: ["username", "password", "confidence"],
    additionalProperties: false,
  };
  const result = await geminiJson<TemplateLayout>([{ type: "text", text: prompt }, media], schema);
  if (!result?.username) {
    return {
      username: { x: 0.16, y: 0.62, width: 0.68, height: 0.12, font_scale: 0.055, align: "center" },
      password: hasPassword ? { x: 0.16, y: 0.76, width: 0.68, height: 0.1, font_scale: 0.045, align: "center" } : null,
      confidence: 0,
      notes: "fallback-layout",
    };
  }
  const normalizeBox = (box: any, fallbackY: number) => ({
    x: clamp01(box?.x, 0.16),
    y: clamp01(box?.y, fallbackY),
    width: Math.max(0.05, clamp01(box?.width, 0.68)),
    height: Math.max(0.02, clamp01(box?.height, 0.1)),
    font_scale: Math.max(0.015, Math.min(0.15, Number(box?.font_scale) || 0.05)),
    align: (["left", "center", "right"] as const).includes(box?.align) ? box.align : "center",
  });
  return {
    username: normalizeBox(result.username, 0.62),
    password: hasPassword && result.password ? normalizeBox(result.password, 0.76) : null,
    confidence: clamp01(result.confidence, 0.5),
    notes: result.notes || "",
  };
}

type Classified = {
  intent: "status" | "diagnose" | "online" | "sales" | "card" | "ping" | "vlans" | "vlan" | "router" | "networks" | "help" | "unknown";
  username?: string | null;
  vlan_id?: number | null;
  address?: string | null;
  confidence: number;
};

function clonedUpdate(update: TgUpdate, text: string): TgUpdate {
  return { ...update, message: update.message ? { ...update.message, text } : update.message };
}

export async function handleTelegramGeminiFallback(update: TgUpdate): Promise<boolean> {
  const message = update.message;
  const raw = message?.text?.trim();
  if (!raw || !message?.from || !apiKey()) return false;
  const schema: JsonSchema = {
    type: "object",
    properties: {
      intent: { type: "string", enum: ["status", "diagnose", "online", "sales", "card", "ping", "vlans", "vlan", "router", "networks", "help", "unknown"] },
      username: { type: ["string", "null"] },
      vlan_id: { type: ["integer", "null"], minimum: 1, maximum: 4094 },
      address: { type: ["string", "null"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["intent", "username", "vlan_id", "address", "confidence"],
    additionalProperties: false,
  };
  const prompt = `Classify this MikroTik network-owner Telegram request. The user may write Arabic dialect, misspellings, English, or mixed language. Only classify READ-ONLY requests. Any request that adds, deletes, disables, enables, disconnects, changes settings, changes passwords, changes profiles, or otherwise mutates the router MUST be intent unknown because mutations are handled by deterministic safety code. Never invent a username or VLAN. Request: ${JSON.stringify(raw)}`;
  const result = await geminiJson<Classified>([{ type: "text", text: prompt }], schema);
  if (!result || result.confidence < 0.72 || result.intent === "unknown") return false;

  if (result.intent === "card" && result.username) {
    return handleTelegramCardUniversal(clonedUpdate(update, `/card ${result.username}`));
  }
  if (result.intent === "sales") return handleTelegramSales(clonedUpdate(update, "/sales"));
  const command =
    result.intent === "status" ? "/status" :
    result.intent === "diagnose" ? "/diagnose" :
    result.intent === "online" ? "/online" :
    result.intent === "ping" ? `/ping ${result.address || "8.8.8.8"}` :
    result.intent === "vlans" ? "/vlans" :
    result.intent === "vlan" && result.vlan_id ? `/vlan ${result.vlan_id}` :
    result.intent === "router" ? "/router" :
    result.intent === "networks" ? "/networks" :
    result.intent === "help" ? "/help" : "";
  if (!command) return false;
  return handleTelegramCommandRouter(clonedUpdate(update, command));
}
