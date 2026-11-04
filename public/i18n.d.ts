export const LOCALE_STORAGE_KEY: string;
export const LOCALES: readonly ["zh-CN", "en"];

export const MESSAGES: {
  "zh-CN": Record<string, string>;
  en: Record<string, string>;
};

export function normalizeLocale(value: unknown): "zh-CN" | "en" | null;
export function currentLocale(): "zh-CN" | "en";
export function setLocale(next: unknown): boolean;
export function adoptLocale(value: unknown): boolean;
export function t(key: string, params?: Record<string, unknown>): string;
export function applyI18n(root?: object | null): void;
export function formatRelative(ms: number, now?: number): string;
export function formatMinuteStamp(ms: number): string;
export function formatAbsoluteStamp(ms: number): string;
