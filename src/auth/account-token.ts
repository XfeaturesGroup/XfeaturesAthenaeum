import { ATHENAEUM_ACCESS_SCOPE } from "../branding";
import type { Env } from "../env";
import { logSecurityEvent, SecurityEvent } from "../utils/logging";

/**
 * Verified result of introspecting an Xfeatures Account access token.
 *
 * `clientId` is always present: every Account token is issued to an
 * application. `subject` is present only for user-delegated tokens
 * (authorization_code); a machine token (client_credentials) has no subject.
 * That distinction is what lets Athenaeum tell "application acting for a
 * user" apart from "application acting as itself" (ADR 0001 §5).
 */
export interface VerifiedAccountToken {
  clientId: string;
  subject: string | null;
  scopes: ReadonlySet<string>;
  expiresAt: number;
  /**
   * True when this token was issued to the pre-registered "Athenaeum Developer
   * Access" application -- the PUBLIC/PKCE client a human signs into.
   *
   * SR-024: this is what makes the difference between "an application acting
   * for a user" and "a person". Anyone with an Xfeatures Account can complete
   * that client's flow (a public client has no secret to withhold), so such a
   * token proves only WHICH PERSON is asking, never that the application
   * itself is a principal. Athenaeum therefore resolves it by subject and by
   * nothing else -- see resolvePrincipalForAccountIdentity.
   *
   * Set from the introspected client_id alone, deliberately not from which
   * admission rule let the token through: a Developer Access token that
   * somehow arrived carrying the `athenaeum` scope is still a human's token.
   */
  viaDeveloperAccess: boolean;
}

interface IntrospectionResponse {
  active: boolean;
  client_id?: string;
  sub?: string;
  scope?: string;
  exp?: number;
  token_type?: string;
}

/**
 * Whether a client_id is the configured "Athenaeum Developer Access"
 * application.
 *
 * One predicate, used in three places that must agree: admitting a scope-less
 * human token (below), refusing to resolve such a token through an application
 * row (`resolvePrincipalForAccountIdentity`), and refusing to create an
 * application row on this client id in the first place (`handleCreateAgent`).
 * An unset or empty variable disables the Developer Access path entirely, so
 * this returns false and every caller falls back to its ordinary behaviour.
 */
export function isDeveloperAccessClientId(
  env: Pick<Env, "ACCOUNT_DEVELOPER_ACCESS_CLIENT_ID">,
  clientId: string | null | undefined
): boolean {
  const configured = env.ACCOUNT_DEVELOPER_ACCESS_CLIENT_ID;
  if (configured === undefined || configured.length === 0) return false;
  return typeof clientId === "string" && clientId === configured;
}

/**
 * Abstraction over token verification so the transport can change without
 * touching callers. Today this is an HTTPS call to Xfeatures Account's RFC
 * 7662 endpoint; a Cloudflare Service Binding fast path can replace it later
 * (ADR 0001 §3).
 */
export interface AccountTokenVerifier {
  verify(token: string): Promise<VerifiedAccountToken | null>;
}

interface CacheEntry {
  value: VerifiedAccountToken;
  /** Wall-clock ms after which this entry must not be reused. */
  notAfterMs: number;
}

/**
 * Per-isolate positive-result cache, keyed by the token's SHA-256 hash so the
 * raw bearer token is never held in a map. Bounded two ways: never past the
 * token's own `exp`, and never longer than MAX_TTL_MS so a revoked
 * application stops working promptly rather than at token expiry.
 *
 * Failures are deliberately NOT cached: a negative cache would let a
 * transient introspection outage pin a legitimate caller into denial.
 */
const MAX_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 500;
const tokenCache = new Map<string, CacheEntry>();

