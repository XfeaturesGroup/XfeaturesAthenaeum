import { authenticateHttpRequest } from "../../../auth/authenticate";
import { runAuthenticatedOperation } from "../../../auth/pipeline";
import { assertCanAccessFact, assertCanReclassifyFact } from "../../../auth/resource-guard";
import { auditChange } from "../../../audit/audit";
import { LIMITS } from "../../../config";
import { toFactDTO } from "../../../knowledge/facts";
import { StaleVersionError } from "../../../db/errors";
import { enforceRateLimit } from "../../../security/rate-limit";
import { enforceQuota } from "../../../security/quota";
import { ApiError, ErrorCode, jsonResponse } from "../../../utils/responses";
import { parseQuery, readJsonBody } from "../../http";
import { createFactRequestSchema, listFactsQuerySchema, rollbackRequestSchema, updateFactRequestSchema } from "../../schemas/admin";
import { paginationSchema } from "../../schemas/common";
import { buildServices } from "../../services";
import type { RouteContext } from "../../router";

export async function handleCreateFact(request: Request, ctx: RouteContext): Promise<Response> {
  const services = buildServices(ctx.env);

  const fact = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.facts" } },
    // No `resource` here: it named a field of a body this caller has not
    // yet earned the right to have parsed.
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      await enforceQuota(ctx.env, principal, "writes");
      // Parsed only after the caller is known. Reading the body first meant
      // an anonymous request was parsed and validated before anything checked
      // who sent it: it spends work on strangers outside the unauthenticated
      // budget, and it answers questions they should have to authenticate to
      // ask -- a 400 here and a 404 next door maps the admin surface.
      const body = await readJsonBody(request, createFactRequestSchema);
      // May only file a fact under a namespace/classification it could read back.
      assertCanAccessFact(principal, body.namespace, body.classification);

      const existing = await services.factsRepo.getActive(body.namespace, body.key);
      if (existing) throw new ApiError(ErrorCode.CONFLICT, "A fact with this namespace/key already exists.");

      const created = await services.factsRepo.create({
        namespace: body.namespace,
        key: body.key,
        valueJson: JSON.stringify(body.value ?? null),
        title: body.title,
        description: body.description,
        classification: body.classification,
        sourceId: body.source_id,
        validFrom: body.valid_from,
        validUntil: body.valid_until,
        createdBy: principal.agentId
      });

      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.facts.create",
        principal,
        resource: { type: "fact", id: `${created.namespace}/${created.key}` },
        newValue: { classification: created.classification, version: created.version }
      });
      return toFactDTO(created);
    }
  });

  return jsonResponse({ request_id: ctx.requestId, fact }, 201);
}

export async function handleUpdateFact(request: Request, ctx: RouteContext): Promise<Response> {
  const namespace = ctx.params["namespace"] ?? "";
  const key = ctx.params["key"] ?? "";
  const services = buildServices(ctx.env);

  const fact = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.facts" } },
    resource: { type: "fact", id: `${namespace}/${key}` },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      await enforceQuota(ctx.env, principal, "writes");
      // Parsed only after the caller is known. Reading the body first meant
      // an anonymous request was parsed and validated before anything checked
      // who sent it: it spends work on strangers outside the unauthenticated
      // budget, and it answers questions they should have to authenticate to
      // ask -- a 400 here and a 404 next door maps the admin surface.
      const body = await readJsonBody(request, updateFactRequestSchema);
      const before = await services.factsRepo.getActive(namespace, key);
      // Existence of a fact the caller cannot read is itself not disclosed.
      if (!before) throw new ApiError(ErrorCode.NOT_FOUND, "Fact not found.");
      assertCanReclassifyFact(principal, namespace, before.classification, body.classification);

      let updated;
      try {
        updated = await services.factsRepo.update(namespace, key, {
          valueJson: body.value !== undefined ? JSON.stringify(body.value) : undefined,
          title: body.title,
          description: body.description,
          classification: body.classification,
          status: body.status,
          updatedBy: principal.agentId,
          expectedVersion: body.expected_version
        });
      } catch (error) {
        if (error instanceof StaleVersionError) {
          throw new ApiError(ErrorCode.STALE_VERSION, "This fact was modified concurrently; re-read it and retry.");
        }
        throw error;
      }

      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.facts.update",
        principal,
        resource: { type: "fact", id: `${namespace}/${key}` },
        oldValue: { version: before.version, classification: before.classification, status: before.status },
        newValue: { version: updated.version, classification: updated.classification, status: updated.status }
      });
      return toFactDTO(updated);
    }
  });

  return jsonResponse({ request_id: ctx.requestId, fact });
}

export async function handleDeprecateFact(request: Request, ctx: RouteContext): Promise<Response> {
  const namespace = ctx.params["namespace"] ?? "";
  const key = ctx.params["key"] ?? "";
  const services = buildServices(ctx.env);

  await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.facts" } },
    resource: { type: "fact", id: `${namespace}/${key}` },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      await enforceQuota(ctx.env, principal, "writes");
      const before = await services.factsRepo.getActive(namespace, key);
      if (!before) throw new ApiError(ErrorCode.NOT_FOUND, "Fact not found.");
      assertCanAccessFact(principal, namespace, before.classification);

      await services.factsRepo.deprecate(namespace, key, principal.agentId);
      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.facts.deprecate",
        principal,
        resource: { type: "fact", id: `${namespace}/${key}` },
        oldValue: { status: before.status },
        newValue: { status: "deprecated" }
      });
    }
  });

  return jsonResponse({ request_id: ctx.requestId, namespace, key, status: "deprecated" });
}

