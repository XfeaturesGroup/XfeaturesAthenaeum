import { isDeveloperAccessClientId } from "../../../auth/account-token";
import { authenticateHttpRequest } from "../../../auth/authenticate";
import { assertCanGrantRole } from "../../../auth/resource-guard";
import { runAuthenticatedOperation } from "../../../auth/pipeline";
import { auditChange } from "../../../audit/audit";
import { enforceRateLimit } from "../../../security/rate-limit";
import { generateSecret } from "../../../utils/ids";
import { hashRpcKey } from "../../../utils/hash";
import { ApiError, ErrorCode, jsonResponse } from "../../../utils/responses";
import { readJsonBody, parseQuery } from "../../http";
import { createAgentRequestSchema, setAgentStatusSchema, setAgentQuotaSchema, roleAssignmentSchema } from "../../schemas/admin";
import { paginationSchema } from "../../schemas/common";
import { buildServices } from "../../services";
import type { RouteContext } from "../../router";

/**
 * Mass assignment is prevented by construction: the request schema
 * whitelists exactly the
 * writable fields. There is no way for a caller to set `status`,
 * `rpc_key_hash`, or `created_by` directly -- status always starts "active",
 * the key is generated server-side, and `created_by` is the acting principal,
 * never a client-supplied value.
 *
 * SR-001: creating an agent mints a credential, so this is the
 * single most privilege-sensitive route in the system. It requires
 * `admin.agents`, enforced by the pipeline before this handler runs.
 */
export async function handleCreateAgent(request: Request, ctx: RouteContext): Promise<Response> {
  const services = buildServices(ctx.env);

  const result = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.agents" } },
    // No `resource` here: it named a field of a body this caller has not
    // yet earned the right to have parsed.
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      // Parsed only after the caller is known. Reading the body first meant
      // an anonymous request was parsed and validated before anything checked
      // who sent it: it spends work on strangers outside the unauthenticated
      // budget, and it answers questions they should have to authenticate to
      // ask -- a 400 here and a 404 next door maps the admin surface.
      const body = await readJsonBody(request, createAgentRequestSchema);

      // An agent may only be created in the environment this Worker serves --
      // a staging identity must never be mintable against production.
      if (body.environment !== ctx.env.ENVIRONMENT) {
        throw new ApiError(ErrorCode.INVALID_REQUEST, "Agent environment must match the serving environment.");
      }

      const existing = await services.agentsRepo.findByAgentKey(body.agent_key);
      if (existing) {
        throw new ApiError(ErrorCode.CONFLICT, "An agent with this agent_key already exists.");
      }

      // Privilege containment: an admin cannot mint an identity
      // more powerful than itself. Every permission the requested roles carry
      // must already be held by the caller, so a compromised admin credential
      // cannot bootstrap a strictly stronger one.
      const requestedPermissions = new Set<string>();
      const roles = [];
      for (const roleName of body.roles) {
        const role = await services.rolesRepo.getByName(roleName);
        if (!role) throw new ApiError(ErrorCode.INVALID_REQUEST, `Unknown role: ${roleName}`);
        roles.push(role);
        for (const permission of await services.rolesRepo.listPermissionsForRole(role.id)) {
          requestedPermissions.add(permission.key);
        }
      }
      assertCanGrantRole(principal, [...requestedPermissions]);

      let rpcKey: string | undefined;
      let rpcKeyHash: string | undefined;
      if (body.auth_mode === "rpc") {
        rpcKey = generateSecret();
        rpcKeyHash = await hashRpcKey(rpcKey, ctx.env.RPC_KEY_PEPPER);
      }

      if (body.auth_mode === "account") {
        // SR-024: the Developer Access application is a public/PKCE client any
        // Account holder can sign into. An agent row linked to it would be an
        // application principal reachable by a person, which is a category
        // error -- authentication refuses to resolve one (see
        // resolvePrincipalForAccountIdentity), so creating it could only ever
        // produce a row that looks like access and grants none. Refused here
        // as well, so HQ's Access page reports the mistake at the moment it is
        // made rather than leaving a misleading row behind. Human Developer
        // Access principals are linked by `account_user_id`, one per person.
        if (isDeveloperAccessClientId(ctx.env, body.account_client_id)) {
          throw new ApiError(
            ErrorCode.INVALID_REQUEST,
            "The Athenaeum Developer Access application is resolved per person. Link a specific account_user_id instead of its client_id."
          );
        }

        // One Athenaeum agent per Account identity -- resolvePrincipalForAccountIdentity
        // picks the first match, so a second agent on the same identity would
        // be unreachable rather than merely redundant.
        const existingLink = body.account_client_id
          ? await services.agentsRepo.findByAccountClientId(body.account_client_id)
          : body.account_user_id
            ? await services.agentsRepo.findByAccountUserId(body.account_user_id)
            : null;
        if (existingLink) {
          throw new ApiError(ErrorCode.CONFLICT, "This Account identity is already linked to an Athenaeum agent.");
        }
      }

      const agent = await services.agentsRepo.create({
        agentKey: body.agent_key,
        name: body.name,
        description: body.description,
        environment: body.environment,
        authMode: body.auth_mode,
        rpcKeyHash,
        principalType: body.principal_type,
        accountClientId: body.account_client_id,
        accountUserId: body.account_user_id,
        createdBy: principal.agentId
      });

      for (const role of roles) {
        await services.agentsRepo.assignRole(agent.id, role.id);
      }

      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.agents.create",
        principal,
        resource: { type: "agent", id: agent.id },
        newValue: { agent_key: agent.agent_key, environment: agent.environment, auth_mode: agent.auth_mode, roles: body.roles }
      });

      return {
        id: agent.id,
        agent_key: agent.agent_key,
        status: agent.status,
        auth_mode: agent.auth_mode,
        // Shown exactly once: only the peppered hash is ever persisted.
        rpc_key: rpcKey
      };
    }
  });

  return jsonResponse({ request_id: ctx.requestId, agent: result }, 201);
}