async function hashTokenForCache(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function pruneCache(nowMs: number): void {
  for (const [key, entry] of tokenCache) {
    if (entry.notAfterMs <= nowMs) tokenCache.delete(key);
  }
  // Hard ceiling so a token-spraying caller cannot grow the map without bound.
  if (tokenCache.size > MAX_CACHE_ENTRIES) {
    const excess = tokenCache.size - MAX_CACHE_ENTRIES;
    let removed = 0;
    for (const key of tokenCache.keys()) {
      tokenCache.delete(key);
      if (++removed >= excess) break;
    }
  }
}

export class IntrospectionTokenVerifier implements AccountTokenVerifier {
  constructor(private readonly env: Env) {}

  async verify(token: string): Promise<VerifiedAccountToken | null> {
    const { ACCOUNT_INTROSPECTION_URL, ACCOUNT_CLIENT_ID, ACCOUNT_CLIENT_SECRET } = this.env;
    if (!ACCOUNT_INTROSPECTION_URL || !ACCOUNT_CLIENT_ID || !ACCOUNT_CLIENT_SECRET) {
      // Fail closed: an unconfigured integration denies rather than degrading
      // into "no identity provider, allow anyway".
      logSecurityEvent(SecurityEvent.AUTH_FAILURE, { reason: "ACCOUNT_INTROSPECTION_NOT_CONFIGURED" });
      return null;
    }

    const nowMs = Date.now();
    const cacheKey = await hashTokenForCache(token);
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.notAfterMs > nowMs) {
      return cached.value;
    }

    const request = new Request(ACCOUNT_INTROSPECTION_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // Client authentication for the introspection call itself.
        authorization: `Basic ${btoa(`${ACCOUNT_CLIENT_ID}:${ACCOUNT_CLIENT_SECRET}`)}`
      },
      body: new URLSearchParams({ token }).toString()
    });

    let response: Response;
    try {
      // Prefer the Service Binding when one is configured: the call stays
      // inside Cloudflare's network rather than traversing the public internet.
      response = this.env.ACCOUNT_SERVICE
        ? await this.env.ACCOUNT_SERVICE.fetch(request)
        : await fetch(request);
    } catch {
      logSecurityEvent(SecurityEvent.AUTH_FAILURE, { reason: "ACCOUNT_INTROSPECTION_UNREACHABLE" });
      return null;
    }

    if (!response.ok) {
      logSecurityEvent(SecurityEvent.AUTH_FAILURE, { reason: "ACCOUNT_INTROSPECTION_ERROR", status: response.status });
      return null;
    }

    let payload: IntrospectionResponse;
    try {
      payload = await response.json<IntrospectionResponse>();
    } catch {
      return null;
    }

    if (!payload.active || typeof payload.client_id !== "string" || payload.client_id.length === 0) {
      return null;
    }

    const scopes = new Set((payload.scope ?? "").split(" ").filter((s) => s.length > 0));
    const subject = typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null;

    // The coarse ecosystem gate (ADR 0001 §2). Holding it grants no knowledge
    // access on its own -- Athenaeum's own permission set still decides that --
    // but lacking it means the principal was never meant to reach Athenaeum.
    //
    // A human developer's own Account login can never carry this scope: it is
    // only ever unioned into a token by Account's client_credentials grant,
    // which is itself restricted to `app_type: "service"` applications (no
    // consent screen, no subject) -- see xfeatures-auth-api's oauth_provider.ts.
    // Rather than change that (a real Account/HQ product boundary, not an
    // oversight), a human's user-delegated token is accepted through a second,
    // narrower door: it must come from exactly the one pre-registered
    // "Athenaeum Developer Access" Account application, and it must carry a
    // subject (a user-delegated token, never a machine one). Every other
    // application, however privileged its owner, still needs the scope.
    const viaDeveloperAccess = isDeveloperAccessClientId(this.env, payload.client_id);
    const isDeveloperAccessToken = viaDeveloperAccess && subject !== null;

    if (!scopes.has(ATHENAEUM_ACCESS_SCOPE) && !isDeveloperAccessToken) {
      logSecurityEvent(SecurityEvent.AUTHZ_DENY, {
        reason: "MISSING_ATHENAEUM_SCOPE",
        account_client_id: payload.client_id
      });
      return null;
    }

    const expiresAt = typeof payload.exp === "number" ? payload.exp : 0;
    const verified: VerifiedAccountToken = {
      clientId: payload.client_id,
      subject,
      scopes,
      expiresAt,
      viaDeveloperAccess
    };

    const expiryMs = expiresAt > 0 ? expiresAt * 1000 : nowMs;
    const notAfterMs = Math.min(nowMs + MAX_TTL_MS, expiryMs);
    if (notAfterMs > nowMs) {
      pruneCache(nowMs);
      tokenCache.set(cacheKey, { value: verified, notAfterMs });
    }

    return verified;
  }
}

/** Test seam: clears the per-isolate cache so cases cannot bleed into each other. */
export function clearAccountTokenCache(): void {
  tokenCache.clear();
}
