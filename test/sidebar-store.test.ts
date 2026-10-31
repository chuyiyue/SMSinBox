import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("device store", () => {
  it("keeps the latest list, ignores stale responses, and updates presence without another fetch", () => {
    const env = { ...process.env };
    delete env.NO_COLOR;
    delete env.FORCE_COLOR;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", STORE_SCRIPT],
      { cwd: process.cwd(), encoding: "utf8", env },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });
});

const STORE_SCRIPT = String.raw`
const memory = new Map();
globalThis.sessionStorage = {
  getItem(key) { return memory.has(key) ? memory.get(key) : null; },
  setItem(key, value) { memory.set(key, value); },
  removeItem(key) { memory.delete(key); },
};
globalThis.location = {
  pathname: "/devices.html",
  search: "",
  origin: "https://sms.example",
  href: "https://sms.example/devices.html",
  assign() {},
};

const resolvers = [];
let calls = 0;
globalThis.fetch = (url) => {
  const path = String(url);
  calls += 1;
  if (path.includes("/api/v1/devices")) {
    return new Promise((resolve) => resolvers.push(resolve));
  }
  return Promise.resolve(json({ ok: true, user: null }));
};

const store = await import("./public/device-store.js");
const { STORAGE_KEY, presenceOf, refreshDevices, ensureDevices, noteDeviceSeen, noteMe, getDevices, getMe, hydrateShell, clearShellCache, getActiveId } = store;

if (presenceOf({ last_seen_at: Date.now() }) !== "online") throw new Error("online");
if (presenceOf({ last_seen_at: Date.now() - 600001 }) !== "idle") throw new Error("idle");
if (presenceOf({ last_seen_at: null }) !== "") throw new Error("empty presence");

const first = refreshDevices();
const second = refreshDevices();
resolvers[1](json({ ok: true, devices: [{ id: "b", name: "B", last_seen_at: 2 }] }));
resolvers[0](json({ ok: true, devices: [{ id: "a", name: "A", last_seen_at: 1 }] }));
await first;
await second;
if (getDevices().map((device) => device.id).join() !== "b") throw new Error("stale list won");

const before = calls;
if (noteDeviceSeen("missing", Date.now()) !== false) throw new Error("unknown device");
if (noteDeviceSeen("b", 50) !== true) throw new Error("presence update");
if (noteDeviceSeen("b", 40) !== false) throw new Error("older presence");
if (calls !== before) throw new Error("presence fetched");

const third = refreshDevices();
resolvers.at(-1)(json({ ok: true, devices: [{ id: "b", name: "B", last_seen_at: 10 }] }));
await third;
if (getDevices()[0].last_seen_at !== 50) throw new Error("refresh dropped newer presence");

clearShellCache();
calls = 0;
resolvers.length = 0;
globalThis.fetch = () => {
  calls += 1;
  return Promise.resolve(json({ ok: true, devices: [{ id: "c", name: "C", last_seen_at: null }] }));
};
await ensureDevices();
await ensureDevices();
if (calls !== 1) throw new Error("ensure fetched " + calls);
await refreshDevices();
if (calls !== 2) throw new Error("refresh did not fetch");

globalThis.fetch = () => Promise.resolve(json({ ok: false, error: "nope" }, 500));
const failed = await refreshDevices();
if (failed.ok || failed.stale) throw new Error("failure shape");
if (getDevices()[0].id !== "c") throw new Error("failure cleared devices");

clearShellCache();
sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
  devicesKnown: true,
  devices: [{ id: "d", name: "D", last_seen_at: 1 }],
  activeId: "d",
  me: { id: "u", username: "ada", role: "admin" },
}));
hydrateShell();
if (getDevices()[0]?.name !== "D" || getActiveId() !== "d") throw new Error("hydrate");
noteMe({ username: "owner", role: "admin" });
if (getMe()?.username !== "owner") throw new Error("noteMe memory");
if (JSON.parse(sessionStorage.getItem(STORAGE_KEY)).me?.username !== "owner") throw new Error("noteMe cache");
console.log("ok");

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
`;