export async function handleListAgents(request: Request, ctx: RouteContext): Promise<Response> {
  const { limit, offset } = parseQuery(ctx.url, paginationSchema);
  const services = buildServices(ctx.env);

  const agents = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.agents" } },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      const rows = await services.agentsRepo.list({ limit, offset });
      // rpc_key_hash is never projected into a response.
      return rows.map((row) => ({
        id: row.id,
        agent_key: row.agent_key,
        name: row.name,
        environment: row.environment,
        status: row.status,
        auth_mode: row.auth_mode
      }));
    }
  });

  return jsonResponse({ request_id: ctx.requestId, agents, limit, offset });
}

export async function handleSetAgentStatus(request: Request, ctx: RouteContext): Promise<Response> {
  const agentId = ctx.params["id"] ?? "";
  const services = buildServices(ctx.env);

  const result = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.agents" } },
    resource: { type: "agent", id: agentId },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      // Parsed only after the caller is known. Reading the body first meant
      // an anonymous request was parsed and validated before anything checked
      // who sent it: it spends work on strangers outside the unauthenticated
      // budget, and it answers questions they should have to authenticate to
      // ask -- a 400 here and a 404 next door maps the admin surface.
      const body = await readJsonBody(request, setAgentStatusSchema);
      const current = await services.agentsRepo.findById(agentId);
      if (!current) throw new ApiError(ErrorCode.NOT_FOUND, "Agent not found.");

      await services.agentsRepo.setStatus(agentId, body.status, principal.agentId);
      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.agents.set_status",
        principal,
        resource: { type: "agent", id: agentId },
        oldValue: { status: current.status },
        newValue: { status: body.status }
      });
      return { id: agentId, status: body.status };
    }
  });

  return jsonResponse({ request_id: ctx.requestId, agent: result });
}

/**
 * Sets an agent's daily quota (`security/quota.ts` enforces it on every
 * search/write/upload). An omitted field leaves that dimension exactly as it
 * already was; an explicit `null` clears it back to unlimited -- the merge
 * happens here, server-side, so a caller only ever has to say what it wants
 * to change (never re-send the whole triple, unlike the HQ apps.ts verify
 * endpoint's echo-every-flag convention, which this deliberately does not copy).
 */
