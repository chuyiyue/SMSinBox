import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Regression guard for the dead-page bug found in the 2026-11-04 tap audit:
// the asset server redirects /x.html to /x (html_handling), so route keys
// must be extensionless or a full page load never starts the view.
describe("shell routing", () => {
  it("canonicalizes .html paths and keys the view map by canonical path", () => {
    const env = { ...process.env };
    delete env.NO_COLOR;
    delete env.FORCE_COLOR;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", ROUTING_SCRIPT],
      { cwd: process.cwd(), encoding: "utf8", env },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });
});

// A page script that does not parse is a fully dead page (this is how the
// API & MCP page died: unescaped quotes in its curl examples).
describe("public scripts parse", () => {
  const dir = join(process.cwd(), "public");
  const files = readdirSync(dir).filter((name) => name.endsWith(".js"));
  it("finds the page scripts", () => {
    expect(files.length).toBeGreaterThan(5);
  });
  const tmp = mkdtempSync(join(tmpdir(), "smsinbox-parse-"));
  for (const file of files) {
    it(`${file} parses without errors`, () => {
      const target = join(tmp, file.replace(/\.js$/, ".mjs"));
      writeFileSync(target, readFileSync(join(dir, file)));
      const result = spawnSync(process.execPath, ["--check", target], { encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    });
  }
});

const ROUTING_SCRIPT = String.raw`
const memory = new Map();
globalThis.window = globalThis;
globalThis.sessionStorage = {
  getItem(key) { return memory.has(key) ? memory.get(key) : null; },
  setItem(key, value) { memory.set(key, value); },
  removeItem(key) { memory.delete(key); },
};
globalThis.localStorage = globalThis.sessionStorage;
globalThis.location = { pathname: "/", search: "", origin: "http://audit.local" };
const { canonicalPath, VIEW_SCRIPTS } = await import("./public/shell.js");
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
assert(canonicalPath("/") === "/", "root");
assert(canonicalPath("/index.html") === "/", "index.html");
assert(canonicalPath("/index") === "/", "index");
assert(canonicalPath("/devices.html") === "/devices", "devices.html");
assert(canonicalPath("/devices") === "/devices", "devices");
assert(canonicalPath("/users.html") === "/users", "users.html");
assert(canonicalPath("/api-mcp.html") === "/api-mcp", "api-mcp.html");
const keys = Object.keys(VIEW_SCRIPTS).sort();
assert(JSON.stringify(keys) === JSON.stringify(["/", "/api-mcp", "/devices", "/notify", "/users"]), "view keys: " + keys.join(","));
assert(VIEW_SCRIPTS["/devices"] === "/devices.js", "devices script");
console.log("ok");
`;
