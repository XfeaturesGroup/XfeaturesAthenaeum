-- Xfeatures Athenaeum initial schema.
--
-- Versioning design note: `facts` and `documents` get dedicated *_versions
-- history tables because they are the two content types the spec calls out
-- for point-in-time rollback/audit ("никогда не перезаписывать документ без
-- истории"). `products`/`plans`/`services`/`policies` are simpler catalog
-- rows that bump an integer `version` column in place; their change history
-- lives in `audit_events.old_value_json`/`new_value_json` instead of a
-- parallel *_versions table per entity, which would be four near-identical
-- tables for a need audit_events already covers.
--
-- Every classification column is constrained to the four-tier model and
-- every table that participates in retrieval carries one directly, so
-- authorization filtering never has to join out to find it.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Identity & access control
-- ---------------------------------------------------------------------------

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  agent_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  environment TEXT NOT NULL CHECK (environment IN ('development','staging','production')),
  status TEXT NOT NULL CHECK (status IN ('active','disabled','revoked')) DEFAULT 'active',
  auth_mode TEXT NOT NULL CHECK (auth_mode IN ('access','rpc')),
  rpc_key_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT,
  updated_by TEXT
);

CREATE INDEX idx_agents_status ON agents(status);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE permissions (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE agent_roles (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (agent_id, role_id)
);

CREATE TABLE role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (role_id, permission_id)
);

CREATE INDEX idx_agent_roles_role ON agent_roles(role_id);
CREATE INDEX idx_role_permissions_permission ON role_permissions(permission_id);

-- ---------------------------------------------------------------------------
-- Knowledge sources (provenance / authority metadata)
-- ---------------------------------------------------------------------------

CREATE TABLE knowledge_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('manual','import','api')),
  authority TEXT NOT NULL CHECK (authority IN ('official','internal_verified','imported','external','unverified')),
  reference TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- Facts (deterministic, versioned)
-- ---------------------------------------------------------------------------

CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  value_json TEXT NOT NULL,
  title TEXT,
  description TEXT,
  classification TEXT NOT NULL CHECK (classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  status TEXT NOT NULL CHECK (status IN ('active','deprecated')) DEFAULT 'active',
  source_id TEXT REFERENCES knowledge_sources(id),
  valid_from TEXT,
  valid_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT,
  updated_by TEXT,
  UNIQUE (namespace, key)
);

CREATE INDEX idx_facts_classification ON facts(classification);
CREATE INDEX idx_facts_status ON facts(status);

CREATE TABLE fact_versions (
  id TEXT PRIMARY KEY,
  fact_namespace TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  value_json TEXT NOT NULL,
  title TEXT,
  description TEXT,
  classification TEXT NOT NULL CHECK (classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  status TEXT NOT NULL CHECK (status IN ('active','deprecated')),
  source_id TEXT REFERENCES knowledge_sources(id),
  valid_from TEXT,
  valid_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT,
  UNIQUE (fact_namespace, fact_key, version)
);

-- ---------------------------------------------------------------------------
-- Documents (canonical content lives in R2; this is metadata + version log)
-- ---------------------------------------------------------------------------

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  domain TEXT NOT NULL,
  category TEXT,
  classification TEXT NOT NULL CHECK (classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  language TEXT NOT NULL DEFAULT 'en',
  status TEXT NOT NULL CHECK (status IN ('draft','pending_review','active','deprecated','archived')) DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT NOT NULL,
  source_type TEXT,
  source_reference TEXT,
  valid_from TEXT,
  valid_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT,
  updated_by TEXT
);

CREATE INDEX idx_documents_status_domain ON documents(status, domain);
CREATE INDEX idx_documents_classification ON documents(classification);
CREATE INDEX idx_documents_content_hash ON documents(content_hash);

CREATE TABLE document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  title TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  language TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','pending_review','active','deprecated','archived')),
  content_hash TEXT NOT NULL,
  change_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT,
  UNIQUE (document_id, version)
);

CREATE INDEX idx_document_versions_document ON document_versions(document_id);

