import type { Classification } from "../security/classification";
import { ApiError, ErrorCode } from "../utils/responses";
import { hasPermission } from "./permissions";
import type { AuthzResult, Principal } from "./types";

export type GlobalAction =
  | "knowledge.search"
  | "facts.write"
  | "documents.write"
  | "documents.publish"
  | "products.read"
  | "prices.read"
  | "network.read"
  | "network.restricted.read"
  | "feedback.submit"
  | "audit.read"
  | "admin.agents"
  | "admin.roles"
  | "admin.permissions"
  | "admin.ingestion"
  | "admin.facts"
  | "admin.documents";

export interface FactResource {
  namespace: string;
  classification: Classification;
}

export interface DocumentResource {
  domain: string;
  classification: Classification;
}

export type AuthzRequest =
  | { action: "facts.read"; resource: FactResource }
  | { action: "documents.read"; resource: DocumentResource }
  | { action: GlobalAction };

/**
 * The single authorization decision point. REST routes, the
 * RPC entrypoint, and MCP tools all call this with a resolved Principal --
 * never a client-claimed role -- so there is exactly one place
 * that can grant access. Every branch ends in an explicit allow or deny;
 * there is no fallthrough that defaults to allow (default deny).
 *
 * `facts.read` / `documents.read` require BOTH a scope permission
 * (`facts.read.<namespace>` / `documents.read.<domain>`, wildcard-aware) AND
 * a classification permission (`knowledge.classification.<TIER>`) -- a role
 * that can read the support domain but was never granted CONFIDENTIAL still
 * can't see a CONFIDENTIAL document filed under support.
 */
export function authorize(principal: Principal, request: AuthzRequest): AuthzResult {
  switch (request.action) {
    case "facts.read": {
      const { namespace, classification } = request.resource;
      if (!hasPermission(principal.permissions, `facts.read.${namespace}`)) {
        return { allowed: false, reason: "MISSING_SCOPE_PERMISSION" };
      }
      if (!hasPermission(principal.permissions, `knowledge.classification.${classification}`)) {
        return { allowed: false, reason: "CLASSIFICATION_NOT_PERMITTED" };
      }
      return { allowed: true };
    }

    case "documents.read": {
      const { domain, classification } = request.resource;
      if (!hasPermission(principal.permissions, `documents.read.${domain}`)) {
        return { allowed: false, reason: "MISSING_SCOPE_PERMISSION" };
      }
      if (!hasPermission(principal.permissions, `knowledge.classification.${classification}`)) {
        return { allowed: false, reason: "CLASSIFICATION_NOT_PERMITTED" };
      }
      return { allowed: true };
    }

    default: {
      if (!hasPermission(principal.permissions, request.action)) {
        return { allowed: false, reason: "MISSING_PERMISSION" };
      }
      return { allowed: true };
    }
  }
}

/**
 * Convenience wrapper used throughout the knowledge service layer: throws a
 * standard FORBIDDEN ApiError (carrying the authz reason for the audit log)
 * instead of making every call site branch on the result.
 */
export function assertAuthorized(principal: Principal, request: AuthzRequest): void {
  const result = authorize(principal, request);
  if (!result.allowed) {
    throw new ApiError(ErrorCode.FORBIDDEN, "Access denied", { authzReason: result.reason, action: request.action });
  }
}

/**
 * Same decision as assertAuthorized, but a denial is reported to the client as
 * NOT_FOUND. Use this on read paths where the resource has ALREADY been found:
 * answering 403 there would confirm that a restricted resource exists at that
 * identifier, letting an unauthorized caller enumerate restricted content by
 * probing 403-vs-404 (SR-009).
 *
 * The thrown error keeps `code = FORBIDDEN`, so the audit trail still records
 * a truthful authorization denial with its reason -- only the client-facing
 * code is masked.
 */
export function assertAuthorizedOrNotFound(principal: Principal, request: AuthzRequest, notFoundMessage: string): void {
  const result = authorize(principal, request);
  if (!result.allowed) {
    throw new ApiError(
      ErrorCode.FORBIDDEN,
      notFoundMessage,
      { authzReason: result.reason, action: request.action },
      ErrorCode.NOT_FOUND
    );
  }
}

/** The classification tiers a principal may see at all, for building retrieval pre-filters. */
export function permittedClassifications(principal: Principal): Classification[] {
  const tiers: Classification[] = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"];
  return tiers.filter((tier) => hasPermission(principal.permissions, `knowledge.classification.${tier}`));
}

const DOCUMENT_READ_PREFIX = "documents.read.";

/**
 * The document-domain scope a principal can read, as a filter the retrieval
 * engine can apply BEFORE searching (/ SR-004).
 *
 * `all` means the principal holds the `documents.read.*` wildcard, so no
 * domain restriction is needed. `enumerated` lists exactly the domains
 * granted; an empty list means the principal can read no document at all and
 * the search must short-circuit rather than run unfiltered.
 *
 * Enumeration is only sound because `permissionSatisfies` rejects wildcards
 * shallower than `<a>.<b>.*` -- so `documents.*` cannot silently grant
 * document reads outside this prefix scan.
 */
export type DocumentDomainScope = { kind: "all" } | { kind: "enumerated"; domains: string[] };

export function documentDomainScope(principal: Principal): DocumentDomainScope {
  const domains: string[] = [];
  for (const granted of principal.permissions) {
    if (granted === `${DOCUMENT_READ_PREFIX}*`) {
      return { kind: "all" };
    }
    if (granted.startsWith(DOCUMENT_READ_PREFIX)) {
      const domain = granted.slice(DOCUMENT_READ_PREFIX.length);
      if (domain.length > 0) domains.push(domain);
    }
  }
  return { kind: "enumerated", domains };
}
