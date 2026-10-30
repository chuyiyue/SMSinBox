import { listNotifyChannels } from "./db";
import { logError, logInfo } from "./log";
import { openSmtpSocket, sendSmtp, type LineSocket } from "./smtp";
import type { NotifyChannelRow } from "./types";

export const MAX_NOTIFY_CHANNELS = 10;
export const NOTIFY_KINDS = ["telegram", "wecom", "bark", "email"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

export interface TelegramConfig {
  bot_token: string;
  chat_id: string;
}

export interface WecomConfig {
  webhook_url: string;
}

export interface BarkConfig {
  device_key: string;
  server: string;
}

export interface EmailConfig {
  to: string;
  from: string;
  webhook_url?: string;
  smtp_host?: string;
  smtp_port?: number;
  smtp_username?: string;
  smtp_password?: string;
}

export type ChannelConfig = TelegramConfig | WecomConfig | BarkConfig | EmailConfig;

export interface StoredChannel {
  id: string;
  userId: string;
  kind: NotifyKind;
  config: ChannelConfig;
  enabled: boolean;
  createdAt: number;
}

export interface NotifyText {
  title: string;
  text: string;
}

export interface NotifyResult {
  id: string;
  kind: NotifyKind;
  ok: boolean;
  error?: string;
}

export interface NotifyDeps {
  fetch: typeof fetch;
  openSmtp: (host: string, port: number) => Promise<LineSocket>;
}

const DEFAULT_BARK_SERVER = "https://api.day.app";
const TELEGRAM_TOKEN = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
const CHAT_ID = /^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/;
const BARK_KEY = /^[A-Za-z0-9]{8,64}$/;
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export function renderNotification(input: {
  from: string;
  content: string;
  code: string | null;
  deviceName: string;
  receivedAt: number;
}): NotifyText {
  const who = input.from.trim() || "未知号码";
  const title = truncate(input.code ? `验证码 ${input.code}` : `新短信 ${who}`, 80);
  const text = truncate(`${input.deviceName || "设备"} · ${who}\n${new Date(input.receivedAt).toISOString()}\n${input.content}`, 500);
  return { title, text };
}

export function parseChannelInput(
  value: unknown,
): { ok: true; kind: NotifyKind; config: ChannelConfig } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "请求体无效" };
  const record = value as Record<string, unknown>;
  if (record.kind === "telegram") return parseTelegram(record);
  if (record.kind === "wecom") return parseWecom(record);
  if (record.kind === "bark") return parseBark(record);
  if (record.kind === "email") return parseEmail(record);
  return { ok: false, error: "不支持的推送渠道" };
}

export function channelFromRow(row: NotifyChannelRow): StoredChannel | null {
  if (!isKind(row.kind)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.config);
  } catch {
    return null;
  }
  const checked = parseChannelInput({ kind: row.kind, ...(asRecord(parsed) ?? {}) });
  if (!checked.ok) return null;
  return {
    id: row.id,
    userId: row.user_id,
    kind: checked.kind,
    config: checked.config,
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
  };
}

export function redactConfig(kind: NotifyKind, config: ChannelConfig): Record<string, string | number> {
  if (kind === "telegram") {
    const telegram = config as TelegramConfig;
    return { bot_token: mask(telegram.bot_token), chat_id: telegram.chat_id };
  }
  if (kind === "wecom") {
    const wecom = config as WecomConfig;
    return { webhook_url: redactUrl(wecom.webhook_url) };
  }
  if (kind === "bark") {
    const bark = config as BarkConfig;
    return { server: bark.server, device_key: mask(bark.device_key) };
  }
  const email = config as EmailConfig;
  const redacted: Record<string, string | number> = { to: email.to, from: email.from };
  if (email.webhook_url) redacted.webhook_url = redactUrl(email.webhook_url);
  if (email.smtp_host) redacted.smtp_host = email.smtp_host;
  if (email.smtp_port) redacted.smtp_port = email.smtp_port;
  if (email.smtp_username) redacted.smtp_username = email.smtp_username;
  if (email.smtp_password) redacted.smtp_password = mask(email.smtp_password);
  return redacted;
}

export async function deliverChannels(
  channels: StoredChannel[],
  payload: NotifyText,
  deps: NotifyDeps,
): Promise<NotifyResult[]> {
  const results: NotifyResult[] = [];
  for (const channel of channels) {
    if (!channel.enabled) continue;
    try {
      await deliverOne(channel, payload, deps);
      results.push({ id: channel.id, kind: channel.kind, ok: true });
      logInfo({ message: "notify_result", channel_id: channel.id, kind: channel.kind, ok: true });
    } catch (error) {
      const safe = scrub(error instanceof Error ? error.message : "发送失败");
      results.push({ id: channel.id, kind: channel.kind, ok: false, error: safe || "发送失败" });
      logError({
        message: "notify_result",
        channel_id: channel.id,
        kind: channel.kind,
        ok: false,
        error: safe || "发送失败",
      });
    }
  }
  return results;
}

