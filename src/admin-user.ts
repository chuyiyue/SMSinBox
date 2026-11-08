import type { UserRecord } from "./types";

// The administrator is the single users row. More than one row is ambiguous:
// login and the deploy sync refuse to guess instead of picking a name or an
// enabled admin out of a leftover set.
export function pickDesignatedUser(users: UserRecord[]): UserRecord | null {
  if (users.length !== 1) return null;
  return users[0]!;
}
