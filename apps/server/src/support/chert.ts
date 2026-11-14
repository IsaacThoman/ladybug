import { createHmac, timingSafeEqual } from "node:crypto";

export function readMessagingConfig(env = process.env) {
  const key = env.CHERT_IMESSAGE_KEY?.trim(), line = env.CHERT_IMESSAGE_LINE_ID?.trim();
  const secret = env.CHERT_WEBHOOK_SECRET?.trim(), destination = env.EMERGENCY_NUMBER?.trim();
  if (!key || !line || !secret || !destination) return null;
  if (!/^\+[1-9]\d{6,14}$/.test(destination)) throw new Error("Invalid messaging emergency number");
  return { key, line, secret, destination, tenant: env.CHERT_TENANT_SLUG?.trim() };
}
export type MessagingConfig = NonNullable<ReturnType<typeof readMessagingConfig>>;

export function verifySignature(raw: Buffer, header: string, secret: string, now = Date.now()) {
  const match = /^(?:t=(\d+),v1=|v1,(\d+),)([a-f0-9]{64})$/i.exec(header);
  if (!match) return false;
  const timestamp = match[1] ?? match[2];
  if (Math.abs(now - Number(timestamp) * 1000) > 300_000) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(match[3], "hex"));
}

export class SendError extends Error {
  readonly transient: boolean;
  constructor(transient: boolean) { super("Chert message send failed"); this.transient = transient; }
}
export async function sendMessage(config: MessagingConfig, id: string, url: string, request = fetch) {
  let response: Response;
  try {
    response = await request("https://console.trychert.com/api/v1/send", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json", ...(config.tenant ? { "x-chert-tenant": config.tenant } : {}) },
      body: JSON.stringify({ phone: config.destination, phone_line_id: config.line, idempotency_key: id,
        body: `The user is accessing a website that might not be trustworthy: ${url}. If you would like to initiate a FaceTime call for support, reply SUPPORT.` }),
    });
  } catch { throw new SendError(true); }
  const result = await response.json().catch(() => null) as { status?: string; chat_id?: string; retryable?: boolean } | null;
  if (response.ok && result?.status === "sent" && typeof result.chat_id === "string" && result.chat_id) return result.chat_id;
  // Pending/duplicate responses are not evidence of successful delivery.
  throw new SendError(response.status === 429 || response.status >= 500 || result?.retryable === true);
}