export async function notifyStoredSms(
  env: Env,
  userId: string,
  input: {
    from: string;
    content: string;
    code: string | null;
    deviceName: string;
    receivedAt: number;
  },
  deps: NotifyDeps = defaultDeps(),
): Promise<NotifyResult[]> {
  const rows = await listNotifyChannels(env.DB, userId);
  const channels: StoredChannel[] = [];
  for (const row of rows) {
    const channel = channelFromRow(row);
    if (channel) channels.push(channel);
  }
  return deliverChannels(channels, renderNotification(input), deps);
}

export function scheduleNotify(
  ctx: { waitUntil(promise: Promise<unknown>): void },
  task: () => Promise<unknown>,
): void {
  const job = Promise.resolve()
    .then(task)
    .catch((error: unknown) => {
      logError({
        message: "notify_failed",
        error: scrub(error instanceof Error ? error.message : "unknown"),
      });
    });
  try {
    ctx.waitUntil(job);
  } catch (error) {
    logError({
      message: "notify_schedule_failed",
      error: scrub(error instanceof Error ? error.message : "unknown"),
    });
  }
}

export function scrub(message: string): string {
  return message
    .replace(/bot\d{6,}:[A-Za-z0-9_-]+/gi, "bot***")
    .replace(/key=[^&\s]+/gi, "key=***")
    .replace(/[\r\n]/g, " ")
    .slice(0, 180);
}

function defaultDeps(): NotifyDeps {
  return { fetch, openSmtp: openSmtpSocket };
}

async function deliverOne(channel: StoredChannel, payload: NotifyText, deps: NotifyDeps): Promise<void> {
  if (channel.kind === "telegram") {
    const config = channel.config as TelegramConfig;
    const url = `https://api.telegram.org/bot${encodeURIComponent(config.bot_token)}/sendMessage`;
    await postJson(deps, url, "Telegram", {
      chat_id: config.chat_id,
      text: `${payload.title}\n\n${payload.text}`,
      disable_web_page_preview: true,
    });
    return;
  }
  if (channel.kind === "wecom") {
    const config = channel.config as WecomConfig;
    await postJson(deps, config.webhook_url, "企业微信", {
      msgtype: "text",
      text: { content: `${payload.title}\n\n${payload.text}` },
    }, (body) => {
      const record = asRecord(body);
      if (record && typeof record.errcode === "number" && record.errcode !== 0) {
        throw new Error("企业微信拒绝了这条通知");
      }
    });
    return;
  }
  if (channel.kind === "bark") {
    const config = channel.config as BarkConfig;
    const server = config.server.replace(/\/+$/, "");
    await postJson(deps, `${server}/push`, "Bark", {
      device_key: config.device_key,
      title: payload.title,
      body: payload.text,
      group: "SMSinBox",
    });
    return;
  }
  const email = channel.config as EmailConfig;
  if (email.webhook_url) {
    await postJson(deps, email.webhook_url, "邮件", {
      to: email.to,
      from: email.from,
      subject: payload.title,
      text: payload.text,
    });
    return;
  }
  const socket = await deps.openSmtp(email.smtp_host ?? "", email.smtp_port ?? 465);
  try {
    await sendSmtp(socket, {
      username: email.smtp_username ?? "",
      password: email.smtp_password ?? "",
      from: email.from,
      to: email.to,
      subject: payload.title,
      text: payload.text,
    });
  } catch (error) {
    await socket.close().catch(() => undefined);
    throw error;
  }
}

async function postJson(
  deps: NotifyDeps,
  url: string,
  label: string,
  body: unknown,
  check?: (parsed: unknown) => void,
): Promise<void> {
  const response = await deps.fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`${label} 返回 ${response.status}`);
  }
  const parsed = await readJsonLimited(response);
  if (!response.ok) throw new Error(`${label} 返回 ${response.status}`);
  const record = asRecord(parsed);
  if (record && record.ok === false) throw new Error(`${label}拒绝了这条通知`);
  check?.(parsed);
}

async function readJsonLimited(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text.slice(0, 4_000));
  } catch {
    return null;
  }
}

function parseTelegram(record: Record<string, unknown>): { ok: true; kind: "telegram"; config: TelegramConfig } | { ok: false; error: string } {
  const botToken = stringField(record, "bot_token");
  const chatId = stringField(record, "chat_id");
  if (!botToken || !TELEGRAM_TOKEN.test(botToken)) return { ok: false, error: "Telegram bot token 无效" };
  if (!chatId || !CHAT_ID.test(chatId)) return { ok: false, error: "Telegram chat id 无效" };
  return { ok: true, kind: "telegram", config: { bot_token: botToken, chat_id: chatId } };
}

