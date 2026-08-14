import { ApiError, type ErrorCode } from "../utils/responses";

export interface RpcErrorPayload {
  code: ErrorCode | "INTERNAL_ERROR";
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Workers RPC does not guarantee custom Error subclasses
 * survive the structured-clone boundary with their extra fields intact --
 * only `message` is reliably preserved. So every RPC method funnels thrown
 * errors through here: the JSON-encoded payload goes in `message`, and
 * `parseRpcError` on the caller's side (see examples/support-agent-worker)
 * decodes it back into the same {code, message, details} shape REST returns.
 */
/**
 * SR-012: the RPC boundary returns exactly what the REST boundary returns --
 * the public code and a safe message, never `details`. `details` carries
 * internal authorization reasons and validation internals that the REST
 * error envelope deliberately withholds; leaking them only over RPC would
 * make the two transports differ in what they disclose.
 */
export function throwRpcError(error: unknown): never {
  const payload: RpcErrorPayload =
    error instanceof ApiError
      ? { code: error.publicCode, message: error.message }
      : { code: "INTERNAL_ERROR", message: "Internal error." };
  throw new Error(JSON.stringify(payload));
}

export function parseRpcError(error: unknown): RpcErrorPayload {
  if (error instanceof Error) {
    try {
      const parsed: unknown = JSON.parse(error.message);
      if (typeof parsed === "object" && parsed !== null && "code" in parsed && "message" in parsed) {
        return parsed as RpcErrorPayload;
      }
    } catch {
      // fall through to the generic payload below
    }
  }
  return { code: "INTERNAL_ERROR", message: "Internal error." };
}
