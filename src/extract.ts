const CODE_WINDOW = 40;

const KEYWORD_RE =
  /短信验证码|验证代码|验证码|校验码|动态密码|动态码|确认码|安全码|verification\s*code|verifying\s*code|verify\s*code|security\s*code|one[-\s]?time\s*(?:password|code|pin)|(?<![a-z])passcode(?![a-z])|(?<![a-z])pin\s*code(?![a-z])|(?<![a-z])otp(?![a-z])|(?<![a-z])your\s+code(?=\s*(?:is|[:：]))|(?<![a-z])code(?=\s*(?:is|[:：]))/gi;

export function extractCode(content: string): string | null {
  const text = foldDigits(content).replaceAll("\u3000", " ");
  const keywords: Array<{ start: number; end: number }> = [];
  KEYWORD_RE.lastIndex = 0;
  for (const match of text.matchAll(KEYWORD_RE)) {
    if (match.index === undefined) continue;
    keywords.push({ start: match.index, end: match.index + match[0].length });
  }
  if (keywords.length === 0) return null;

  const candidates: Array<{ code: string; distance: number; index: number }> = [];
  const consider = (code: string, index: number, end: number) => {
    let distance = Number.POSITIVE_INFINITY;
    for (const keyword of keywords) {
      let gap: number;
      if (index >= keyword.end) gap = index - keyword.end;
      else if (end <= keyword.start) gap = keyword.start - end;
      else gap = 0;
      if (gap < distance) distance = gap;
    }
    if (distance <= CODE_WINDOW) candidates.push({ code, distance, index });
  };
  for (const match of text.matchAll(/\d{4,8}/g)) {
    const index = match.index;
    if (index === undefined) continue;
    const code = match[0];
    if (index > 0 && isAsciiDigit(text[index - 1]!)) continue;
    const end = index + code.length;
    if (end < text.length && isAsciiDigit(text[end]!)) continue;
    consider(code, index, end);
  }
  // Grouped codes ("613-408", "613 408"): two short digit runs joined by
  // one separator count as one code with the separator dropped. The
  // guards keep date chains like 2026-10-31 from matching: a group may
  // not be preceded by a digit or a digit-hyphen pair, nor followed by
  // another hyphen-digit group.
  for (const match of text.matchAll(/(?<!\d)(?<!\d-)(\d{2,4})[- ](\d{2,4})(?!\d)(?!-\d)/g)) {
    const index = match.index;
    if (index === undefined) continue;
    consider(match[1]! + match[2]!, index, index + match[0].length);
  }

  const preferred = candidates.filter((candidate) => !isLikelyYear(candidate.code) || candidate.distance <= 1);
  if (preferred.length === 0) return null;
  preferred.sort(
    (left, right) =>
      left.distance - right.distance || right.index - left.index || right.code.length - left.code.length,
  );
  return preferred[0]?.code ?? null;
}

export function foldDigits(value: string): string {
  return value.replace(/[\uFF10-\uFF19]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30));
}

function isAsciiDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isLikelyYear(code: string): boolean {
  return code.length === 4 && (code.startsWith("19") || code.startsWith("20"));
}
