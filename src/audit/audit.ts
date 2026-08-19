import type { Env } from "../env";
import type { Principal } from "../auth/types";
import { AuditRepository } from "../repositories/audit.repository";
import { log } from "../utils/logging";

export interface ResourceRef {
  type: string;
  id: string;
}

interface BaseAuditFields {
  env: Env;
  requestId: string;
  action: string;
  resource?: ResourceRef;
}

async function safeRecord(env: Env, fields: Parameters<AuditRepository["record"]>[0]): Promise<void> {
  try {
    await new AuditRepository(env.DB).record(fields);
  } catch {
    // Audit logging must never take down the request it's describing --
    // but its failure is itself worth knowing about.
    log.error("audit_write_failed", { request_id: fields.requestId, action: fields.action });
  }
}

export async function auditAllow(fields: BaseAuditFields & { principal: Principal }): Promise<void> {
  await safeRecord(fields.env, {
    requestId: fields.requestId,
    actorAgentId: fields.principal.agentId,
    action: fields.action,
    decision: "ALLOW",
    resourceType: fields.resource?.type ?? null,
    resourceId: fields.resource?.id ?? null,
    status: "success"
  });
}

export async function auditDeny(
  fields: BaseAuditFields & { principal: Principal | null; reason: string; actorIdentityRaw?: string }
): Promise<void> {
  await safeRecord(fields.env, {
    requestId: fields.requestId,
    actorAgentId: fields.principal?.agentId ?? null,
    actorIdentityRaw: fields.actorIdentityRaw ?? null,
    action: fields.action,
    decision: "DENY",
    reason: fields.reason,
    resourceType: fields.resource?.type ?? null,
    resourceId: fields.resource?.id ?? null,
    status: "success"
  });
}

export async function auditError(fields: BaseAuditFields & { principal: Principal | null; reason: string }): Promise<void> {
  await safeRecord(fields.env, {
    requestId: fields.requestId,
    actorAgentId: fields.principal?.agentId ?? null,
    action: fields.action,
    decision: "N/A",
    reason: fields.reason,
    resourceType: fields.resource?.type ?? null,
    resourceId: fields.resource?.id ?? null,
    status: "error"
  });
}

export async function auditChange(
  fields: BaseAuditFields & {
    principal: Principal;
    resource: ResourceRef;
    oldValue?: Record<string, unknown> | null;
    newValue?: Record<string, unknown> | null;
  }
): Promise<void> {
  await safeRecord(fields.env, {
    requestId: fields.requestId,
    actorAgentId: fields.principal.agentId,
    action: fields.action,
    decision: "ALLOW",
    resourceType: fields.resource.type,
    resourceId: fields.resource.id,
    oldValue: fields.oldValue ?? null,
    newValue: fields.newValue ?? null,
    status: "success"
  });
}
