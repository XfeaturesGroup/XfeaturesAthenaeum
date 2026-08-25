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
  decision?: AuditDecision;
  limit: number;
  offset: number;
}

/** An audit event with the actor's key resolved; NULL once the principal itself is gone. */
export interface AuditEventWithActorRow extends AuditEventRow {
  actor_agent_key: string | null;
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

  /**
   * A page of the trail, with the actor's key resolved.
   *
   * The join is LEFT and the filters are applied in SQL rather than by the
   * caller: an operator looking for refusals should not have to pull an
   * unfiltered page and hope the one they need is on it.
   */
  async list(options: ListAuditEventsOptions): Promise<AuditEventWithActorRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (options.actorAgentId) {
      conditions.push(`event.actor_agent_id = ?${params.length + 1}`);
      params.push(options.actorAgentId);
    }
    if (options.action) {
      conditions.push(`event.action = ?${params.length + 1}`);
      params.push(options.action);
    }
    if (options.decision) {
      conditions.push(`event.decision = ?${params.length + 1}`);
      params.push(options.decision);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(options.limit, options.offset);
    const { results } = await this.db
      .prepare(
        `SELECT event.*, actor.agent_key AS actor_agent_key
           FROM audit_events event
           LEFT JOIN agents actor ON actor.id = event.actor_agent_id
           ${where}
          ORDER BY event.occurred_at DESC
          LIMIT ?${params.length - 1} OFFSET ?${params.length}`
      )
      .bind(...params)
      .all<AuditEventWithActorRow>();
    return results;
  }
}
