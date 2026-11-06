import { readChatResponse, resolveAiModel } from "./ai-model";
import { errorText, logError } from "./log";

// Many-to-many translation. Cloudflare's published example passes full
// language names ("english", "french"), not ISO codes.
export const M2M_MODEL = "@cf/meta/m2m100-1.2b";

// Chat-model fallback for translations m2m100 rejects or cannot serve.
// The model is the shared AI model resolved in ai-model.ts (the
// AI_MODEL Worker secret when configured, otherwise the built-in
// default) — the same model code recognition uses. The default model
// answers in the OpenAI chat-completion shape instead of the native
// { response } shape; readLlama accepts both via readChatResponse.
export const TRANSLATE_TIMEOUT_MS = 6_000;

// Translations always land in the system language: the UI locale of the
// user who owns the inbox. m2m100 target_lang takes the model's full
// language name for that locale.
export type TranslateTarget = "zh-CN" | "en";
export const M2M_TARGET_LANG: Record<TranslateTarget, string> = {
  "zh-CN": "chinese",
  en: "english",
};

// Language code from detection → the name m2m100 expects. Both Chinese
// codes share the model's single Chinese name; a result that still equals
// the source fails validation and falls through to Llama.
export const M2M_LANG_NAME: Record<string, string> = {
  en: "english",
  ja: "japanese",
  ko: "korean",
  ru: "russian",
  uk: "ukrainian",
  th: "thai",
  ar: "arabic",
  hi: "hindi",
  el: "greek",
  he: "hebrew",
  fr: "french",
  de: "german",
  es: "spanish",
  it: "italian",
  pt: "portuguese",
  nl: "dutch",
  vi: "vietnamese",
  id: "indonesian",
  "zh-Hant": "chinese",
  "zh-Hans": "chinese",
};

// Shown on bilingual pushes. Unknown codes fall back to the code itself.
export const SOURCE_LANG_LABEL: Record<string, string> = {
  en: "英语",
  ja: "日语",
  ko: "韩语",
  ru: "俄语",
  uk: "乌克兰语",
  th: "泰语",
  ar: "阿拉伯语",
  hi: "印地语",
  el: "希腊语",
  he: "希伯来语",
  fr: "法语",
  de: "德语",
  es: "西班牙语",
  it: "意大利语",
  pt: "葡萄牙语",
  nl: "荷兰语",
  vi: "越南语",
  id: "印尼语",
  "zh-Hant": "繁体中文",
  "zh-Hans": "简体中文",
};

export function sourceLangLabel(code: string | null | undefined): string {
  if (!code) return "未知";
  return SOURCE_LANG_LABEL[code] ?? code;
}

// English names for the same codes, used when the system language is
// English. Unknown codes fall back to the code itself.
export const SOURCE_LANG_LABEL_EN: Record<string, string> = {
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  ru: "Russian",
  uk: "Ukrainian",
  th: "Thai",
  ar: "Arabic",
  hi: "Hindi",
  el: "Greek",
  he: "Hebrew",
  fr: "French",
  de: "German",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  vi: "Vietnamese",
  id: "Indonesian",
  "zh-Hant": "Traditional Chinese",
  "zh-Hans": "Simplified Chinese",
};

export function sourceLangLabelEn(code: string | null | undefined): string {
  if (!code) return "Unknown";
  return SOURCE_LANG_LABEL_EN[code] ?? code;
}

const LLAMA_MAX_TOKENS = 1024;

// Glyphs that are traditional and are not the simplified form of the same
// word. One hit in an otherwise Han message is enough to call it zh-Hant.
const TRADITIONAL_HINTS = new Set(
  "們麼麽這裡點過還體國學萬與臺個為時會來對說後從開關長門問間電話機網請發現經業產東車書無應該讓認識語訊號碼驗證確認賬錄洩給".split(
    "",
  ),
);

const UKRAINIAN_HINTS = new Set("іїєґІЇЄҐ".split(""));

