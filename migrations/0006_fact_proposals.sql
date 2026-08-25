-- Let an agent propose a fact, and only propose it.
--
-- An agent could already propose a document and hand it to a human reviewer.
-- It could not do the same for a fact, so the only way an agent's correction to
-- a price or an SLA reached the knowledge base was for someone to hold
-- `admin.facts` and write it directly. That is a strange gap: facts are the
-- half of this knowledge base where being wrong is least survivable, precisely
-- because they are answered verbatim rather than paraphrased.
--
-- A proposal is NOT a fact in a draft state, and that is the whole design.
--
-- A `proposed` value in `facts.status` would mean rebuilding the table to widen
-- its CHECK constraint, which D1 makes hazardous (see 0003 and 0005). But even
-- if it were free, it would be the wrong shape: every read path in this service
-- filters facts by status, and a proposal that lives one forgotten WHERE clause
-- away from being served as knowledge is a proposal that will eventually be
-- served as knowledge. In its own table it cannot be, whatever anyone forgets.
--
-- A proposal names a target fact rather than pointing at one by id: the fact may
-- not exist yet (that is the "new fact" case), and if it does it may change or
-- be deleted before anyone reviews the proposal. Approval resolves the target at
-- review time, under the REVIEWER's authority -- never the proposer's.

CREATE TABLE fact_proposals (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  title TEXT,
  description TEXT,
  classification TEXT NOT NULL CHECK (classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  -- Why this change is being proposed, in the proposer's words. A reviewer
  -- approving a number they cannot verify is the failure mode this exists to
  -- reduce.
  rationale TEXT,
  -- The version the proposer believed was current, when proposing a change to
  -- an existing fact. NULL means "this fact does not exist yet". Checked at
  -- approval: if the fact has moved on since, the proposal is stale and is
  -- refused rather than silently overwriting the newer value.
  based_on_version INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')) DEFAULT 'pending',
  proposed_by TEXT NOT NULL REFERENCES agents(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reviewed_by TEXT REFERENCES agents(id),
  reviewed_at TEXT,
  review_note TEXT,
  -- The fact version this proposal produced, once approved. Nothing reads it to
  -- make a decision; it is how the trail connects a proposal to its outcome.
  resulting_version INTEGER
);

-- The review queue asks one question: what is still pending, oldest first.
CREATE INDEX idx_fact_proposals_status ON fact_proposals(status, created_at);
-- And an operator looking at a fact asks: has anyone proposed a change to this?
CREATE INDEX idx_fact_proposals_target ON fact_proposals(namespace, key);

-- The permission, deliberately narrow. `facts.write` is the power to change what
-- the platform answers; this is the power to ask a human to. SR-025 is the
-- precedent: a role belongs to a credential, not to a transport, so an agent
-- given the ability to propose over MCP must not thereby gain the ability to
-- write over REST with the same token.
INSERT OR IGNORE INTO permissions (id, key, description)
VALUES ('perm_facts_propose', 'facts.propose', 'Propose a fact for human review. Cannot write, publish or approve one.');

-- Anything that may already write facts may obviously also propose them, so no
-- reviewer has to hold two permissions to do one job.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, (SELECT id FROM permissions WHERE key = 'facts.propose')
  FROM role_permissions rp
  JOIN permissions p ON p.id = rp.permission_id
 WHERE p.key = 'facts.write';

-- And the role that exists to propose knowledge over MCP gets it too. It holds
-- no fact permission at all today, which is exactly why it could not correct a
-- wrong price without a human doing the typing.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r, permissions p
 WHERE r.name = 'content-contributor' AND p.key = 'facts.propose';

UPDATE roles
   SET description = 'Proposes documents and facts and submits them for human review. Cannot revise existing documents, cannot write facts, cannot publish or approve -- for AI agents proposing knowledge updates over MCP.'
 WHERE name = 'content-contributor';
