/** D1 row shapes, matching migrations/0001_init.sql column-for-column. */
import type { Classification } from "../security/classification";

export type AgentEnvironment = "development" | "staging" | "production";
export type AgentStatus = "active" | "disabled" | "revoked";
export type AuthMode = "access" | "rpc" | "account";

export type PrincipalType = "USER" | "APPLICATION" | "SERVICE" | "AI_AGENT";

export interface AgentRow {
  id: string;
  agent_key: string;
  name: string;
  description: string | null;
  environment: AgentEnvironment;
  status: AgentStatus;
  auth_mode: AuthMode;
  rpc_key_hash: string | null;
  principal_type: PrincipalType;
  /** Xfeatures Account oauth_applications.client_id, for APPLICATION/AI_AGENT principals. */
  account_client_id: string | null;
  /** Xfeatures Account users.id, for USER principals. */
  account_user_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface PermissionRow {
  id: string;
  key: string;
  description: string | null;
  created_at: string;
}

export type FactStatus = "active" | "deprecated";

export interface FactRow {
  id: string;
  namespace: string;
  key: string;
  version: number;
  value_json: string;
  title: string | null;
  description: string | null;
  classification: Classification;
  status: FactStatus;
  source_id: string | null;
  valid_from: string | null;
  valid_until: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

/**
 * What the database stores. A trashed document is `archived` with a
 * `trashed_at` -- see migration 0003 for why that is two columns rather than a
 * sixth status. Callers see `trashed`; see DocumentStatusView.
 */
export type DocumentStatus = "draft" | "pending_review" | "active" | "deprecated" | "archived";

/**
 * What the API reports. `trashed` is derived from `trashed_at` rather than
 * stored, so nothing can be in the trash without a deletion time attached.
 */
export type DocumentStatusView = DocumentStatus | "trashed";

export interface DocumentRow {
  id: string;
  slug: string;
  title: string;
  r2_key: string;
  domain: string;
  category: string | null;
  classification: Classification;
  language: string;
  status: DocumentStatus;
  version: number;
  content_hash: string;
  source_type: string | null;
  source_reference: string | null;
  valid_from: string | null;
  valid_until: string | null;
  /** ISO timestamp the document entered the trash; NULL unless `status` is `trashed`. */
  trashed_at: string | null;
  /** The state a restore returns it to. Recorded when trashed, because it cannot be inferred later. */
  status_before_trash: DocumentStatus | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface DocumentVersionRow {
  id: string;
  document_id: string;
  version: number;
  r2_key: string;
  title: string;
  classification: Classification;
  language: string;
  status: DocumentStatus;
  content_hash: string;
  change_note: string | null;
  created_at: string;
  created_by: string | null;
}

export type CatalogStatus = "active" | "deprecated" | "retired";

export interface ProductRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: string | null;
  region: string | null;
  status: CatalogStatus;
  classification: Classification;
  metadata_json: string | null;
  version: number;
  valid_from: string | null;
  valid_until: string | null;
  source_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface PlanRow {
  id: string;
  code: string;
  product_id: string | null;
  name: string;
  description: string | null;
  price_amount: number | null;
  price_currency: string | null;
  billing_period: string | null;
  sla_json: string | null;
  limits_json: string | null;
  status: CatalogStatus;
  classification: Classification;
  version: number;
  valid_from: string | null;
  valid_until: string | null;
  source_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export type ServiceStatus = "operational" | "degraded" | "maintenance" | "offline";
export type ServiceType = "service" | "node" | "region";

export interface ServiceRow {
  id: string;
  code: string;
  service_type: ServiceType;
  name: string;
  description: string | null;
  region: string | null;
  status: ServiceStatus;
  sla_json: string | null;
  metadata_json: string | null;
  classification: Classification;
  version: number;
  valid_from: string | null;
  valid_until: string | null;
  source_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface PolicyRow {
  id: string;
  code: string;
  title: string;
  body_markdown: string | null;
  document_id: string | null;
  classification: Classification;
  status: DocumentStatus;
  version: number;
  valid_from: string | null;
  valid_until: string | null;
  source_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export type AuditDecision = "ALLOW" | "DENY" | "N/A";

export interface AuditEventRow {
  id: string;
  request_id: string;
  occurred_at: string;
  actor_agent_id: string | null;
  actor_identity_raw: string | null;
  action: string;
  decision: AuditDecision;
  reason: string | null;
  resource_type: string | null;
  resource_id: string | null;
  old_value_json: string | null;
  new_value_json: string | null;
  status: "success" | "error";
}

export type FeedbackType = "incorrect" | "outdated" | "missing" | "irrelevant" | "conflicting";
export type FeedbackStatus = "open" | "reviewed" | "resolved" | "dismissed";

export interface KnowledgeFeedbackRow {
  id: string;
  source_id: string;
  source_type: string | null;
  feedback_type: FeedbackType;
  message: string | null;
  submitted_by_agent_id: string;
  status: FeedbackStatus;
  created_at: string;
  updated_at: string;
}

export type IngestionJobType = "index" | "reindex" | "delete";
export type IngestionJobStatus = "queued" | "processing" | "completed" | "failed";

export interface IngestionJobRow {
  id: string;
  document_id: string | null;
  job_type: IngestionJobType;
  status: IngestionJobStatus;
  attempt_count: number;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
}

export type QuotaKind = "searches" | "writes" | "uploads";

export interface AgentQuotaRow {
  agent_id: string;
  max_searches_per_day: number | null;
  max_writes_per_day: number | null;
  max_uploads_per_day: number | null;
  updated_at: string;
  updated_by: string | null;
}

export interface AgentUsageDailyRow {
  agent_id: string;
  usage_date: string;
  searches: number;
  reads: number;
  writes: number;
  uploads: number;
}

export interface KnowledgeSourceRow {
  id: string;
  name: string;
  source_type: "manual" | "import" | "api";
  authority: "official" | "internal_verified" | "imported" | "external" | "unverified";
  reference: string | null;
  created_at: string;
  updated_at: string;
}
