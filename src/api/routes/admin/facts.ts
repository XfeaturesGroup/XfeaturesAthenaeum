import { authenticateHttpRequest } from "../../../auth/authenticate";
import { runAuthenticatedOperation } from "../../../auth/pipeline";
import { assertCanAccessFact, assertCanReclassifyFact } from "../../../auth/resource-guard";
import { auditChange } from "../../../audit/audit";
import { StaleVersionError } from "../../../db/errors";
import { enforceRateLimit } from "../../../security/rate-limit";
import { enforceQuota } from "../../../security/quota";
import { ApiError, ErrorCode, jsonResponse } from "../../../utils/responses";
import { readJsonBody } from "../../http";
import { createFactRequestSchema, rollbackRequestSchema, updateFactRequestSchema } from "../../schemas/admin";
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
      return created;
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
      return updated;
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
