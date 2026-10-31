export interface SmsInput {
  from: string;
  to: string;
  content: string;
  deviceName: string;
  sim: string;
  receivedAt: number;
}

export interface MessageRecord {
  id: string;
  device_id: string;
  device_name: string;
  from_number: string;
  to_number: string;
  content: string;
  code: string | null;
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
  sim: string;
  reported_device: string;
  received_at: number;
  created_at: number;
}

export type PushState = "none" | "active" | "revoked";

export interface DeviceRecord {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  secret: string | null;
  last_seen_at: number | null;
  created_at: number;
  push_token_hash?: string | null;
  push_revoked_at?: number | null;
}

export interface DeviceView {
  id: string;
  name: string;
  created_at: number;
  last_seen_at: number | null;
  has_secret: boolean;
  push: PushState;
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
}

export interface NotifyChannelRow {
  id: string;
  user_id: string;
  kind: string;
  config: string;
  enabled: number;
  created_at: number;
}
