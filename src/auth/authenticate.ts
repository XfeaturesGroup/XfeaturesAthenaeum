import type { Env } from "../env";
import { AgentsRepository } from "../repositories/agents.repository";
import { logSecurityEvent, SecurityEvent } from "../utils/logging";
import { verifyAccessJwt } from "./access-jwt";
import { IntrospectionTokenVerifier } from "./account-token";
import { isRpcCredential, verifyRpcKey, type RpcCredential } from "./rpc-credential";
import type { AuthResult } from "./types";

/**
 * Resolves the authenticated agent's Principal from D1, given an identity
 * that has already passed transport-level verification (a valid Access JWT
 * or a valid RPC key). This is the single place that turns "who does the
 * caller claim to be" into "what can they actually do" -- REST, RPC, and MCP
 * all funnel through here so there is exactly one authorization backend
 *.
 *
 * Fail-closed: an unknown agent_key, a disabled/revoked agent, or any D1
 * error all resolve to a denial, never to a default role.
 */
async function resolvePrincipalForAgentKey(agentKey: string, env: Env): Promise<AuthResult> {
  const repo = new AgentsRepository(env.DB);
  let agent;
  try {
    agent = await repo.findByAgentKey(agentKey);
  } catch {
    logSecurityEvent(SecurityEvent.AUTH_FAILURE, { reason: "AGENT_LOOKUP_ERROR", agent_key: agentKey });
    return { ok: false, reason: "DEPENDENCY_UNAVAILABLE" };
  }

  if (!agent) {
    logSecurityEvent(SecurityEvent.AUTH_FAILURE, { reason: "UNKNOWN_AGENT", agent_key: agentKey });
    return { ok: false, reason: "UNKNOWN_AGENT" };
  }
  if (agent.status !== "active") {
    logSecurityEvent(SecurityEvent.AUTH_FAILURE, { reason: "AGENT_DISABLED", agent_key: agentKey, status: agent.status });
    return { ok: false, reason: "AGENT_DISABLED" };
  }

  // SR-011: an identity is bound to the environment it was issued for. Each
  // environment has its own D1, so this should be unreachable -- but if a
  // database were ever restored, cloned, or mis-pointed across environments,
  // a staging identity must not silently become a production one.
  if (agent.environment !== env.ENVIRONMENT) {
    logSecurityEvent(SecurityEvent.AUTH_FAILURE, {
      reason: "ENVIRONMENT_MISMATCH",
      agent_key: agentKey,
      agent_environment: agent.environment,
      worker_environment: env.ENVIRONMENT
    });
    return { ok: false, reason: "UNKNOWN_AGENT" };
  }

  let permissions: Set<string>;
  try {
    permissions = await repo.resolvePermissions(agent.id);
  } catch {
    logSecurityEvent(SecurityEvent.AUTH_FAILURE, { reason: "PERMISSION_LOOKUP_ERROR", agent_key: agentKey });
    return { ok: false, reason: "DEPENDENCY_UNAVAILABLE" };
  }

  return {
    ok: true,
    principal: {
      agentId: agent.id,
      agentKey: agent.agent_key,
      environment: agent.environment,
      permissions
    }
  };
}

/**
 * Resolves a Principal from an Xfeatures Account identity that has already
 * been cryptographically verified by introspection (ADR 0001 §2/§6).
 *
 * The Account token proves WHO the caller is. It never carries knowledge
 * permissions -- those are read here, from Athenaeum's own D1, keyed on the
 * introspected client_id/subject. A caller therefore cannot influence its own
 * permission set by manipulating the token's scope beyond the coarse
 * `athenaeum` gate, which is checked during introspection.
 */
