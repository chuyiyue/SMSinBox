import { sha256Hex } from "./auth";

export const DEDUP_BUCKET_MS = 60_000;

export function normalizeContent(content: string): string {
  return content.replaceAll("\u3000", " ").replace(/\s+/g, " ").trim();
}

export function dedupBucket(receivedAt: number): number {
  return Math.floor(receivedAt / DEDUP_BUCKET_MS);
}

export async function dedupHash(input: {
  deviceId: string;
  from: string;
  content: string;
  receivedAt: number;
}): Promise<string> {
  const material = [
    input.deviceId,
    input.from.trim(),
    normalizeContent(input.content),
    String(dedupBucket(input.receivedAt)),
  ].join("\n");
  return sha256Hex(material);
}
