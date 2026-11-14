export const now = () => new Date().toISOString();

export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message.split("\n")[0] ?? error.message;
  return String(error);
}

export function truncate(text: string, max: number) {
  return text.length > max ? text.slice(0, max) : text;
}

/** Appends to a list, dropping new items once it holds `cap`. */
export function pushCapped<T>(list: T[], item: T, cap: number) {
  if (list.length < cap) list.push(item);
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
