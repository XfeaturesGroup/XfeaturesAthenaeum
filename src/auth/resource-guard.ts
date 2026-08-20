import type { Classification } from "../security/classification";
import { assertAuthorizedOrNotFound } from "./authorize";
import { hasPermission } from "./permissions";
import type { Principal } from "./types";
import { ApiError, ErrorCode } from "../utils/responses";

/**
 * An administrative write permission (`admin.facts`, `admin.documents`) grants
 * the right to operate on a KIND of resource. It does not, by itself, grant
 * the right to see any PARTICULAR resource.
 *
 * Without the guards below, a role holding `admin.facts` but only
 * `knowledge.classification.PUBLIC` could edit a RESTRICTED fact it can never
 * read -- and, worse, rewrite its classification to PUBLIC and then read the
 * downgraded copy through the ordinary read path. See SR-002 / SR-003 in
 * the security review.
 */
export function assertCanAccessFact(principal: Principal, namespace: string, classification: Classification): void {
  assertAuthorizedOrNotFound(principal, { action: "facts.read", resource: { namespace, classification } }, "Fact not found.");
}

export function assertCanAccessDocument(principal: Principal, domain: string, classification: Classification): void {
  assertAuthorizedOrNotFound(principal, { action: "documents.read", resource: { domain, classification } }, "Document not found.");
}

/**
 * Changing a classification requires holding BOTH tiers: the current one (to
 * touch the resource at all) and the target one (so data can never be moved
 * into a tier the actor does not itself hold -- the downgrade-then-read
 * escalation).
 */
export function assertCanReclassifyFact(
  principal: Principal,
  namespace: string,
  current: Classification,
  target: Classification | undefined
): void {
  assertCanAccessFact(principal, namespace, current);
  if (target !== undefined && target !== current) {
    assertCanAccessFact(principal, namespace, target);
  }
}

export function assertCanReclassifyDocument(
  principal: Principal,
  domain: string,
  current: Classification,
  target: Classification | undefined
): void {
  assertCanAccessDocument(principal, domain, current);
  if (target !== undefined && target !== current) {
    assertCanAccessDocument(principal, domain, target);
  }
}

/**
 * Privilege containment for role grants (, SR-002/SR-003's sibling
 * finding for identities rather than data): an actor may never hand out a
 * role whose permissions it does not itself already hold. Without this, an
 * `admin.agents` holder could mint or promote an identity strictly more
 * powerful than its own credential -- a compromised low-privilege admin
 * bootstrapping a full one.
 *
 * Wildcard-aware via `hasPermission`, so a caller holding `documents.read.*`
 * is correctly treated as covering `documents.read.support` and does not
 * need every concrete permission enumerated. Used identically at agent
 * creation (granting a starting set of roles) and at role assignment
 * (granting one more role to an existing agent) -- the risk is the same act
 * either way.
 */
export function assertCanGrantRole(principal: Principal, rolePermissionKeys: readonly string[]): void {
  const escalating = rolePermissionKeys.filter((key) => !hasPermission(principal.permissions, key));
  if (escalating.length > 0) {
    throw new ApiError(ErrorCode.FORBIDDEN, "Access denied", { authzReason: "PRIVILEGE_ESCALATION_BLOCKED" });
  }
}