-- ---------------------------------------------------------------------------
-- Catalog: products / plans / services
-- ---------------------------------------------------------------------------

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  region TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','deprecated','retired')) DEFAULT 'active',
  classification TEXT NOT NULL CHECK (classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  metadata_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT,
  valid_until TEXT,
  source_id TEXT REFERENCES knowledge_sources(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT,
  updated_by TEXT
);

CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_products_classification ON products(classification);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  product_id TEXT REFERENCES products(id),
  name TEXT NOT NULL,
  description TEXT,
  price_amount INTEGER,
  price_currency TEXT,
  billing_period TEXT,
  sla_json TEXT,
  limits_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','deprecated','retired')) DEFAULT 'active',
  classification TEXT NOT NULL CHECK (classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  version INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT,
  valid_until TEXT,
  source_id TEXT REFERENCES knowledge_sources(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT,
  updated_by TEXT
);

CREATE INDEX idx_plans_product ON plans(product_id);
CREATE INDEX idx_plans_status ON plans(status);
CREATE INDEX idx_plans_classification ON plans(classification);

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  service_type TEXT NOT NULL CHECK (service_type IN ('service','node','region')),
  name TEXT NOT NULL,
  description TEXT,
  region TEXT,
  status TEXT NOT NULL CHECK (status IN ('operational','degraded','maintenance','offline')) DEFAULT 'operational',
  sla_json TEXT,
  metadata_json TEXT,
  classification TEXT NOT NULL CHECK (classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  version INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT,
  valid_until TEXT,
  source_id TEXT REFERENCES knowledge_sources(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT,
  updated_by TEXT
);

CREATE INDEX idx_services_type_status ON services(service_type, status);
CREATE INDEX idx_services_classification ON services(classification);

-- ---------------------------------------------------------------------------
-- Policies (short policies inline; long-form ones point at a document)
-- ---------------------------------------------------------------------------

CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body_markdown TEXT,
  document_id TEXT REFERENCES documents(id),
  classification TEXT NOT NULL CHECK (classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  status TEXT NOT NULL CHECK (status IN ('draft','pending_review','active','deprecated','archived')) DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT,
  valid_until TEXT,
  source_id TEXT REFERENCES knowledge_sources(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT,
  updated_by TEXT,
  CHECK (body_markdown IS NOT NULL OR document_id IS NOT NULL)
);

CREATE INDEX idx_policies_status ON policies(status);
CREATE INDEX idx_policies_classification ON policies(classification);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor_agent_id TEXT REFERENCES agents(id),
  actor_identity_raw TEXT,
  action TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('ALLOW','DENY','N/A')),
  reason TEXT,
  resource_type TEXT,
  resource_id TEXT,
  old_value_json TEXT,
  new_value_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('success','error')) DEFAULT 'success'
);

CREATE INDEX idx_audit_events_occurred_at ON audit_events(occurred_at);
CREATE INDEX idx_audit_events_actor ON audit_events(actor_agent_id, occurred_at);
CREATE INDEX idx_audit_events_action ON audit_events(action);
CREATE INDEX idx_audit_events_request ON audit_events(request_id);

-- ---------------------------------------------------------------------------
-- Feedback
-- ---------------------------------------------------------------------------

CREATE TABLE knowledge_feedback (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_type TEXT,
  feedback_type TEXT NOT NULL CHECK (feedback_type IN ('incorrect','outdated','missing','irrelevant','conflicting')),
  message TEXT,
  submitted_by_agent_id TEXT NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL CHECK (status IN ('open','reviewed','resolved','dismissed')) DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_knowledge_feedback_status ON knowledge_feedback(status);

-- ---------------------------------------------------------------------------
-- Ingestion jobs
-- ---------------------------------------------------------------------------

CREATE TABLE ingestion_jobs (
  id TEXT PRIMARY KEY,
  document_id TEXT REFERENCES documents(id),
  job_type TEXT NOT NULL CHECK (job_type IN ('index','reindex','delete')),
  status TEXT NOT NULL CHECK (status IN ('queued','processing','completed','failed')) DEFAULT 'queued',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_ingestion_jobs_status ON ingestion_jobs(status);
CREATE INDEX idx_ingestion_jobs_document ON ingestion_jobs(document_id);
