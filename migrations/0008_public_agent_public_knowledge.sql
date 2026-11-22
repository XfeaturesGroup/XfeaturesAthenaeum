-- Let `public-agent` read the PUBLIC knowledge a customer-facing bot is
-- actually asked about.
--
-- The role could read facts in exactly one namespace (`products`) and
-- documents in one domain (`public`). Everything a customer asks a support
-- bot -- what the Acceptable Use Policy forbids, what a plan costs, what the
-- SLA promises, how refunds work, what the game-hosting nodes are -- lives in
-- `policies`, `plans`, `services` and `network` facts and in `legal`
-- documents, so a public chatbot answered "nothing found" for all of it while
-- the same knowledge was published and PUBLIC.
--
-- What does NOT change: the role still holds only
-- `knowledge.classification.PUBLIC`. Classification is checked on every row
-- in addition to the namespace/domain grant, so the INTERNAL and CONFIDENTIAL
-- facts that share these namespaces (node topology, admin access, secrets
-- policy, HQ authentication) stay invisible to it. No admin, write, network.*
-- or audit permission is added.
--
-- Data-only and idempotent: keyed on `key` / `name` so a database whose ids
-- differ from the seed still converges, and safe to re-run.

-- 1. `network` is a fact namespace in use, but had no read permission of its
--    own -- only `facts.read.*` could reach it.
INSERT OR IGNORE INTO permissions (id, key, description)
VALUES ('perm_facts_read_network', 'facts.read.network', 'Read facts in the network namespace');

-- 2. Widen public-agent to the PUBLIC knowledge customers ask about.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p
    ON p.key IN (
      'facts.read.plans',
      'facts.read.policies',
      'facts.read.services',
      'facts.read.network',
      'prices.read',
      'documents.read.legal'
    )
 WHERE r.name = 'public-agent';