export async function handleSetAgentQuota(request: Request, ctx: RouteContext): Promise<Response> {
  const agentId = ctx.params["id"] ?? "";
  const services = buildServices(ctx.env);

  const result = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.agents" } },
    resource: { type: "agent", id: agentId },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      // Parsed only after the caller is known. Reading the body first meant
      // an anonymous request was parsed and validated before anything checked
      // who sent it: it spends work on strangers outside the unauthenticated
      // budget, and it answers questions they should have to authenticate to
      // ask -- a 400 here and a 404 next door maps the admin surface.
      const body = await readJsonBody(request, setAgentQuotaSchema);
      const agent = await services.agentsRepo.findById(agentId);
      if (!agent) throw new ApiError(ErrorCode.NOT_FOUND, "Agent not found.");

      const current = await services.quotaRepo.getQuota(agentId);
      const resolved = {
        maxSearchesPerDay: body.max_searches_per_day !== undefined ? body.max_searches_per_day : (current?.max_searches_per_day ?? null),
        maxWritesPerDay: body.max_writes_per_day !== undefined ? body.max_writes_per_day : (current?.max_writes_per_day ?? null),
        maxUploadsPerDay: body.max_uploads_per_day !== undefined ? body.max_uploads_per_day : (current?.max_uploads_per_day ?? null)
      };

      await services.quotaRepo.setQuota(agentId, resolved, principal.agentId);
      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.agents.set_quota",
        principal,
        resource: { type: "agent", id: agentId },
        oldValue: {
          max_searches_per_day: current?.max_searches_per_day ?? null,
          max_writes_per_day: current?.max_writes_per_day ?? null,
          max_uploads_per_day: current?.max_uploads_per_day ?? null
        },
        newValue: resolved
      });
      return { id: agentId, ...resolved };
    }
  });

  return jsonResponse({ request_id: ctx.requestId, quota: result });
}

/**
 * Full detail for the HQ Access page: the agent row, its roles, and its
 * resolved effective permission set (wildcard-expanded via resolvePermissions,
 * the same call the authorization pipeline itself uses -- so what an operator
 * sees here is exactly what the agent can do, not an approximation of it).
 */
export async function handleGetAgent(request: Request, ctx: RouteContext): Promise<Response> {
  const agentId = ctx.params["id"] ?? "";
  const services = buildServices(ctx.env);

  const result = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.agents" } },
    resource: { type: "agent", id: agentId },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      const agent = await services.agentsRepo.findById(agentId);
      if (!agent) throw new ApiError(ErrorCode.NOT_FOUND, "Agent not found.");

      const [roles, permissions] = await Promise.all([
        services.agentsRepo.listRoleNames(agent.id),
        services.agentsRepo.resolvePermissions(agent.id)
      ]);

      return {
        id: agent.id,
        agent_key: agent.agent_key,
        name: agent.name,
        description: agent.description,
        environment: agent.environment,
        status: agent.status,
        auth_mode: agent.auth_mode,
        principal_type: agent.principal_type,
        account_client_id: agent.account_client_id,
        account_user_id: agent.account_user_id,
        roles,
        effective_permissions: [...permissions].sort(),
        created_at: agent.created_at,
        updated_at: agent.updated_at
      };
    }
  });

  return jsonResponse({ request_id: ctx.requestId, agent: result });
}

/**
 * Grants an existing agent a role.
 *
 * Privilege containment applies exactly as it does at agent creation
 *: every permission the role carries must already be held by
 * the caller, wildcard-aware, so an administrator can never hand out a role
 * stronger than their own credential. This is the same reasoning, applied to
 * an existing identity instead of a freshly minted one -- and it matters more
 * here, since role assignment is the everyday path once agents already exist.
 */
export async function handleAssignAgentRole(request: Request, ctx: RouteContext): Promise<Response> {
  const agentId = ctx.params["id"] ?? "";
  const services = buildServices(ctx.env);

  const result = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.agents" } },
    resource: { type: "agent", id: agentId },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      // Parsed only after the caller is known. Reading the body first meant
      // an anonymous request was parsed and validated before anything checked
      // who sent it: it spends work on strangers outside the unauthenticated
      // budget, and it answers questions they should have to authenticate to
      // ask -- a 400 here and a 404 next door maps the admin surface.
      const body = await readJsonBody(request, roleAssignmentSchema);
      const agent = await services.agentsRepo.findById(agentId);
      if (!agent) throw new ApiError(ErrorCode.NOT_FOUND, "Agent not found.");

      const role = await services.rolesRepo.getByName(body.role);
      if (!role) throw new ApiError(ErrorCode.INVALID_REQUEST, `Unknown role: ${body.role}`);

      const rolePermissions = await services.rolesRepo.listPermissionsForRole(role.id);
      assertCanGrantRole(principal, rolePermissions.map((p) => p.key));

      await services.agentsRepo.assignRole(agent.id, role.id);
      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.agents.assign_role",
        principal,
        resource: { type: "agent", id: agentId },
        newValue: { role: body.role }
      });

      return { id: agentId, roles: await services.agentsRepo.listRoleNames(agentId) };
    }
  });

  return jsonResponse({ request_id: ctx.requestId, agent: result });
}

