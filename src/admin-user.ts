import type { UserRecord } from "./types";

// The single administrator, when the database still has pre-merge rows.
// ADMIN_USERNAME is a hint, not a password. A matching row wins; otherwise the
// only row wins; otherwise the only enabled admin wins. Ambiguous sets return
// null so login refuses instead of guessing.
export function pickDesignatedUser(users: UserRecord[], adminUsername: string): UserRecord | null {
  if (adminUsername) {
    const named = users.find((candidate) => candidate.username === adminUsername);
    if (named) return named;
  }
  if (users.length === 1) return users[0]!;
  const admins = users.filter((candidate) => candidate.role === "admin" && candidate.disabled_at == null);
  return admins.length === 1 ? admins[0]! : null;
}
