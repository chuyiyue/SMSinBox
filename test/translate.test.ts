import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FALLBACK_MODEL,
  M2M_LANG_NAME,
  M2M_MODEL,
  M2M_TARGET_LANG,
  SOURCE_LANG_LABEL,
  SOURCE_LANG_LABEL_EN,
  TRANSLATE_TIMEOUT_MS,
  detectSourceLang,
  sourceLangLabel,
  sourceLangLabelEn,
  translateSmsContent,
} from "../src/translate";

function envWithAi(ai: Env["AI"] | undefined): Env {
  return { AI: ai } as unknown as Env;
}

function aiBinding(run: (...args: unknown[]) => unknown): Env["AI"] {
  return { run } as unknown as Env["AI"];
}

const ENGLISH = "Your package arrived at the lobby this morning.";
const CHINESE = "您的包裹今天早上已到达大堂。";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("detectSourceLang", () => {
  const samples: Array<[string, string | null]> = [
    ["您的验证码是 123456，请勿泄露给他人。", null],
    ["您的驗證碼是 123456，請勿洩露給他人。", "zh-Hant"],
    ["https://example.com/a/b 123456", null],
    ["482913", null],
    ["OK", null],
    ["Your verification code is 482913. Do not share it.", "en"],
    ["Your package arrived at the lobby this morning.", "en"],
    ["お客様の確認コードは 482913 です。", "ja"],
    ["인증번호는 482913 입니다.", "ko"],
    ["Ваш код подтверждения 482913.", "ru"],
    ["Ваш код підтвердження 482913.", "uk"],
    ["รหัสยืนยันของคุณคือ 482913", "th"],
    ["رمز التحقق الخاص بك هو 482913", "ar"],
    ["आपका सत्यापन कोड 482913 है", "hi"],
    ["Ο κωδικός επαλήθευσής σας είναι 482913", "el"],
    ["קוד האימות שלך הוא 482913", "he"],
    ["Votre code de vérification est 482913.", "fr"],
    ["Ihr Bestätigungscode lautet 482913.", "de"],
    ["Su código de verificación es 482913.", "es"],
    ["Il tuo codice di verifica è 482913.", "it"],
    ["Seu código de verificação é 482913.", "pt"],
    ["Uw verificatiecode is 482913.", "nl"],
    ["Mã xác minh của bạn là 482913.", "vi"],
    ["Kode verifikasi Anda adalah 482913.", "id"],
  ];

  it.each(samples)("detects %j as %s", (content, expected) => {
    expect(detectSourceLang(content)).toBe(expected);
  });
});

describe("M2M_LANG_NAME", () => {
  it("maps every detector code to the m2m100 language name", () => {
    expect(M2M_LANG_NAME).toEqual({
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
    });
    expect(M2M_TARGET_LANG).toEqual({ "zh-CN": "chinese", en: "english" });
    expect(M2M_MODEL).toBe("@cf/meta/m2m100-1.2b");
    expect(FALLBACK_MODEL).toBe("@cf/google/gemma-4-26b-a4b-it");
    expect(TRANSLATE_TIMEOUT_MS).toBe(6_000);
  });
});

describe("SOURCE_LANG_LABEL", () => {
  it("names every detector code in Chinese and falls back to an unknown code", () => {
    expect(SOURCE_LANG_LABEL).toEqual({
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
    });
    expect(Object.keys(SOURCE_LANG_LABEL).sort()).toEqual(Object.keys(M2M_LANG_NAME).sort());
    expect(sourceLangLabel("ja")).toBe("日语");
    expect(sourceLangLabel("pt-BR")).toBe("pt-BR");
    expect(sourceLangLabel(null)).toBe("未知");
    expect(sourceLangLabel("")).toBe("未知");
  });

  it("names every code in English for an English system language", () => {
    expect(SOURCE_LANG_LABEL_EN).toEqual({
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
    });
    expect(Object.keys(SOURCE_LANG_LABEL_EN).sort()).toEqual(Object.keys(M2M_LANG_NAME).sort());
    expect(sourceLangLabelEn("zh-Hans")).toBe("Simplified Chinese");
    expect(sourceLangLabelEn("pt-BR")).toBe("pt-BR");
    expect(sourceLangLabelEn(null)).toBe("Unknown");
    expect(sourceLangLabelEn("")).toBe("Unknown");
  });
});

