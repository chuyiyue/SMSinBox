const MAX_LIKE_PATTERN_BYTES = 50;

export type LikeQuery = { ok: true; pattern: string | null } | { ok: false; error: string };

export function messageMatchesQuery(
  message: { content: string; from_number: string; code: string | null },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${message.content}\n${message.from_number}\n${message.code ?? ""}`.toLowerCase().includes(needle);
}

export function compileLikeQuery(query: string | null): LikeQuery {
  if (!query?.trim()) return { ok: true, pattern: null };
  const escaped = query.trim().replace(/[\\%_]/g, (char) => `\\${char}`);
  const pattern = `%${escaped}%`;
  if (new TextEncoder().encode(pattern).byteLength > MAX_LIKE_PATTERN_BYTES) {
    return { ok: false, error: "关键词过长（LIKE 模式最多 50 字节）" };
  }
  return { ok: true, pattern };
}
