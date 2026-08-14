const ULID_ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Time-sortable, 128-bit unique ID (ULID). Used for row primary keys, never
 * for anything secret -- guessability of a *row id* is irrelevant because
 * every read goes through authorize() regardless of whether the id was
 * guessed or looked up.
 */
export function generateId(): string {
  const time = Date.now();
  let timePart = "";
  let t = time;
  for (let i = 9; i >= 0; i--) {
    timePart = ULID_ENCODING.charAt(t % 32) + timePart;
    t = Math.floor(t / 32);
  }

  const randomBytes = new Uint8Array(10);
  crypto.getRandomValues(randomBytes);
  let randomPart = "";
  let carry = 0;
  let bits = 0;
  for (const byte of randomBytes) {
    carry = (carry << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      randomPart += ULID_ENCODING.charAt((carry >> bits) & 0x1f);
    }
  }
  randomPart = randomPart.padEnd(16, "0").slice(0, 16);

  return timePart + randomPart;
}

/** Cryptographically random, unguessable token for request correlation. */
export function generateRequestId(): string {
  return crypto.randomUUID();
}

/** Cryptographically random secret for RPC agent keys. Never derived from Math.random(). */
export function generateSecret(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
