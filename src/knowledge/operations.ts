import type { AuditDecision, IngestionJobStatus } from "../db/rows";
import type { AuditRepository, AuditEventWithActorRow } from "../repositories/audit.repository";
import type { IngestionJobWithDocumentRow, IngestionRepository } from "../repositories/ingestion.repository";
import type { AuditEventDTO, IngestionJobDTO } from "./dto";

export interface ListIngestionJobsFilter {
  status?: IngestionJobStatus;
}

export interface ListAuditEventsFilter {
  actorAgentId?: string;
  action?: string;
  decision?: AuditDecision;
  limit: number;
  offset: number;
}

function toIngestionJobDTO(row: IngestionJobWithDocumentRow): IngestionJobDTO {
  return {
    id: row.id,
    documentId: row.document_id,
    documentTitle: row.document_title,
    documentSlug: row.document_slug,
    // Same derivation the documents API uses: a document with a deletion time
    // is `trashed` to anyone reading it, whatever the row's status column says.
    documentStatus: row.document_status === null ? null : row.document_trashed_at !== null ? "trashed" : row.document_status,
    jobType: row.job_type,
    status: row.status,
    attempts: row.attempt_count,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * `actor_identity_raw`, `old_value_json` and `new_value_json` are the three
 * columns this mapping exists for. The first never leaves the database; the
 * other two are handed over parsed, because a client that has to JSON.parse a
 * string out of a JSON response is a client that will eventually forget to.
 */
function toAuditEventDTO(row: AuditEventWithActorRow): AuditEventDTO {
  return {
    id: row.id,
    requestId: row.request_id,
    occurredAt: row.occurred_at,
    actorAgentId: row.actor_agent_id,
    actorAgentKey: row.actor_agent_key,
    action: row.action,
    decision: row.decision,
    reason: row.reason,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    oldValue: parseRecordedValue(row.old_value_json),
    newValue: parseRecordedValue(row.new_value_json),
    status: row.status
  };
}

/**
 * A malformed value column must not take the whole listing down with it. The
 * audit trail is the view an operator reaches for when something has already
 * gone wrong, so it degrades to "this row's recorded value is unreadable"
 * rather than failing the request.
 */
function parseRecordedValue(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return { unparseable: true };
  }
}

/**
 * The two administrative read surfaces the console is built on: what the
 * ingestion pipeline is doing, and what Athenaeum decided.
 *
 * They live behind a service for the same reason every other read does. Both
 * routes used to return the D1 row itself, which meant the response shape was
 * whatever the schema happened to be that week -- snake_case where the rest of
 * the API is camelCase, an internal forensic column in every response, and the
 * console silently rendering `undefined` for every field it asked for by the
 * name the API uses everywhere else.
 *
 * Authorization is not performed here: both callers reach this through
 * `runAuthenticatedOperation` with `admin.ingestion` / `audit.read` enforced
 * before the handler runs. This layer decides only what a permitted reader is
 * shown.
 */
export class OperationsService {
  constructor(
    private readonly ingestionRepo: IngestionRepository,
    private readonly auditRepo: AuditRepository
  ) {}

  async listIngestionJobs(filter: ListIngestionJobsFilter, limit: number, offset: number): Promise<IngestionJobDTO[]> {
    const rows = await this.ingestionRepo.listWithDocument(filter.status, limit, offset);
    return rows.map(toIngestionJobDTO);
  }

  async listAuditEvents(filter: ListAuditEventsFilter): Promise<AuditEventDTO[]> {
    const rows = await this.auditRepo.list(filter);
    return rows.map(toAuditEventDTO);
  }
}