describe("translateSmsContent", () => {
  it("returns the m2m100 translation and does not call llama", async () => {
    const run = vi.fn(async (...args: unknown[]) => {
      expect(args[0]).toBe(M2M_MODEL);
      return { translated_text: CHINESE };
    });
    const result = await translateSmsContent(envWithAi(aiBinding(run)), ENGLISH);
    expect(result).toEqual({ translated: CHINESE, sourceLang: "en" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(M2M_MODEL, {
      text: ENGLISH,
      source_lang: "english",
      target_lang: "chinese",
    });
  });

  it("skips simplified Chinese without calling the model", async () => {
    const run = vi.fn(async () => ({ translated_text: "不应出现" }));
    const result = await translateSmsContent(
      envWithAi(aiBinding(run)),
      "您的验证码是 123456，请勿泄露给他人。",
    );
    expect(result).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("falls back to llama when m2m100 throws or rejects its output", async () => {
    const thrown = vi.fn(async (...args: unknown[]) => {
      if (args[0] === M2M_MODEL) throw new Error("m2m down");
      return { response: `「${CHINESE}」` };
    });
    await expect(translateSmsContent(envWithAi(aiBinding(thrown)), ENGLISH)).resolves.toEqual({
      translated: CHINESE,
      sourceLang: "en",
    });
    expect(thrown).toHaveBeenCalledWith(
      FALLBACK_MODEL,
      expect.objectContaining({
        messages: [
          { role: "system", content: expect.stringContaining("en") },
          { role: "user", content: ENGLISH },
        ],
      }),
    );

    const echoed = vi.fn(async (...args: unknown[]) => {
      if (args[0] === M2M_MODEL) return { translated_text: ENGLISH };
      return { response: CHINESE };
    });
    await expect(translateSmsContent(envWithAi(aiBinding(echoed)), ENGLISH)).resolves.toEqual({
      translated: CHINESE,
      sourceLang: "en",
    });

    const errored = vi.fn(async (...args: unknown[]) => {
      if (args[0] === M2M_MODEL) return { translated_text: "ERROR: unsupported language" };
      return { response: CHINESE };
    });
    await expect(translateSmsContent(envWithAi(aiBinding(errored)), ENGLISH)).resolves.toEqual({
      translated: CHINESE,
      sourceLang: "en",
    });
  });

  it("accepts the OpenAI chat-completion shape from the gemma fallback", async () => {
    // @cf/google/gemma-4-26b-a4b-it returns
    // { choices: [{ message: { content } }] } instead of { response }.
    const run = vi.fn(async (...args: unknown[]) => {
      if (args[0] === M2M_MODEL) throw new Error("m2m down");
      return {
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: CHINESE },
            finish_reason: "stop",
          },
        ],
      };
    });
    await expect(translateSmsContent(envWithAi(aiBinding(run)), ENGLISH)).resolves.toEqual({
      translated: CHINESE,
      sourceLang: "en",
    });
    expect(run).toHaveBeenCalledWith(FALLBACK_MODEL, expect.objectContaining({ temperature: 0 }));
  });

  it("returns null when both models fail, and the log omits the SMS body", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line) => {
      errors.push(String(line));
    });
    const run = vi.fn(async () => {
      throw new Error("model down");
    });
    await expect(translateSmsContent(envWithAi(aiBinding(run)), ENGLISH)).resolves.toBeNull();
    const logged = errors.join("");
    expect(logged).toContain("sms_translate_failed");
    expect(logged).not.toContain(ENGLISH);
    expect(logged).not.toContain("lobby");

    const echoed = vi.fn(async (...args: unknown[]) => {
      if (args[0] === M2M_MODEL) return { translated_text: "  " };
      return { response: ENGLISH };
    });
    await expect(translateSmsContent(envWithAi(aiBinding(echoed)), ENGLISH)).resolves.toBeNull();

    const huge = "译".repeat(ENGLISH.length * 3 + 1);
    const tooLong = vi.fn(async (...args: unknown[]) => {
      if (args[0] === M2M_MODEL) return { translated_text: ENGLISH };
      return { response: huge };
    });
    await expect(translateSmsContent(envWithAi(aiBinding(tooLong)), ENGLISH)).resolves.toBeNull();
  });

  it("returns null when the AI binding is missing", async () => {
    await expect(translateSmsContent(envWithAi(undefined), ENGLISH)).resolves.toBeNull();
  });

  it("falls back when m2m100 times out", async () => {
    vi.useFakeTimers();
    const run = vi.fn((...args: unknown[]) => {
      if (args[0] === M2M_MODEL) return new Promise(() => {});
      return Promise.resolve({ response: CHINESE });
    });
    const pending = translateSmsContent(envWithAi(aiBinding(run)), ENGLISH);
    await vi.advanceTimersByTimeAsync(TRANSLATE_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ translated: CHINESE, sourceLang: "en" });
  });
});

