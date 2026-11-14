import { DEFAULT_SERVER_PORT } from "@ladybug/shared";
import type { GreetingResponse } from "@ladybug/shared";

const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ?? `http://localhost:${DEFAULT_SERVER_PORT}`;

export async function fetchGreeting(): Promise<string> {
  const res = await fetch(`${SERVER_URL}/api/greeting`);
  if (!res.ok) throw new Error(`Greeting request failed: ${res.status}`);
  const body = (await res.json()) as GreetingResponse;
  return body.message;
}
