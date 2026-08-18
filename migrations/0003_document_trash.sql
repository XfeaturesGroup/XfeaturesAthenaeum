-- Recoverable deletion for documents.
--
-- Before this, a document could be archived but never removed: `archived` is
-- terminal, and nothing deleted content. That left two bad options for anyone
-- who published something they should not have -- leave it archived forever, or
-- reach into R2 and D1 by hand. The second is worse than it looks: deleting an
-- R2 object out from under AI Search leaves the engine holding vectors whose
-- canonical record is gone.
--
-- Two columns rather than a new `status` value, deliberately.
--
-- Adding 'trashed' to the status CHECK would mean rebuilding this table, and
-- rebuilding it means DROP TABLE. D1 does not honour `PRAGMA foreign_keys=OFF`
-- inside a migration, so the drop enforces foreign keys -- and
-- `document_versions.document_id` is ON DELETE CASCADE. The rebuild would take
-- every document's version history with it. A CHECK constraint is not worth
-- risking the history that makes rollback possible.
--
-- So a trashed document is `archived` plus a deletion time. That is not a
-- workaround dressed up as a design: `archived` is already the terminal state
-- that no read path returns, so a trashed document stops being retrievable
-- through search, REST and MCP the moment it is set, with no new filter to
-- remember anywhere. `trashed_at` says it is also on its way out, and
-- `status_before_trash` says where a restore puts it back.
--
-- The API reports these documents as `trashed`; the database stores what is
-- true of them -- archived, and scheduled for deletion at a known time.

ALTER TABLE documents ADD COLUMN trashed_at TEXT;
ALTER TABLE documents ADD COLUMN status_before_trash TEXT;

-- The purge job asks exactly one question on a schedule: which trashed
-- documents are past their window. Partial, so it indexes only the handful of
-- rows that are actually in the trash rather than every document ever written.
CREATE INDEX idx_documents_trashed_at ON documents(trashed_at) WHERE trashed_at IS NOT NULL;
