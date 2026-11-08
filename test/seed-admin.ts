import { hashPassword } from "../src/auth";

// Integration tests sign in against a real local D1. Login no longer
// bootstraps an admin from ADMIN_USERNAME / ADMIN_PASSWORD, so suites that
// expect a session insert the row themselves. The hash comes from the same
// PBKDF2 helper the Worker uses.
export async function seedAdmin(
  db: D1Database,
  input: {
    username: string;
    password: string;
    id?: string;
    role?: string;
    disabledAt?: number | null;
    createdAt?: number;
    passwordHash?: string;
  },
): Promise<{ id: string; passwordHash: string }> {
  const id = input.id ?? crypto.randomUUID();
  const passwordHash = input.passwordHash ?? (await hashPassword(input.password));
  await db
    .prepare(
      `INSERT INTO users (id, username, password_hash, role, disabled_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.username,
      passwordHash,
      input.role ?? "admin",
      input.disabledAt ?? null,
      input.createdAt ?? Date.now(),
    )
    .run();
  return { id, passwordHash };
}