function parseWecom(record: Record<string, unknown>): { ok: true; kind: "wecom"; config: WecomConfig } | { ok: false; error: string } {
  const webhook = stringField(record, "webhook_url");
  const url = webhook ? publicHttpsUrl(webhook) : null;
  if (!url || url.hostname !== "qyapi.weixin.qq.com" || url.pathname !== "/cgi-bin/webhook/send") {
    return { ok: false, error: "企业微信 Webhook 必须是 qyapi.weixin.qq.com 的 https 地址" };
  }
  const key = url.searchParams.get("key") ?? "";
  if (key.length < 8 || key.length > 128 || !/^[A-Za-z0-9_-]+$/.test(key)) {
    return { ok: false, error: "企业微信 Webhook 缺少 key" };
  }
  return { ok: true, kind: "wecom", config: { webhook_url: url.toString() } };
}

function parseBark(record: Record<string, unknown>): { ok: true; kind: "bark"; config: BarkConfig } | { ok: false; error: string } {
  const deviceKey = stringField(record, "device_key");
  if (!deviceKey || !BARK_KEY.test(deviceKey)) return { ok: false, error: "Bark device key 无效" };
  const serverRaw = stringField(record, "server") || DEFAULT_BARK_SERVER;
  const server = publicHttpsUrl(serverRaw);
  if (!server || server.pathname !== "/" || server.search || server.hash) {
    return { ok: false, error: "Bark 服务器必须是公网 https 地址" };
  }
  return { ok: true, kind: "bark", config: { device_key: deviceKey, server: server.origin } };
}

function parseEmail(record: Record<string, unknown>): { ok: true; kind: "email"; config: EmailConfig } | { ok: false; error: string } {
  const to = stringField(record, "to");
  const from = stringField(record, "from");
  if (!to || !EMAIL.test(to)) return { ok: false, error: "收件邮箱无效" };
  if (!from || !EMAIL.test(from)) return { ok: false, error: "发件邮箱无效" };
  const webhookRaw = stringField(record, "webhook_url");
  const smtpHost = stringField(record, "smtp_host");
  if (webhookRaw && smtpHost) return { ok: false, error: "邮件请只选择 Webhook 或 SMTP 一种" };
  if (webhookRaw) {
    const webhook = publicHttpsUrl(webhookRaw);
    if (!webhook) return { ok: false, error: "邮件 Webhook 必须是公网 https 地址" };
    return { ok: true, kind: "email", config: { to, from, webhook_url: webhook.toString() } };
  }
  if (!smtpHost || !HOSTNAME.test(smtpHost) || isBlockedHost(smtpHost)) {
    return { ok: false, error: "SMTP 主机无效" };
  }
  const portValue = record.smtp_port === undefined || record.smtp_port === "" ? 465 : Number(record.smtp_port);
  if (portValue !== 465) return { ok: false, error: "SMTP 只支持 465 端口（隐式 TLS）" };
  const username = stringField(record, "smtp_username");
  const password = stringField(record, "smtp_password");
  if (!username || username.length > 128) return { ok: false, error: "SMTP 用户名无效" };
  if (!password || password.length > 256) return { ok: false, error: "SMTP 密码无效" };
  return {
    ok: true,
    kind: "email",
    config: { to, from, smtp_host: smtpHost, smtp_port: 465, smtp_username: username, smtp_password: password },
  };
}

function publicHttpsUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (isBlockedHost(url.hostname)) return null;
  return url;
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "metadata.google.internal" || host === "metadata.google.com") return true;
  if (/^\d+$/.test(host)) return true;
  if (host.includes(":")) return !isPublicIpv6(host);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return !isPublicIpv4(host);
  return false;
}

function isPublicIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 192 && b === 0 && parts[2] === 2) return false;
  if (a === 198 && b === 51 && parts[2] === 100) return false;
  if (a === 203 && b === 0 && parts[2] === 113) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(mapped) && isPublicIpv4(mapped);
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
  if (/^fe[89ab]/.test(normalized)) return false;
  if (normalized.startsWith("ff")) return false;
  return true;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") return "";
  return value.trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isKind(value: string): value is NotifyKind {
  return (NOTIFY_KINDS as readonly string[]).includes(value);
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.searchParams.has("key")) url.searchParams.set("key", "****");
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    return url.toString();
  } catch {
    return mask(value);
  }
}

function mask(value: string): string {
  if (value.length <= 4) return "****";
  return `****${value.slice(-4)}`;
}

function truncate(value: string, maxChars: number): string {
  const chars = [...value];
  if (chars.length <= maxChars) return value;
  return `${chars.slice(0, maxChars).join("")}…`;
}
