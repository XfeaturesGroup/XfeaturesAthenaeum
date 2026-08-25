-- Recoverable deletion for facts, on exactly the model migration 0003 gave
-- documents.
--
-- Until now the only way to remove a fact was to deprecate it, which leaves the
-- row and every historical version in place forever. That is the right default
-- for a superseded price -- history is what makes a rollback possible -- but it
-- is the wrong answer for a fact that should never have been filed: an internal
-- contact, a customer's details pasted into a value, a credential typed into
-- the wrong field. Deprecating those hides them from readers and keeps them in
-- the database indefinitely.
--
-- Two columns rather than a new `status` value, for the same reason as 0003 and
-- with the same hazard in mind. Adding 'trashed' to the status CHECK means
-- rebuilding the table, and D1 does not honour `PRAGMA foreign_keys = OFF`
-- inside a migration -- a rebuild enforces foreign keys, and that recipe has
-- already cost this project a rejected production migration. A CHECK constraint
-- is not worth risking fact history for.
--
-- So a trashed fact is `deprecated` plus a deletion time. That is not a
-- workaround dressed as a design: `deprecated` is already the state no read
-- path returns (SR-008 made sure of it), so a trashed fact stops being
-- answerable through REST, RPC and MCP the moment it is set, with no new filter
-- to remember at any call site. `trashed_at` says it is also on its way out,
-- and `status_before_trash` says what a restore puts it back to -- recorded
-- when it is trashed, because it cannot be inferred afterwards.
--
-- The API reports these facts as trashed; the database stores what is true of
-- them -- deprecated, and scheduled for deletion at a known time.

ALTER TABLE facts ADD COLUMN trashed_at TEXT;
ALTER TABLE facts ADD COLUMN status_before_trash TEXT;

-- The purge job asks one question on a schedule: which trashed facts are past
-- their window. Partial, so it indexes only the handful of rows actually in the
-- trash rather than every fact ever written.
CREATE INDEX idx_facts_trashed_at ON facts(trashed_at) WHERE trashed_at IS NOT NULL;
