import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "../env";

// createRemoteJWKSet's returned function keeps its own internal fetch/refresh
// cache and is meant to be reused across requests within an isolate -- this
// module-level map (keyed by team domain, not by request) is that reuse, not
// request-scoped mutable state.
const jwksByTeamDomain = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksByTeamDomain.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksByTeamDomain.set(teamDomain, jwks);
  }
  return jwks;
}

export interface VerifiedAccessIdentity {
  /** The Access service token's `common_name`, mapped 1:1 to agents.agent_key. */
  commonName: string;
}

/**
 * Verifies a Cloudflare Access application JWT (the `Cf-Access-Jwt-Assertion`
 * header value). Any failure -- expired, wrong audience, unparseable, or
 * Access not configured for this environment -- returns null. Callers must
 * treat null as "no identity", never as "identity unknown, allow anyway"
 * (fail closed).
 */
export async function verifyAccessJwt(token: string, env: Env): Promise<VerifiedAccessIdentity | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  try {
    const jwks = getJwks(env.ACCESS_TEAM_DOMAIN);
    const { payload } = await jwtVerify(token, jwks, {
      issuer: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
      // SR-010: pin the signature algorithms rather than accepting whatever
      // the token's own header asks for. jose already refuses `alg: none`,
      // but an explicit allowlist also blocks any future confusion between
      // an RSA/EC verification key and a symmetric (HMAC) one.
      algorithms: ["RS256", "ES256"],
      // Access tokens are short-lived; refuse anything with excessive clock
      // skew rather than silently tolerating it.
      clockTolerance: 30
    });

    // A Service Auth token carries `common_name`; an interactive user session
    // carries `email` instead. Only service identities may authenticate here,
    // so the absence of `common_name` is a denial, never a fallback to email.
    const commonName = payload["common_name"];
    if (typeof commonName !== "string" || commonName.length === 0) return null;
    return { commonName };
  } catch {
    return null;
  }
}
