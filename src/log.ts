export function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 180) : "unknown";
}

export function logInfo(fields: Record<string, string | number | boolean | null>): void {
  console.log(JSON.stringify({ level: "info", ...fields }));
}

export function logError(fields: Record<string, string | number | boolean | null>): void {
  console.error(JSON.stringify({ level: "error", ...fields }));
}
