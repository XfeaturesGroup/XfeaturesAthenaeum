async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Content hash for documents: dedup, change detection, idempotent ingestion. */
export async function hashContent(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Peppered hash for RPC agent keys. The pepper is a Worker secret (never in
 * D1), so a stolen `agents.rpc_key_hash` column alone cannot be brute-forced
 * offline without also compromising the Worker's secret store.
 */
export async function hashRpcKey(rpcKey: string, pepper: string): Promise<string> {
  return sha256Hex(`${pepper}:${rpcKey}`);
}

/** Constant-time comparison for secret-derived hex strings. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still walk `a` so the miss doesn't return measurably faster.
    let dummy = 0;
    for (let i = 0; i < a.length; i++) dummy |= a.charCodeAt(i);
    return dummy === -1;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