async function resolvePrincipalForAccountIdentity(
  identity: { clientId: string; subject: string | null },
  env: Env
): Promise<AuthResult> {
  const repo = new AgentsRepository(env.DB);
  let agent;
  try {
    // A user-delegated token resolves to the USER principal when Athenaeum
    // knows that user; otherwise the application itself is the principal. The
    // subject is preferred so an HQ administrator acting through an
    // application gets their own (typically broader) permissions rather than
    // the application's.
    agent =
      (identity.subject ? await repo.findByAccountUserId(identity.subject) : null) ??
      (await repo.findByAccountClientId(identity.clientId));
  } catch {
    logSecurityEvent(SecurityEvent.AUTH_FAILURE, { reason: "ACCOUNT_AGENT_LOOKUP_ERROR" });
    return { ok: false, reason: "DEPENDENCY_UNAVAILABLE" };
  }

  if (!agent) {
    // The token is valid for Xfeatures Account but this identity has no
    // Athenaeum principal: default deny, never an implicit registration.
    logSecurityEvent(SecurityEvent.AUTH_FAILURE, {
      reason: "NO_ATHENAEUM_PRINCIPAL_FOR_ACCOUNT_IDENTITY",
      account_client_id: identity.clientId
    });
    return { ok: false, reason: "UNKNOWN_AGENT" };
  }

  return resolvePrincipalForAgentKey(agent.agent_key, env);
}

/**
 * REST and MCP entry point. Two credential shapes are accepted, in a fixed
 * order, and both converge on the same D1-backed permission resolution:
 *
 *  1. `Authorization: Bearer <token>` -- an Xfeatures Account access token
 *     (ADR 0001). This is the path used by HQ, the SDK, the CLI and MCP
 *     clients.
 *  2. `Cf-Access-Jwt-Assertion` -- a Cloudflare Access service token, for
 *     infrastructure that sits behind Access rather than holding an Account
 *     credential.
 */
export async function authenticateHttpRequest(request: Request, env: Env): Promise<AuthResult> {
  const authorization = request.headers.get("Authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice(7).trim();
    if (token.length === 0) {
      return { ok: false, reason: "MISSING_CREDENTIALS" };
    }

    const verified = await new IntrospectionTokenVerifier(env).verify(token);
    if (!verified) {
      logSecurityEvent(SecurityEvent.INVALID_TOKEN, { source: "account_token" });
      return { ok: false, reason: "INVALID_TOKEN" };
    }
    return resolvePrincipalForAccountIdentity(verified, env);
  }

  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) {
    return { ok: false, reason: "MISSING_CREDENTIALS" };
  }

  const identity = await verifyAccessJwt(assertion, env);
  if (!identity) {
    logSecurityEvent(SecurityEvent.INVALID_TOKEN, { source: "access_jwt" });
    return { ok: false, reason: "INVALID_TOKEN" };
  }

  return resolvePrincipalForAgentKey(identity.commonName, env);
}

/** RPC (Service Binding) entry point: verifies the caller-supplied agent key/secret pair, then resolves the Principal. */
export async function authenticateRpcCredential(credential: unknown, env: Env): Promise<AuthResult> {
  if (!isRpcCredential(credential)) {
    return { ok: false, reason: "MISSING_CREDENTIALS" };
  }

  const repo = new AgentsRepository(env.DB);
  let agent;
  try {
    agent = await repo.findByAgentKey(credential.agentKey);
  } catch {
    return { ok: false, reason: "DEPENDENCY_UNAVAILABLE" };
  }

  if (agent?.auth_mode !== "rpc" || !agent.rpc_key_hash) {
    logSecurityEvent(SecurityEvent.AUTH_FAILURE, { reason: "UNKNOWN_RPC_AGENT", agent_key: credential.agentKey });
    return { ok: false, reason: "UNKNOWN_AGENT" };
  }
  if (agent.status !== "active") {
    logSecurityEvent(SecurityEvent.AUTH_FAILURE, { reason: "AGENT_DISABLED", agent_key: credential.agentKey });
    return { ok: false, reason: "AGENT_DISABLED" };
  }

  const valid = await verifyRpcKey(credential.rpcKey, agent.rpc_key_hash, env.RPC_KEY_PEPPER);
  if (!valid) {
    logSecurityEvent(SecurityEvent.INVALID_TOKEN, { source: "rpc_key", agent_key: credential.agentKey });
    return { ok: false, reason: "INVALID_TOKEN" };
  }

  return resolvePrincipalForAgentKey(credential.agentKey, env);
}

export type { RpcCredential };
