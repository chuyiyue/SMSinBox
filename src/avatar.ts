// Custom avatars are data URLs stored verbatim in schema_meta. The cap is the
// length of that string, not the decoded image, so a request can be rejected
// before it is decoded.
export const AVATAR_MAX_CHARS = 400 * 1024;
// JSON wrapping around a max-size data URL. Larger bodies are refused as too big.
export const AVATAR_BODY_MAX = AVATAR_MAX_CHARS + 1024;

const DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/;

export function parseAvatarDataUrl(image: string): { ok: true; dataUrl: string } | { ok: false; error: string } {
  if (image.length > AVATAR_MAX_CHARS) return { ok: false, error: "图片过大，请控制在 400KB 以内" };
  const match = DATA_URL_RE.exec(image);
  if (!match) {
    if (/^data:image\/(png|jpeg|webp);base64,/.test(image)) return { ok: false, error: "图片数据无效" };
    return { ok: false, error: "仅支持 PNG、JPEG 或 WebP 图片" };
  }
  const kind = match[1]!;
  const payload = match[2] ?? "";
  if (payload.length === 0 || payload.length % 4 !== 0) return { ok: false, error: "图片数据无效" };
  const bytes = decodeBase64(payload);
  if (!bytes || !magicMatches(kind, bytes)) return { ok: false, error: "图片数据无效" };
  return { ok: true, dataUrl: image };
}

function decodeBase64(payload: string): Uint8Array | null {
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function magicMatches(kind: string, bytes: Uint8Array): boolean {
  if (kind === "png") {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (kind === "jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (kind === "webp") {
    return (
      bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    );
  }
  return false;
}
