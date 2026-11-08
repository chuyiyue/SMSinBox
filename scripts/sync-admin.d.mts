export function equalBytes(left: Uint8Array, right: Uint8Array): boolean;

export function hashPassword(password: string): Promise<string>;

export function verifyPassword(password: string, stored: string): Promise<boolean>;