/**
 * Revokes a role from an agent. Unlike granting, removing access is never a
 * privilege-escalation risk, so this needs only `admin.agents` -- the same
 * gate that lets an administrator disable the agent outright.
 */
export async function handleUnassignAgentRole(request: Request, ctx: RouteContext): Promise<Response> {
  const agentId = ctx.params["id"] ?? "";
  const roleName = ctx.params["role"] ?? "";
  const services = buildServices(ctx.env);

  const result = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.agents" } },
    resource: { type: "agent", id: agentId },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      const agent = await services.agentsRepo.findById(agentId);
      if (!agent) throw new ApiError(ErrorCode.NOT_FOUND, "Agent not found.");

      const role = await services.rolesRepo.getByName(roleName);
      if (!role) throw new ApiError(ErrorCode.INVALID_REQUEST, `Unknown role: ${roleName}`);

      await services.agentsRepo.unassignRole(agent.id, role.id);
      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.agents.unassign_role",
        principal,
        resource: { type: "agent", id: agentId },
        oldValue: { role: roleName }
      });

      return { id: agentId, roles: await services.agentsRepo.listRoleNames(agentId) };
    }
  });

  return jsonResponse({ request_id: ctx.requestId, agent: result });
}
/**
 * Removes a principal from Access.
 *
 * Revoking is what stops a credential working, and it happens first: this route
 * refuses anything that is not already `revoked`, so deletion is never the
 * first thing that happens to a working identity, and an operator always
 * performs the reversible act before the irreversible one.
 *
 * What "deleted" means depends on whether there is history to protect, and the
 * choice is made here rather than by the caller (migration 0007):
 *
 *   * Nothing references the principal -- it authenticated no request, filed no
 *     feedback, proposed nothing. The row is destroyed, roles and quotas with
 *     it. This is the mistyped-agent case, which is most of them.
 *   * Anything references it. The row becomes a tombstone: gone from every
 *     listing, every credential binding cleared so it can never authenticate or
 *     be re-linked to an Account identity, and still there for the audit events
 *     that name it to point at. An identity that could erase its own history by
 *     being deleted would be worse than one that could not be deleted at all.
 *
 * A principal may not delete itself. HQ operates as a single machine principal,
 * so without this an operator could cut the entire console off from Athenaeum
 * with one click and have no way back in -- and the request would be authorized,
 * which is precisely why the rule has to be here rather than in the console.
 */
export async function handleDeleteAgent(request: Request, ctx: RouteContext): Promise<Response> {
  const agentId = ctx.params["id"] ?? "";
  const services = buildServices(ctx.env);

  const result = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.agents" } },
    resource: { type: "agent", id: agentId },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");

      const agent = await services.agentsRepo.findById(agentId);
      if (!agent) throw new ApiError(ErrorCode.NOT_FOUND, "Agent not found.");

      if (agent.id === principal.agentId) {
        throw new ApiError(ErrorCode.CONFLICT, "A principal cannot delete itself.");
      }
      if (agent.status !== "revoked") {
        throw new ApiError(
          ErrorCode.CONFLICT,
          "Revoke this principal before deleting it. Revoking is what stops the credential working; deleting only removes the row."
        );
      }

      // Recorded before the row goes: afterwards there is nothing left to ask
      // what it was.
      const roles = await services.agentsRepo.listRoleNames(agent.id);
      const references = await services.agentsRepo.countReferences(agent.id);

      const outcome = references === 0 ? "purged" : "tombstoned";
      const removed =
        references === 0
          ? await services.agentsRepo.purge(agent.id)
          : (await services.agentsRepo.softDelete(agent.id, principal.agentId)) !== null;

      // The guards inside both statements repeat the status check, so a
      // concurrent re-activation loses the race rather than being deleted.
      if (!removed) throw new ApiError(ErrorCode.CONFLICT, "This principal changed while it was being deleted.");

      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.agents.delete",
        principal,
        resource: { type: "agent", id: agentId },
        oldValue: {
          agent_key: agent.agent_key,
          name: agent.name,
          principal_type: agent.principal_type,
          auth_mode: agent.auth_mode,
          roles
        },
        newValue: { outcome, references }
      });

      return { id: agentId, agent_key: agent.agent_key, outcome };
    }
  });

  return jsonResponse({ request_id: ctx.requestId, agent: result });
}
