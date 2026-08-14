import { createHash, randomBytes } from "node:crypto";

/** RFC 7636. `base64url` (no padding) matches what Account's PKCE verification expects (see xfeatures-auth-api's oauth_provider.ts). */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function generateState(): string {
  return randomBytes(16).toString("base64url");
}