const LATIN_STOPWORDS: Record<string, readonly string[]> = {
  en: ["the", "and", "you", "your", "please", "this", "that", "with", "from", "have", "verification", "not", "share", "code", "is", "are", "for", "was", "package", "arrived"],
  fr: ["vous", "votre", "pour", "dans", "avec", "est", "une", "des", "pas", "vérification", "veuillez", "bonjour", "merci"],
  de: ["ihr", "ihre", "ihren", "bitte", "lautet", "nicht", "und", "für", "danke", "bestätigungscode", "ist"],
  es: ["código", "verificación", "está", "gracias", "para", "favor", "hola", "usted"],
  it: ["codice", "verifica", "grazie", "buongiorno", "tuo", "per", "favore", "sono"],
  pt: ["você", "código", "verificação", "obrigado", "não", "seu", "uma", "para"],
  nl: ["uw", "niet", "voor", "verificatiecode", "alstublieft", "dank", "het"],
  vi: ["không", "của", "bạn", "được", "trong", "mã", "xác", "minh", "là"],
  id: ["anda", "tidak", "untuk", "dengan", "kode", "adalah", "yang", "verifikasi"],
};

const LATIN_LANGS = ["en", "fr", "de", "es", "it", "pt", "nl", "vi", "id"] as const;

type Script =
  | "kana"
  | "han"
  | "hangul"
  | "cyrillic"
  | "thai"
  | "arabic"
  | "devanagari"
  | "greek"
  | "hebrew"
  | "latin";

const SCRIPT_ORDER: readonly Script[] = [
  "kana",
  "han",
  "hangul",
  "cyrillic",
  "thai",
  "arabic",
  "devanagari",
  "greek",
  "hebrew",
  "latin",
];

export type SmsTranslation = { translated: string; sourceLang: string };

// Null means "do not translate": simplified Chinese, or not enough letters
// left after URLs, digits, and verification-code tokens are stripped.
export function detectSourceLang(content: string): string | null {
  const cleaned = stripNoise(content);
  const counts = countScripts(cleaned);
  const total = SCRIPT_ORDER.reduce((sum, script) => sum + counts[script], 0);
  if (total < 4) return null;

  if (counts.kana > 0 && counts.han > 0) {
    const others = total - counts.kana - counts.han;
    if (counts.kana + counts.han >= others) return "ja";
  }

  let best: Script | null = null;
  let bestCount = 0;
  for (const script of SCRIPT_ORDER) {
    if (counts[script] > bestCount) {
      best = script;
      bestCount = counts[script];
    }
  }
  if (!best) return null;

  switch (best) {
    case "kana":
      return "ja";
    case "han":
      return hasTraditional(cleaned) ? "zh-Hant" : null;
    case "hangul":
      return "ko";
    case "cyrillic":
      return hasUkrainian(cleaned) ? "uk" : "ru";
    case "thai":
      return "th";
    case "arabic":
      return "ar";
    case "devanagari":
      return "hi";
    case "greek":
      return "el";
    case "hebrew":
      return "he";
    case "latin":
      return sniffLatin(cleaned);
    default:
      return null;
  }
}

// The source language to translate from for a given target, or null for
// "already in the system language / not enough signal". detectSourceLang
// returns null for simplified Chinese, which is the skip answer for a
// zh-CN target — but for an English target it is exactly what still needs
// translating, so it is re-checked and reported as "zh-Hans".
function sourceForTarget(content: string, target: TranslateTarget): string | null {
  const detected = detectSourceLang(content);
  if (target === "zh-CN") return detected;
  if (detected === "en") return null;
  if (detected) return detected;
  return isSimplifiedChinese(content) ? "zh-Hans" : null;
}

function isSimplifiedChinese(content: string): boolean {
  const cleaned = stripNoise(content);
  if (hasTraditional(cleaned)) return false;
  return countScripts(cleaned).han >= 4;
}

