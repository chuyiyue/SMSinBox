import { api, isUnauthorized } from "./common.js";

export const STORAGE_KEY = "smsinbox.shell";
export const PRESENCE_WINDOW_MS = 600000;

const state = {
  me: null,
  devices: [],
  activeId: "",
  devicesKnown: false,
};

const listeners = new Set();
let generation = 0;
let fetched = false;
let pending = null;
let meGeneration = 0;
let meFetched = false;
let mePending = null;

export function presenceOf(device, now = Date.now()) {
  const seen = Number(device?.last_seen_at);
  if (!Number.isFinite(seen) || seen <= 0) return "";
  return now - seen <= PRESENCE_WINDOW_MS ? "online" : "idle";
}

export function getDevices() {
  return state.devices;
}

export function getMe() {
  return state.me;
}

// Called after the system page renames the only admin. It keeps the sidebar,
// the cached shell state, and the next page load on the new name without a
// second /auth/me round trip.
export function noteMe(user) {
  if (!user) return;
  state.me = { ...(state.me || {}), ...user };
  meFetched = true;
  persist();
  emit({ type: "me" });
}

export function getActiveId() {
  return state.activeId;
}

export function devicesKnown() {
  return state.devicesKnown;
}

export function subscribeDevices(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function hydrateShell() {
  const saved = readStorage();
  if (!saved) return;
  state.me = saved.me || null;
  state.devices = Array.isArray(saved.devices) ? saved.devices.map((device) => ({ ...device })) : [];
  state.devicesKnown = saved.devicesKnown === true;
  state.activeId = String(saved.activeId || "");
  if (isInboxPath(location.pathname)) {
    state.activeId = new URLSearchParams(location.search).get("device_id") || "";
  }
}

export function setActiveId(id) {
  const next = String(id || "");
  if (state.activeId === next) return;
  state.activeId = next;
  persist();
  emit({ type: "active" });
}

export function noteDeviceSeen(id, seenAt) {
  const device = state.devices.find((item) => item.id === id);
  if (!device) return false;
  const at = Number(seenAt);
  if (!Number.isFinite(at) || at <= 0) return false;
  if (Number(device.last_seen_at) >= at) return false;
  device.last_seen_at = at;
  persist();
  emit({ type: "presence", id });
  return true;
}

export function ensureDevices() {
  if (fetched) return Promise.resolve({ ok: true, stale: false, devices: state.devices });
  if (!pending) {
    pending = refreshDevices()
      .then((result) => {
        if (result.ok) fetched = true;
        return result;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

export async function refreshDevices() {
  const ticket = ++generation;
  let result;
  try {
    result = await api("/api/v1/devices");
  } catch (error) {
    if (isUnauthorized(error)) throw error;
    if (ticket !== generation) return staleResult();
    throw error;
  }
  if (ticket !== generation) return staleResult();
  if (!result.response.ok) {
    return {
      ok: false,
      stale: false,
      error: result.data.error || "加载设备失败",
      devices: state.devices,
    };
  }
  state.devices = mergeDevices(result.data.devices || []);
  state.devicesKnown = true;
  fetched = true;
  persist();
  emit({ type: "devices" });
  return { ok: true, stale: false, devices: state.devices };
}

export function ensureMe() {
  if (meFetched) return Promise.resolve({ ok: true, stale: false, status: 200, user: state.me });
  if (!mePending) {
    mePending = loadMe().finally(() => {
      mePending = null;
    });
  }
  return mePending;
}

export function clearShellCache() {
  generation += 1;
  meGeneration += 1;
  fetched = false;
  meFetched = false;
  pending = null;
  mePending = null;
  state.devices = [];
  state.me = null;
  state.activeId = "";
  state.devicesKnown = false;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be blocked in private mode.
  }
  emit({ type: "cleared" });
}

async function loadMe() {
  const ticket = ++meGeneration;
  let result;
  try {
    result = await api("/api/v1/auth/me");
  } catch (error) {
    if (isUnauthorized(error)) throw error;
    if (ticket !== meGeneration) return { ok: false, stale: true, status: 0, user: state.me };
    throw error;
  }
  if (ticket !== meGeneration) return { ok: false, stale: true, status: result.response.status, user: state.me };
  if (!result.response.ok) {
    return {
      ok: false,
      stale: false,
      status: result.response.status,
      error: result.data.error || "",
      user: state.me,
    };
  }
  state.me = result.data.user || null;
  meFetched = true;
  persist();
  return { ok: true, stale: false, status: 200, user: state.me };
}

function mergeDevices(incoming) {
  const previous = new Map(state.devices.map((device) => [device.id, device]));
  return incoming.map((device) => {
    const older = previous.get(device.id);
    const seen = Math.max(Number(older?.last_seen_at) || 0, Number(device?.last_seen_at) || 0);
    if (!seen) return { ...device };
    return { ...device, last_seen_at: seen };
  });
}

function staleResult() {
  return { ok: false, stale: true, devices: state.devices };
}

function emit(event) {
  for (const listener of listeners) listener(event);
}

function persist() {
  const payload = {
    me: state.me ? { id: state.me.id, username: state.me.username, role: state.me.role } : null,
    devices: state.devices,
    activeId: state.activeId,
    devicesKnown: state.devicesKnown,
  };
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // The in-memory list still survives this document.
  }
}

function readStorage() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

function isInboxPath(pathname) {
  return pathname === "/" || pathname === "/index.html";
}
