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

export interface DeviceRecord {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  secret: string | null;
  last_seen_at: number | null;
  created_at: number;
}

export interface DeviceView {
  id: string;
  name: string;
  created_at: number;
  last_seen_at: number | null;
  has_secret: boolean;
}

export interface UserRecord {
  id: string;
  username: string;
  password_hash: string;
  created_at: number;
}

export interface SessionUser {
  id: string;
  username: string;
  expires_at: number;
}
