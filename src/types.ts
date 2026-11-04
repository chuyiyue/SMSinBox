export interface SmsInput {
  from: string;
  to: string;
  content: string;
  deviceName: string;
  sim: string;
  receivedAt: number;
  // "device" when the client supplied a usable timestamp, "server" when we had
  // to fall back to the ingest time. Never pretend the fallback is device time.
  receivedAtSource: "device" | "server";
}

// How messages.code was produced. NULL when the message has no code.
export type CodeSource = "regex" | "workers-ai";

export interface MessageRecord {
  id: string;
  device_id: string;
  device_name: string;
  from_number: string;
  to_number: string;
  content: string;
  code: string | null;
  code_source: CodeSource | null;
  raw_payload: string;
  received_at: number;
  created_at: number;
  encrypted: number;
}

export interface MessageView {
  id: string;
  device_id: string;
  device_name: string;
  from_number: string;
  to_number: string;
  content: string;
  code: string | null;
  code_source: CodeSource | null;
  sim: string;
  reported_device: string;
  received_at: number;
  received_at_source: "device" | "server" | "unknown";
  created_at: number;
}

export type PushState = "none" | "active" | "revoked";

export interface DeviceRecord {
  id: string;
  user_id: string;
  name: string;
  platform: string | null;
  token_hash: string;
  token_version: number;
  last_seen_at: number | null;
  created_at: number;
  push_token_hash?: string | null;
  push_revoked_at?: number | null;
}

export interface DeviceView {
  id: string;
  name: string;
  platform: string | null;
  created_at: number;
  last_seen_at: number | null;
  // Sidebar pin time (null = not pinned; at most 5 pinned per owner) and
  // the owner-defined group the device is filed under (null = ungrouped).
  pinned_at: number | null;
  group_id: string | null;
  push: PushState;
  // Plaintext push URL for the owner's session list (path form until the
  // handler absolutizes it); null when no secret is stored (legacy rows,
  // revoked links) or it cannot be decrypted.
  push_url: string | null;
}

export interface DeviceGroupView {
  id: string;
  name: string;
  created_at: number;
  sort_order: number;
  device_count: number;
}

export interface UserRecord {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  disabled_at: number | null;
  created_at: number;
}

export interface UserAccount {
  id: string;
  username: string;
  role: string;
  disabled_at: number | null;
  created_at: number;
}

export interface SessionUser {
  id: string;
  username: string;
  role: string;
  disabled_at: number | null;
  expires_at: number;
  totp_enabled_at?: number | null;
}

export interface TotpUserRecord {
  id: string;
  username: string;
  role: string;
  disabled_at: number | null;
  password_hash: string;
  totp_secret: string | null;
  totp_pending_secret: string | null;
  totp_pending_created_at: number | null;
  totp_enabled_at: number | null;
  totp_last_counter: number | null;
}

export interface TotpTicketRecord {
  id: string;
  user_id: string;
  expires_at: number;
  attempts: number;
  created_at: number;
  username: string;
  role: string;
  disabled_at: number | null;
  totp_secret: string | null;
  totp_enabled_at: number | null;
  totp_last_counter: number | null;
}

export interface ListedSession {
  id: string;
  created_at: number;
  expires_at: number;
  user_agent: string | null;
  ip: string | null;
}

export interface NotifyChannelRow {
  id: string;
  user_id: string;
  kind: string;
  config: string;
  enabled: number;
  created_at: number;
}

export interface ApiTokenRecord {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  token_enc?: string | null;
  permissions: string; // JSON array string
  device_scope: string; // JSON array string; empty array [] means all devices
  expires_at: number | null;
  disabled_at: number | null;
  revoked_at: number | null;
  created_at: number;
  last_used_at: number | null;
}

export interface ApiTokenView {
  id: string;
  name: string;
  token_prefix: string;
  // Full plaintext for the owner's token list only (0013); null for
  // legacy tokens and in any non-owner view.
  token: string | null;
  permissions: string[];
  device_scope: string[]; // empty = all devices
  expires_at: number | null;
  disabled_at: number | null;
  revoked_at: number | null;
  created_at: number;
  last_used_at: number | null;
  status: "active" | "disabled" | "revoked" | "expired";
}
