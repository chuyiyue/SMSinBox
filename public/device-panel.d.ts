export function canRevealPushSecret(): boolean;

export function pushLabel(push: string | null | undefined): string;

export function pushLinkHint(push: string | null | undefined): string;

export interface PushAction {
  action: "issue" | "rotate" | "revoke";
  label: string;
}

export function pushActions(push: string | null | undefined): PushAction[];

export function pushConfirm(action: string, name?: string | null): string | null;

export interface PlatformView {
  key: "unknown" | "ios" | "android" | "reported";
  label: string;
}

export function platformFromReport(value: unknown): PlatformView;

export function platformBadge(platform: PlatformView | null | undefined): string;

export function platformDetail(platform: PlatformView | null | undefined): string;

export interface ReceiveTime {
  kind: "message" | "seen-without-message" | "none";
  at: number | null;
}

export function receiveTime(
  device: { last_seen_at?: number | null } | null | undefined,
  latest: { received_at?: number | null } | null | undefined,
): ReceiveTime;

export interface CredentialBoxes {
  showBearer: boolean;
  showPush: boolean;
  showBox: boolean;
}

export function credentialBoxes(input: { token?: string | null; pushUrl?: string | null } | null | undefined): CredentialBoxes;

export interface PanelMessage {
  device_id?: string | null;
  reported_device?: string | null;
  received_at?: number | null;
}

export function latestByDevice(messages: readonly PanelMessage[] | null | undefined): Map<string, PanelMessage>;

export interface DeviceCardModel {
  name: string;
  id: string;
  platform: PlatformView;
  platformBadge: string;
  platformDetail: string;
  push: "none" | "active" | "revoked";
  pushLabel: string;
  pushHint: string;
  hmac: string;
  received: ReceiveTime;
  shortcut: string;
  actions: PushAction[];
}

export function describeDevice(
  device:
    | {
        id?: string | null;
        name?: string | null;
        push?: string | null;
        has_secret?: boolean | null;
        last_seen_at?: number | null;
      }
    | null
    | undefined,
  latest: PanelMessage | null | undefined,
): DeviceCardModel;

export function shortcutStatusLines(): string[];
