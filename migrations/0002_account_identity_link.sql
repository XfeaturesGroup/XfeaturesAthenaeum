-- Links Athenaeum principals to Xfeatures Account identities (ADR 0001).
--
-- Athenaeum remains the authority for WHAT a principal may see; Xfeatures
-- Account is the authority for WHO the principal is. These columns are the
-- join between the two, and are the ONLY way an Account identity is resolved
-- to an Athenaeum permission set -- never a client-supplied id.
--
-- `auth_mode` gains 'account' alongside the existing 'access' (Cloudflare
-- Access service token) and 'rpc' (internal Worker credential). SQLite cannot
-- alter a CHECK constraint in place, so the agents table is rebuilt.

PRAGMA foreign_keys = OFF;

CREATE TABLE agents_new (
  id TEXT PRIMARY KEY,
  agent_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  environment TEXT NOT NULL CHECK (environment IN ('development','staging','production')),
  status TEXT NOT NULL CHECK (status IN ('active','disabled','revoked')) DEFAULT 'active',
  auth_mode TEXT NOT NULL CHECK (auth_mode IN ('access','rpc','account')),
  rpc_key_hash TEXT,

  -- Conceptual principal type (ADR 0001 §5). AI_AGENT is an APPLICATION that
  -- happens to be model-driven; it is not a separate Account entity.
  principal_type TEXT NOT NULL CHECK (principal_type IN ('USER','APPLICATION','SERVICE','AI_AGENT')) DEFAULT 'SERVICE',

  -- Xfeatures Account oauth_applications.client_id (e.g. 'xf_ab12...').
  -- Set for APPLICATION / AI_AGENT principals.
  account_client_id TEXT UNIQUE,
  -- Xfeatures Account users.id. Set for USER principals (HQ staff).
  account_user_id TEXT UNIQUE,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT,
  updated_by TEXT,

  -- An 'account' principal is only resolvable if it carries exactly one
  -- Account identity; an 'rpc' principal must carry a key hash. Enforced in
  -- the schema so a half-configured row cannot authenticate.
  CHECK (
    (auth_mode = 'account' AND ((account_client_id IS NOT NULL) <> (account_user_id IS NOT NULL)))
    OR (auth_mode = 'rpc' AND rpc_key_hash IS NOT NULL)
    OR (auth_mode = 'access')
  )
);

INSERT INTO agents_new (id, agent_key, name, description, environment, status, auth_mode, rpc_key_hash, principal_type, created_at, updated_at, created_by, updated_by)
SELECT id, agent_key, name, description, environment, status, auth_mode, rpc_key_hash,
       CASE WHEN auth_mode = 'rpc' THEN 'SERVICE' ELSE 'APPLICATION' END,
       created_at, updated_at, created_by, updated_by
FROM agents;

DROP TABLE agents;
ALTER TABLE agents_new RENAME TO agents;

CREATE INDEX idx_agents_status ON agents(status);
CREATE INDEX idx_agents_account_client ON agents(account_client_id);
CREATE INDEX idx_agents_account_user ON agents(account_user_id);

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Per-application usage accounting and quotas.
-- Counters are coarse (per agent, per UTC day) so accounting costs one upsert
-- per request class rather than a row per request.
-- ---------------------------------------------------------------------------

CREATE TABLE agent_usage_daily (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  usage_date TEXT NOT NULL,
  searches INTEGER NOT NULL DEFAULT 0,
  reads INTEGER NOT NULL DEFAULT 0,
  writes INTEGER NOT NULL DEFAULT 0,
  uploads INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, usage_date)
);

CREATE TABLE agent_quotas (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  max_searches_per_day INTEGER,
  max_writes_per_day INTEGER,
  max_uploads_per_day INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT
);

-- ---------------------------------------------------------------------------
-- Index synchronisation state. Distinguishes "canonical storage
-- updated" from "actually searchable" so HQ never reports a document as
-- published-and-searchable when indexing failed.
-- ---------------------------------------------------------------------------

ALTER TABLE documents ADD COLUMN index_state TEXT NOT NULL
  CHECK (index_state IN ('not_indexed','sync_requested','sync_running','indexed','sync_failed'))
  DEFAULT 'not_indexed';

ALTER TABLE documents ADD COLUMN index_synced_at TEXT;
ALTER TABLE documents ADD COLUMN index_error_code TEXT;

CREATE INDEX idx_documents_index_state ON documents(index_state);
