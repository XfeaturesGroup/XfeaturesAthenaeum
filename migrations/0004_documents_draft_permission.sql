-- Split "propose a document" out of "rewrite a document" (SR-025).
--
-- `content-contributor` is the role an AI agent gets in order to propose
-- knowledge over MCP, where exactly two write tools exist: draft a document,
-- submit that draft for human review. The role, however, held
-- `documents.write` + `admin.documents` + `documents.read.*` -- and a role
-- belongs to a credential, not to a transport. The same Account token sent to
-- REST or through the published SDK could rewrite the content of every
-- INTERNAL document in every domain, enumerate the whole corpus including
-- drafts, and open any draft's full text. The MCP tool list was doing the work
-- of an access-control decision, which is not something a tool list can do.
--
-- So `documents.write` now means what its description always implied -- revise
-- something that already exists -- and a new `documents.draft` covers bringing
-- new content in. Every role that may revise also holds the narrower one, so
-- nothing that could draft before loses the ability.
--
-- Data-only: no table is rebuilt and no constraint changes, so none of the
-- cascade hazards that shaped migration 0003 apply here.

-- 1. The new permission. Keyed on `key`, so a database whose ids differ from
--    the seed (an early environment, a hand-repaired row) still converges.
INSERT OR IGNORE INTO permissions (id, key, description)
VALUES ('perm_documents_draft', 'documents.draft', 'File a NEW document as a draft and submit it for human review');

-- 2. Narrow what `documents.write` claims to be, so the taxonomy reads the way
--    it now behaves.
UPDATE permissions
   SET description = 'Revise an existing document (add a version, roll back)'
 WHERE key = 'documents.write';

-- 3. Every role that could draft before must still be able to. That is any
--    role holding `documents.write` today -- which is `knowledge-admin` and
--    `content-contributor` in the shipped taxonomy, and whatever else an
--    operator has since created.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, (SELECT id FROM permissions WHERE key = 'documents.draft')
  FROM role_permissions rp
  JOIN permissions p ON p.id = rp.permission_id
 WHERE p.key = 'documents.write';

-- 4. Withdraw from `content-contributor` the two permissions that made it a
--    corpus-wide editor. Scoped to that one role by name: no other role's
--    grants are touched, and an operator-defined role that deliberately holds
--    both keeps them.
DELETE FROM role_permissions
 WHERE role_id = (SELECT id FROM roles WHERE name = 'content-contributor')
   AND permission_id IN (SELECT id FROM permissions WHERE key IN ('documents.write', 'admin.documents'));

-- 5. The role description promised draft-only behaviour before the permissions
--    delivered it. Now they agree.
UPDATE roles
   SET description = 'Proposes documents and submits them for human review. Cannot revise existing documents, cannot publish or approve -- for AI agents proposing knowledge updates over MCP.'
 WHERE name = 'content-contributor';