describe("translateSmsContent with an English system language", () => {
  const SIMPLIFIED = "您的包裹今天早上已到达大堂。";
  const TRADITIONAL = "您的驗證碼是 123456，請勿洩露給他人。";
  const JAPANESE = "お客様の確認コードは 482913 です。";
  const ENGLISH_RESULT = "Your package arrived at the lobby this morning.";

  it("skips English messages without calling the model", async () => {
    const run = vi.fn(async () => ({ translated_text: "不应出现" }));
    const result = await translateSmsContent(envWithAi(aiBinding(run)), ENGLISH, "en");
    expect(result).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("translates simplified Chinese into English via m2m100", async () => {
    const run = vi.fn(async (...args: unknown[]) => {
      expect(args[0]).toBe(M2M_MODEL);
      return { translated_text: ENGLISH_RESULT };
    });
    const result = await translateSmsContent(envWithAi(aiBinding(run)), SIMPLIFIED, "en");
    expect(result).toEqual({ translated: ENGLISH_RESULT, sourceLang: "zh-Hans" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(M2M_MODEL, {
      text: SIMPLIFIED,
      source_lang: "chinese",
      target_lang: "english",
    });
  });

  it("translates traditional Chinese and other languages into English", async () => {
    const run = vi.fn(async () => ({ translated_text: ENGLISH_RESULT }));
    await expect(translateSmsContent(envWithAi(aiBinding(run)), TRADITIONAL, "en")).resolves.toEqual({
      translated: ENGLISH_RESULT,
      sourceLang: "zh-Hant",
    });
    expect(run).toHaveBeenCalledWith(M2M_MODEL, {
      text: TRADITIONAL,
      source_lang: "chinese",
      target_lang: "english",
    });
    await expect(translateSmsContent(envWithAi(aiBinding(run)), JAPANESE, "en")).resolves.toEqual({
      translated: ENGLISH_RESULT,
      sourceLang: "ja",
    });
    expect(run).toHaveBeenCalledWith(M2M_MODEL, {
      text: JAPANESE,
      source_lang: "japanese",
      target_lang: "english",
    });
  });

  it("prompts llama in English when m2m100 fails for an English target", async () => {
    // Short enough to stay within the llama path's 3x length cap.
    const llamaResult = "Your package arrived this morning.";
    const run = vi.fn(async (...args: unknown[]) => {
      if (args[0] === M2M_MODEL) throw new Error("m2m down");
      return { response: llamaResult };
    });
    await expect(translateSmsContent(envWithAi(aiBinding(run)), SIMPLIFIED, "en")).resolves.toEqual({
      translated: llamaResult,
      sourceLang: "zh-Hans",
    });
    expect(run).toHaveBeenCalledWith(
      FALLBACK_MODEL,
      expect.objectContaining({
        messages: [
          { role: "system", content: expect.stringContaining("into English") },
          { role: "user", content: SIMPLIFIED },
        ],
      }),
    );
  });

  it("still skips content with too little signal", async () => {
    const run = vi.fn(async () => ({ translated_text: "不应出现" }));
    await expect(translateSmsContent(envWithAi(aiBinding(run)), "482913", "en")).resolves.toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});
