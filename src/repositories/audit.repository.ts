import type { AuditDecision, AuditEventRow } from "../db/rows";
import { generateId } from "../utils/ids";
import { nowIso } from "../utils/time";

export interface RecordAuditEventInput {
  requestId: string;
  actorAgentId?: string | null;
  actorIdentityRaw?: string | null;
  action: string;
  decision: AuditDecision;
  reason?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  /** Whitelisted, non-secret fields only -- never a raw payload dump. */
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  status?: "success" | "error";
}

export interface ListAuditEventsOptions {
  actorAgentId?: string;
  action?: string;
  limit: number;
  offset: number;
}

export class AuditRepository {
  constructor(private readonly db: D1Database) {}

  async record(input: RecordAuditEventInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO audit_events
           (id, request_id, occurred_at, actor_agent_id, actor_identity_raw, action, decision, reason, resource_type, resource_id, old_value_json, new_value_json, status)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`
      )
      .bind(
        generateId(),
        input.requestId,
        nowIso(),
        input.actorAgentId ?? null,
        input.actorIdentityRaw ?? null,
        input.action,
        input.decision,
        input.reason ?? null,
        input.resourceType ?? null,
        input.resourceId ?? null,
        input.oldValue ? JSON.stringify(input.oldValue) : null,
        input.newValue ? JSON.stringify(input.newValue) : null,
        input.status ?? "success"
      )
      .run();
  }

  async list(options: ListAuditEventsOptions): Promise<AuditEventRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (options.actorAgentId) {
      conditions.push(`actor_agent_id = ?${params.length + 1}`);
      params.push(options.actorAgentId);
    }
    if (options.action) {
      conditions.push(`action = ?${params.length + 1}`);
      params.push(options.action);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(options.limit, options.offset);
    const { results } = await this.db
      .prepare(
        `SELECT * FROM audit_events ${where} ORDER BY occurred_at DESC LIMIT ?${params.length - 1} OFFSET ?${params.length}`
      )
      .bind(...params)
      .all<AuditEventRow>();
    return results;
  }
}
