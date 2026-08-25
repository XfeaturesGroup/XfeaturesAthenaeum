-- Let a principal be removed from Access, without removing what it did.
--
-- Until now an identity could be revoked and nothing more. Revoking is the
-- right security answer -- the credential stops working immediately, on every
-- transport -- but it is not an answer to "this row should not be in the list
-- any more": a mistyped agent created and revoked in the same minute sits in
-- the console forever beside the ones that matter, and an operator scanning
-- that list has to know which of the revoked rows are real.
--
-- The obvious implementation is a DELETE, and it does not work here. Four
-- foreign keys point at `agents` with no cascade, and three of them are the
-- ones worth protecting:
--
--   audit_events.actor_agent_id      -- who Athenaeum decided the caller was
--   knowledge_feedback.submitted_by  -- who reported a fact was wrong
--   fact_proposals.proposed_by       -- who asked for a value to change
--
-- Deleting a principal that has any of those either fails outright or, if the
-- constraint were relaxed, orphans the record of what it did. The audit trail
-- outliving the identity is the entire point of an audit trail; an identity
-- that can erase its own history by being deleted is worse than one that
-- cannot be deleted at all.
--
-- So deletion is two behaviours behind one act, chosen by whether there is
-- history to protect:
--
--   * Nothing references the principal -- it authenticated no request, filed
--     no feedback, proposed nothing. The row is destroyed outright, and its
--     roles and quotas go with it (those cascades already exist).
--   * Anything references it. The row stays as a tombstone: `deleted_at` set,
--     every credential binding cleared so it can never authenticate or be
--     re-linked to an Account identity, and gone from every listing. The audit
--     trail keeps pointing at an id whose row is a headstone, which is exactly
--     what it should point at.
--
-- Both are gated on the principal already being `revoked`, so deletion is
-- never the first thing that happens to a working credential.

ALTER TABLE agents ADD COLUMN deleted_at TEXT;
ALTER TABLE agents ADD COLUMN deleted_by TEXT;

-- Every listing and every authentication lookup now asks "and not deleted".
-- Partial, so it indexes only the tombstones rather than every agent.
CREATE INDEX idx_agents_deleted_at ON agents(deleted_at) WHERE deleted_at IS NOT NULL;