/** Restore a prior version's content as the new current version. */
export async function handleRollbackFact(request: Request, ctx: RouteContext): Promise<Response> {
  const namespace = ctx.params["namespace"] ?? "";
  const key = ctx.params["key"] ?? "";
  const services = buildServices(ctx.env);

  const fact = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.facts" } },
    resource: { type: "fact", id: `${namespace}/${key}` },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      await enforceQuota(ctx.env, principal, "writes");
      // Parsed only after the caller is known. Reading the body first meant
      // an anonymous request was parsed and validated before anything checked
      // who sent it: it spends work on strangers outside the unauthenticated
      // budget, and it answers questions they should have to authenticate to
      // ask -- a 400 here and a 404 next door maps the admin surface.
      const body = await readJsonBody(request, rollbackRequestSchema);
      const before = await services.factsRepo.getActive(namespace, key);
      if (!before) throw new ApiError(ErrorCode.NOT_FOUND, "Fact not found.");
      assertCanAccessFact(principal, namespace, before.classification);

      // The target version carries its own classification -- rolling back is a
      // reclassification if that tier differs from the current one.
      const target = await services.factsRepo.getVersion(namespace, key, body.version);
      if (!target) throw new ApiError(ErrorCode.NOT_FOUND, "Fact version not found.");
      assertCanReclassifyFact(principal, namespace, before.classification, target.classification);

      const rolledBack = await services.facts.rollback(principal, namespace, key, body.version, principal.agentId);

      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.facts.rollback",
        principal,
        resource: { type: "fact", id: `${namespace}/${key}` },
        oldValue: { version: before.version, classification: before.classification },
        newValue: { version: rolledBack.version, classification: rolledBack.classification, rolled_back_to: body.version }
      });
      return rolledBack;
    }
  });

  return jsonResponse({ request_id: ctx.requestId, fact });
}


/**
 * Facts across every namespace the caller may read.
 *
 * The console needs this to offer "all facts" at all; before it existed, HQ
 * had a hardcoded list of six namespaces, so anything filed outside them was
 * invisible to every operator while being perfectly readable over the API.
 *
 * `admin.facts` opens the listing; it does not decide what comes back. The
 * service authorizes every row against the caller's namespace scope and
 * classification tiers, so this cannot become a way to read what the caller
 * was never granted (SR-002/SR-003).
 */
export async function handleListFactsForAdmin(request: Request, ctx: RouteContext): Promise<Response> {
  const query = parseQuery(ctx.url, listFactsQuerySchema);
  const services = buildServices(ctx.env);

  const facts = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.facts" } },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      return services.facts.listFactsForAdmin(principal, {
        namespace: query.namespace,
        status: query.status,
        query: query.q,
        limit: query.limit,
        offset: query.offset
      });
    }
  });

  return jsonResponse({ request_id: ctx.requestId, facts, limit: query.limit, offset: query.offset });
}

/** A fact's history: what it used to say, and who changed it. */
export async function handleListFactVersions(request: Request, ctx: RouteContext): Promise<Response> {
  const namespace = ctx.params["namespace"] ?? "";
  const key = ctx.params["key"] ?? "";
  const services = buildServices(ctx.env);

  const versions = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.facts" } },
    resource: { type: "fact", id: `${namespace}/${key}` },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "read");
      return services.facts.listVersions(principal, namespace, key);
    }
  });

  return jsonResponse({ request_id: ctx.requestId, versions });
}

/**
 * Moves a fact to the trash.
 *
 * Distinct from deprecation, which is what DELETE on this resource does and
 * always has: deprecating says "no longer current" and keeps every version
 * forever. This says "this should not be in the knowledge base", and the
 * content is destroyed by the scheduled purge once the retention window closes.
 * There is no manual permanent delete here, for the same reason there is none
 * for documents.
 */
export async function handleTrashFact(request: Request, ctx: RouteContext): Promise<Response> {
  const namespace = ctx.params["namespace"] ?? "";
  const key = ctx.params["key"] ?? "";
  const services = buildServices(ctx.env);

  const fact = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.facts" } },
    resource: { type: "fact", id: `${namespace}/${key}` },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      await enforceQuota(ctx.env, principal, "writes");
      const trashed = await services.facts.moveToTrash(principal, namespace, key, principal.agentId);
      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.facts.trash",
        principal,
        resource: { type: "fact", id: `${namespace}/${key}` },
        newValue: { status: trashed.status }
      });
      return trashed;
    }
  });

  return jsonResponse({ request_id: ctx.requestId, fact });
}

/** Returns a trashed fact to the state it was in before it was deleted. */
export async function handleRestoreFact(request: Request, ctx: RouteContext): Promise<Response> {
  const namespace = ctx.params["namespace"] ?? "";
  const key = ctx.params["key"] ?? "";
  const services = buildServices(ctx.env);

  const fact = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.facts" } },
    resource: { type: "fact", id: `${namespace}/${key}` },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      await enforceQuota(ctx.env, principal, "writes");
      const restored = await services.facts.restoreFromTrash(principal, namespace, key, principal.agentId);
      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.facts.restore",
        principal,
        resource: { type: "fact", id: `${namespace}/${key}` },
        newValue: { status: restored.status }
      });
      return restored;
    }
  });

  return jsonResponse({ request_id: ctx.requestId, fact });
}

/** What has been deleted, and how long is left to change your mind. */
export async function handleListFactTrash(request: Request, ctx: RouteContext): Promise<Response> {
  const { limit, offset } = parseQuery(ctx.url, paginationSchema);
  const services = buildServices(ctx.env);

  const facts = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.facts" } },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      return services.facts.listTrash(principal, { limit, offset });
    }
  });

  return jsonResponse({
    request_id: ctx.requestId,
    facts,
    retention_hours: LIMITS.TRASH_RETENTION_HOURS,
    limit,
    offset
  });
}
