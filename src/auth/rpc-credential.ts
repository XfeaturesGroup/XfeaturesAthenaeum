import { hashRpcKey, timingSafeEqual } from "../utils/hash";

export interface RpcCredential {
  agentKey: string;
  rpcKey: string;
}

export function isRpcCredential(value: unknown): value is RpcCredential {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["agentKey"] === "string" && typeof record["rpcKey"] === "string";
}

/**
 * Verifies a caller-supplied RPC key against the stored peppered hash.
 * Constant-time comparison so a compromised caller can't time its way to a
 * valid key.
 */
export async function verifyRpcKey(rpcKey: string, storedHash: string, pepper: string): Promise<boolean> {
  const computed = await hashRpcKey(rpcKey, pepper);
  return timingSafeEqual(computed, storedHash);
}
