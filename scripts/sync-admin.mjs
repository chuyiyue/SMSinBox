#!/usr/bin/env node
// Deploy-time sync of the repository admin secret into the single users row.
// Password hashing must stay identical to src/auth.ts:
//   pbkdf2-sha256$10000$<16-byte salt base64url>$<32-byte PBKDF2-SHA256 base64url>
// Runtime login does not read ADMIN_USERNAME / ADMIN_PASSWORD. This script does.
// It never prints the password or the hash, and it never touches profile_username.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HASH_PREFIX = "pbkdf2-sha256";
const PBKDF2_ITERATIONS = 10_000;

export function equalBytes(left, right) {
  const subtle = crypto.subtle;
  if (typeof subtle.timingSafeEqual === "function" && left.byteLength === right.byteLength) {
    return subtle.timingSafeEqual(left, right);
  }
  const length = Math.max(left.byteLength, right.byteLength);
  let diff = left.byteLength === right.byteLength ? 0 : 1;
  for (let index = 0; index < length; index += 1) {
    const leftByte = index < left.byteLength ? left[index] : 0;
    const rightByte = index < right.byteLength ? right[index] : 0;
    diff |= leftByte ^ rightByte;
  }
  return diff === 0;
}

function copyBytes(bytes) {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function parseStoredHash(stored) {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== HASH_PREFIX) return null;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1_000_000) return null;
  const salt = base64UrlToBytes(parts[2] ?? "");
  const hash = base64UrlToBytes(parts[3] ?? "");
  if (!salt || !hash || salt.byteLength < 8 || hash.byteLength !== 32) return null;
  return { iterations, salt, hash };
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: copyBytes(salt), iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `${HASH_PREFIX}$${PBKDF2_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}

export async function verifyPassword(password, stored) {
  const parsed = parseStoredHash(stored);
  const iterations = parsed?.iterations ?? PBKDF2_ITERATIONS;
  const salt = parsed?.salt ?? new Uint8Array(16);
  const expected = parsed?.hash ?? new Uint8Array(32);
  const actual = await pbkdf2(password, salt, iterations);
  return parsed !== null && equalBytes(actual, expected);
}

function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function parseWranglerJson(stdout) {
  const text = stdout.trim();
  const start = text.search(/[\[{]/);
  if (start < 0) throw new Error("sync-admin: could not read the database response");
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    throw new Error("sync-admin: could not read the database response");
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const first = list[0];
  if (!first || typeof first !== "object" || first.success === false) {
    throw new Error("sync-admin: database command failed");
  }
  return Array.isArray(first.results) ? first.results : [];
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

async function d1Execute(sql) {
  const dir = await mkdtemp(join(tmpdir(), "smsinbox-sync-admin-"));
  const file = join(dir, "stmt.sql");
  try {
    await writeFile(file, sql.endsWith("\n") ? sql : `${sql}\n`, "utf8");
    let result;
    try {
      result = await run("npx", ["wrangler", "d1", "execute", "smsinbox", "--remote", "--json", "--file", file]);
    } catch {
      throw new Error("sync-admin: database command failed");
    }
    if (result.code !== 0) throw new Error("sync-admin: database command failed");
    return parseWranglerJson(result.stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function report(status, sessionsCleared) {
  console.log(status);
  if (sessionsCleared) console.log("sessions cleared");
}

async function main() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    throw new Error("sync-admin: ADMIN_USERNAME and ADMIN_PASSWORD are required");
  }

  const rows = await d1Execute(
    "SELECT id, username, password_hash, role, disabled_at, created_at FROM users ORDER BY created_at ASC;",
  );
  if (rows.length > 1) throw new Error("sync-admin: multiple user rows, refusing to guess");

  if (rows.length === 0) {
    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    const createdAt = Date.now();
    await d1Execute(
      `INSERT INTO users (id, username, password_hash, role, created_at) VALUES (${sqlQuote(id)}, ${sqlQuote(username)}, ${sqlQuote(passwordHash)}, 'admin', ${createdAt});`,
    );
    report("created", false);
    return;
  }

  const row = rows[0];
  const rowName = typeof row.username === "string" ? row.username : "";
  const stored = typeof row.password_hash === "string" ? row.password_hash : "";
  const sameName = rowName.toLowerCase() === username.toLowerCase();
  const samePassword = stored.length > 0 && (await verifyPassword(password, stored));
  if (sameName && samePassword) {
    report("unchanged", false);
    return;
  }

  const id = typeof row.id === "string" ? row.id : "";
  if (!id) throw new Error("sync-admin: database command failed");
  const statements = [];
  if (!sameName) {
    statements.push(`UPDATE users SET username = ${sqlQuote(username)} WHERE id = ${sqlQuote(id)};`);
  }
  if (!samePassword) {
    const passwordHash = await hashPassword(password);
    statements.push(`UPDATE users SET password_hash = ${sqlQuote(passwordHash)} WHERE id = ${sqlQuote(id)};`);
    statements.push("DELETE FROM sessions;");
  }
  await d1Execute(statements.join("\n"));
  report("updated", !samePassword);
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "";
    console.error(message.startsWith("sync-admin:") ? message : "sync-admin: failed");
    process.exit(1);
  });
}
