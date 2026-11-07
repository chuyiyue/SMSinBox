export function canRevealPushSecret(): boolean;

export interface PushAction {
  action: "issue" | "rotate" | "revoke";
  label: string;
}

export function pushActions(push: string | null | undefined): PushAction[];

export function pushConfirm(action: string, name?: string | null): string | null;

export interface PlatformView {
  key: "unknown" | "ios" | "android" | "macos" | "windows" | "linux" | "openwrt" | "other" | "reported";
  label: string;
  icon: string;
}

export interface DeviceType {
  value: string;
  label: string;
  icon: string;
}

export const DEVICE_TYPES: DeviceType[];

export function deviceTypeOf(value: unknown): DeviceType | null;

export function sidebarDeviceIcon(device: { platform?: string | null } | null | undefined): string;

export function platformFromPreselect(value: unknown): PlatformView | null;

export function platformBadge(platform: PlatformView | null | undefined): string;

export function platformDetail(platform: PlatformView | null | undefined): string;

export interface ReceiveTime {
  kind: "message" | "seen-without-message" | "none";
  at: number | null;
}

export const SIDEBAR_DEVICE_LIMIT: number;

export interface SidebarSelection<T> {
  shown: T[];
}

export function selectSidebarDevices<T extends { id?: unknown; pinned_at?: number | null }>(
  devices: readonly T[] | null | undefined,
  limit?: number,
): SidebarSelection<T>;

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
  received_at?: number | null;
}

export function latestByDevice(messages: readonly PanelMessage[] | null | undefined): Map<string, PanelMessage>;

export interface DeviceCardModel {
  name: string;
  id: string;
  platform: PlatformView;
  platformBadge: string;
  platformDetail: string;
  received: ReceiveTime;
  actions: PushAction[];
  pushUrl: string;
}

export function describeDevice(
  device:
    | {
        id?: string | null;
        name?: string | null;
        platform?: string | null;
        push?: string | null;
        push_url?: string | null;
        last_seen_at?: number | null;
      }
    | null
    | undefined,
  latest: PanelMessage | null | undefined,
): DeviceCardModel;