// Never throws. A missing binding, timeout, or rejected model output is null
// so ingest can store the original SMS unchanged.
export async function translateSmsContent(
  env: Env,
  content: string,
  target: TranslateTarget = "zh-CN",
): Promise<SmsTranslation | null> {
  const sourceLang = sourceForTarget(content, target);
  if (!sourceLang) return null;
  try {
    const primary = await runM2M(env.AI, content, sourceLang, target);
    if (primary.ok) return { translated: primary.text, sourceLang };
    const fallback = await runLlama(env.AI, resolveAiModel(env), content, sourceLang, target);
    if (fallback.ok) return { translated: fallback.text, sourceLang };
    const error = `${primary.error}; ${fallback.error}`.slice(0, 180);
    logError({ message: "sms_translate_failed", source_lang: sourceLang, error });
    return null;
  } catch (error) {
    logError({ message: "sms_translate_failed", source_lang: sourceLang, error: errorText(error) });
    return null;
  }
}

type Attempt = { ok: true; text: string } | { ok: false; error: string };

async function runM2M(
  ai: Ai | undefined,
  content: string,
  sourceLang: string,
  target: TranslateTarget,
): Promise<Attempt> {
  if (!ai || typeof ai.run !== "function") return { ok: false, error: "ai_unavailable" };
  const sourceName = M2M_LANG_NAME[sourceLang];
  if (!sourceName) return { ok: false, error: "unknown_lang" };
  try {
    const output = await withTimeout(
      ai.run(M2M_MODEL, {
        text: content,
        source_lang: sourceName,
        target_lang: M2M_TARGET_LANG[target],
      }),
      TRANSLATE_TIMEOUT_MS,
    );
    const text = acceptTranslation(readM2M(output), content, false);
    if (!text) return { ok: false, error: "m2m_rejected" };
    return { ok: true, text };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

async function runLlama(
  ai: Ai | undefined,
  model: string,
  content: string,
  sourceLang: string,
  target: TranslateTarget,
): Promise<Attempt> {
  if (!ai || typeof ai.run !== "function") return { ok: false, error: "ai_unavailable" };
  try {
    const output = await withTimeout(
      ai.run(model, {
        messages: [
          { role: "system", content: llamaSystemPrompt(sourceLang, target) },
          { role: "user", content },
        ],
        temperature: 0,
        max_tokens: LLAMA_MAX_TOKENS,
      }),
      TRANSLATE_TIMEOUT_MS,
    );
    // Length cap and "must differ from the source" both apply here.
    // zh-Hant → simplified has to change glyphs, so equality is a failure
    // for that pair too (the model echoed traditional instead of converting).
    const text = acceptTranslation(readLlama(output), content, true);
    if (!text) return { ok: false, error: "llama_rejected" };
    return { ok: true, text };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

function llamaSystemPrompt(sourceLang: string, target: TranslateTarget): string {
  if (target === "en") {
    return [
      "You are an SMS translator.",
      `Translate the SMS message given by the user from ${sourceLang} into English.`,
      "Output only the translation itself: no explanations, no quotes, no prefix or suffix, and not the original text.",
      "If the message is already in English, output the original text unchanged.",
    ].join(" ");
  }
  return [
    "你是短信翻译器。",
    `把用户给出的短信正文从 ${sourceLang} 翻译成简体中文。`,
    "只输出译文本身，不要解释，不要加引号、前后缀或原文。",
    "如果正文已经是简体中文，只输出原文。",
  ].join("");
}

function readM2M(output: unknown): string | null {
  if (typeof output !== "object" || output === null) return null;
  const translated = (output as { translated_text?: unknown }).translated_text;
  if (typeof translated !== "string") return null;
  if (translated.trim().toUpperCase().startsWith("ERROR")) return null;
  const text = cleanTranslation(translated);
  return text || null;
}

function readLlama(output: unknown): string | null {
  // Shared dual-shape reader (ai-model.ts): the native { response }
  // shape and the OpenAI chat-completion shape are both accepted, so
  // the fallback keeps working across model swaps.
  const raw = readChatResponse(output);
  if (raw === null) return null;
  const text = cleanTranslation(raw);
  return text || null;
}

function cleanTranslation(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^(?:译文|翻译|简体中文|簡體中文|Translation)\s*[:：]\s*/u, "");
  if (
    (text.startsWith("「") && text.endsWith("」")) ||
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("“") && text.endsWith("”"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text.trim();
}

function acceptTranslation(translated: string | null, content: string, checkLength: boolean): string | null {
  if (!translated) return null;
  const text = translated.trim();
  if (!text) return null;
  if (text === content.trim()) return null;
  if (checkLength && content.length > 0 && text.length > content.length * 3) return null;
  return text;
}

function stripNoise(content: string): string {
  let text = content.normalize("NFKC");
  text = text.replace(/https?:\/\/\S+/gi, " ");
  text = text.replace(/\bwww\.\S+/gi, " ");
  text = text.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, " ");
  text = text.replace(/\b(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{4,8}\b/g, " ");
  text = text.replace(/\d+/g, " ");
  return text;
}

function countScripts(text: string): Record<Script, number> {
  const counts: Record<Script, number> = {
    kana: 0,
    han: 0,
    hangul: 0,
    cyrillic: 0,
    thai: 0,
    arabic: 0,
    devanagari: 0,
    greek: 0,
    hebrew: 0,
    latin: 0,
  };
  for (const char of text) {
    const script = scriptOf(char.codePointAt(0) ?? 0);
    if (script) counts[script] += 1;
  }
  return counts;
}

function scriptOf(cp: number): Script | null {
  if (isDigit(cp)) return null;
  if ((cp >= 0x3040 && cp <= 0x309f) || (cp >= 0x30a0 && cp <= 0x30ff) || (cp >= 0xff66 && cp <= 0xff9d)) {
    return "kana";
  }
  if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0xf900 && cp <= 0xfaff)) {
    return "han";
  }
  if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3130 && cp <= 0x318f)) {
    return "hangul";
  }
  if ((cp >= 0x0400 && cp <= 0x04ff) || (cp >= 0x0500 && cp <= 0x052f)) return "cyrillic";
  if (cp >= 0x0e00 && cp <= 0x0e7f) return "thai";
  if (cp >= 0x0590 && cp <= 0x05ff) return "hebrew";
  if (
    (cp >= 0x0600 && cp <= 0x06ff) ||
    (cp >= 0x0750 && cp <= 0x077f) ||
    (cp >= 0x08a0 && cp <= 0x08ff) ||
    (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff)
  ) {
    return "arabic";
  }
  if (cp >= 0x0900 && cp <= 0x097f) return "devanagari";
  if ((cp >= 0x0370 && cp <= 0x03ff) || (cp >= 0x1f00 && cp <= 0x1fff)) return "greek";
  if (
    (cp >= 0x0041 && cp <= 0x005a) ||
    (cp >= 0x0061 && cp <= 0x007a) ||
    (cp >= 0x00c0 && cp <= 0x024f) ||
    (cp >= 0x1e00 && cp <= 0x1eff)
  ) {
    return "latin";
  }
  return null;
}

function isDigit(cp: number): boolean {
  return (
    (cp >= 0x30 && cp <= 0x39) ||
    (cp >= 0xff10 && cp <= 0xff19) ||
    (cp >= 0x0660 && cp <= 0x0669) ||
    (cp >= 0x06f0 && cp <= 0x06f9) ||
    (cp >= 0x0966 && cp <= 0x096f) ||
    (cp >= 0x0e50 && cp <= 0x0e59)
  );
}

function hasTraditional(text: string): boolean {
  for (const char of text) if (TRADITIONAL_HINTS.has(char)) return true;
  return false;
}

function hasUkrainian(text: string): boolean {
  for (const char of text) if (UKRAINIAN_HINTS.has(char)) return true;
  return false;
}

function sniffLatin(text: string): string {
  const words = [...text.toLowerCase().matchAll(/\p{L}+/gu)].map((match) => match[0]).filter((word) => word.length >= 2);
  let best: (typeof LATIN_LANGS)[number] = "en";
  let bestScore = 0;
  for (const lang of LATIN_LANGS) {
    const dict = LATIN_STOPWORDS[lang] ?? [];
    let score = 0;
    for (const word of words) if (dict.includes(word)) score += 1;
    if (lang === "vi" && /[ăâêôơưđ]/i.test(text)) score += 2;
    if (score > bestScore) {
      best = lang;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : "en";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("ai_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
