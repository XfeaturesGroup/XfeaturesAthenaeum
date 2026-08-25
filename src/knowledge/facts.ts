import { assertAuthorized, assertAuthorizedOrNotFound, authorize, factNamespaceScope, permittedClassifications } from "../auth/authorize";
import type { Principal } from "../auth/types";
import { LIMITS } from "../config";
import type { FactRow, FactStatus } from "../db/rows";
import type { FactsRepository } from "../repositories/facts.repository";
import { isWithinValidityWindow } from "../utils/time";
import { ApiError, ErrorCode } from "../utils/responses";
import type { FactDTO, FactNamespaceDTO, FactVersionDTO, TrashedFactDTO } from "./dto";

function toVersionDTO(row: FactRow, currentVersion: number): FactVersionDTO {
  return {
    namespace: row.namespace,
    key: row.key,
    version: row.version,
    value: JSON.parse(row.value_json) as unknown,
    title: row.title,
    description: row.description,
    classification: row.classification,
    status: row.status,
    createdAt: row.created_at,
    createdBy: row.created_by,
    isCurrent: row.version === currentVersion
  };
}

/**
 * Exported because the administrative write routes answer with the fact they
 * just wrote. They used to return the D1 row itself -- `value_json` as a
 * string, `created_by`, the internal id -- while every read path returned this
 * shape, so a client had to handle both depending on which verb it used.
 */
export function toFactDTO(row: FactRow): FactDTO {
  return {
    namespace: row.namespace,
    key: row.key,
    version: row.version,
    value: JSON.parse(row.value_json) as unknown,
    title: row.title,
    description: row.description,
    classification: row.classification,
    // A fact with a deletion time is `trashed` to anyone reading it, whatever
    // the status column says -- the same derivation the documents API uses.
    status: row.trashed_at !== null ? "trashed" : row.status,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    updatedAt: row.updated_at,
    sourceId: row.source_id
  };
}

/**
 * Deterministic fact lookups: callers that know exactly what
 * they want ("price of plan X") should hit these, never semantic search.
 */
export class FactsService {
  constructor(private readonly repo: FactsRepository) {}

  async getFact(principal: Principal, namespace: string, key: string): Promise<FactDTO> {
    const row = await this.repo.getActive(namespace, key);
    if (!row || !isWithinValidityWindow(row.valid_from, row.valid_until)) {
      throw new ApiError(ErrorCode.NOT_FOUND, "Fact not found.");
    }
    assertAuthorizedOrNotFound(
      principal,
      { action: "facts.read", resource: { namespace, classification: row.classification } },
      "Fact not found."
    );
    return toFactDTO(row);
  }

  async getFacts(principal: Principal, namespace: string, limit: number, offset: number): Promise<FactDTO[]> {
    const rows = await this.repo.listByNamespace(namespace, limit, offset);
    const visible: FactDTO[] = [];
    for (const row of rows) {
      if (!isWithinValidityWindow(row.valid_from, row.valid_until)) continue;
      const authz = authorizeQuiet(principal, namespace, row.classification);
      if (authz) visible.push(toFactDTO(row));
    }
    return visible;
  }

  /** GetKnownIssue/getIncident are facts under dedicated namespaces, not a bespoke table. */
  async getIncident(principal: Principal, code: string): Promise<FactDTO> {
    return this.getFact(principal, "incidents", code);
  }

  async getKnownIssue(principal: Principal, code: string): Promise<FactDTO> {
    return this.getFact(principal, "known-issues", code);
  }

  /**
   * Every fact namespace this caller can read, with a count.
   *
   * This exists because a console cannot offer "all facts" without knowing what
   * "all" is, and hardcoding the list -- which is what HQ did -- means a
   * namespace nobody remembered to add is invisible to every operator while
   * being perfectly readable over the API.
   *
   * Bounded twice: the namespace scope and the classification tiers both go
   * into the query, and the per-row decision runs again on the way out. An
   * unreadable namespace does not appear at all, not even as an empty one.
   */
  async listNamespaces(principal: Principal): Promise<FactNamespaceDTO[]> {
    const classifications = permittedClassifications(principal);
    if (classifications.length === 0) return [];

    const scope = factNamespaceScope(principal);
    if (scope.kind === "enumerated" && scope.namespaces.length === 0) return [];

    const rows = await this.repo.countByNamespace({
      namespaces: scope.kind === "all" ? undefined : scope.namespaces,
      classifications
    });

    const totals = new Map<string, number>();
    for (const row of rows) {
      const allowed = authorize(principal, {
        action: "facts.read",
        resource: { namespace: row.namespace, classification: row.classification }
      }).allowed;
      if (!allowed) continue;
      totals.set(row.namespace, (totals.get(row.namespace) ?? 0) + row.fact_count);
    }

    return [...totals.entries()]
      .map(([namespace, factCount]) => ({ namespace, factCount }))
      .sort((a, b) => a.namespace.localeCompare(b.namespace));
  }

  /**
   * Facts across namespaces, for the administrative console.
   *
   * `admin.facts` is what makes the cross-namespace listing reachable; it is
   * not what decides which rows come back. Every row is authorized again
   * individually, exactly as the document listing does, so an administrative
   * permission cannot become a way to read a tier the caller was never granted
   * (SR-002/SR-003).
   *
   * Deprecated facts ARE included here, unlike every ordinary read path: an
   * operator correcting the knowledge base needs to see what was superseded.
   * Trashed facts are not -- they have their own view.
   */
  async listFactsForAdmin(
    principal: Principal,
    options: { namespace?: string; status?: FactStatus; query?: string; limit: number; offset: number }
  ): Promise<FactDTO[]> {
    assertAuthorized(principal, { action: "admin.facts" });

    const classifications = permittedClassifications(principal);
    if (classifications.length === 0) return [];

    const scope = factNamespaceScope(principal);
    let namespaces: string[] | undefined = scope.kind === "all" ? undefined : scope.namespaces;
    if (options.namespace !== undefined) {
      // A client may narrow to a namespace it can already read; it can never
      // use this parameter to widen its own scope.
      if (namespaces !== undefined && !namespaces.includes(options.namespace)) return [];
      namespaces = [options.namespace];
    }
    if (namespaces?.length === 0) return [];

    const rows = await this.repo.listAll({
      namespaces,
      classifications,
      status: options.status,
      query: options.query,
      limit: options.limit,
      offset: options.offset
    });

    return rows.filter((row) => authorizeQuiet(principal, row.namespace, row.classification)).map(toFactDTO);
  }

  /**
   * A fact's history, so an operator choosing what to roll back to can see what
   * they are choosing.
   *
   * Authorized against the fact as it stands now AND against each version's own
   * classification: a fact that was CONFIDENTIAL and has since been downgraded
   * still has a CONFIDENTIAL past, and reading history is reading that past.
   */
  async listVersions(principal: Principal, namespace: string, key: string): Promise<FactVersionDTO[]> {
    assertAuthorized(principal, { action: "admin.facts" });

    // Any status: the history of a deprecated fact is exactly what an operator
    // is looking at when deciding whether to bring an old value back.
    const current = await this.repo.getByKey(namespace, key);
    if (!current) throw new ApiError(ErrorCode.NOT_FOUND, "Fact not found.");
    assertAuthorizedOrNotFound(
      principal,
      { action: "facts.read", resource: { namespace, classification: current.classification } },
      "Fact not found."
    );

    const rows = await this.repo.listVersions(namespace, key);
    return rows
      .filter((row) => authorizeQuiet(principal, namespace, row.classification))
      .map((row) => toVersionDTO(row, current.version));
  }

  /**
   * Moves a fact to the trash.
   *
   * Authorized as `facts.write` plus the fact's own tier, and reached through a
   * route gated on `admin.facts`. Deprecating and trashing are different acts:
   * deprecating says "this is no longer current" and keeps every version
   * forever, which is right for a superseded price and wrong for a value that
   * should never have been filed at all. Only the second one ends in the
   * content being destroyed, and only after the retention window.
   */
  async moveToTrash(principal: Principal, namespace: string, key: string, updatedBy: string): Promise<FactDTO> {
    assertAuthorized(principal, { action: "facts.write" });

    // Deliberately not getActive: a fact is usually deprecated before anyone
    // decides it should not exist at all, and looking only at active rows would
    // report the one most likely to be deleted as missing.
    const current = await this.repo.getByKey(namespace, key);
    if (!current) throw new ApiError(ErrorCode.NOT_FOUND, "Fact not found.");
    assertAuthorizedOrNotFound(
      principal,
      { action: "facts.read", resource: { namespace, classification: current.classification } },
      "Fact not found."
    );

    const trashed = await this.repo.moveToTrash(namespace, key, updatedBy);
    if (!trashed) throw new ApiError(ErrorCode.CONFLICT, "This fact is already in the trash.");
    return toFactDTO(trashed);
  }

  /**
   * Returns a trashed fact to the state it was in.
   *
   * A fact that was deprecated comes back deprecated. The previous state was
   * recorded when it was trashed precisely so that restoring cannot quietly
   * republish something that was withdrawn on purpose.
   */
  async restoreFromTrash(principal: Principal, namespace: string, key: string, updatedBy: string): Promise<FactDTO> {
    assertAuthorized(principal, { action: "facts.write" });

    const current = await this.repo.getTrashed(namespace, key);
    if (!current) throw new ApiError(ErrorCode.NOT_FOUND, "Fact not found.");
    assertAuthorizedOrNotFound(
      principal,
      { action: "facts.read", resource: { namespace, classification: current.classification } },
      "Fact not found."
    );

    const restored = await this.repo.restoreFromTrash(namespace, key, updatedBy);
    if (!restored) throw new ApiError(ErrorCode.CONFLICT, "This fact is not in the trash.");
    return toFactDTO(restored);
  }

  /**
   * The trash, bounded by the caller's own clearance exactly like any other
   * listing -- a fact does not become visible to someone new by being deleted.
   */
  async listTrash(principal: Principal, options: { limit: number; offset: number }): Promise<TrashedFactDTO[]> {
    assertAuthorized(principal, { action: "admin.facts" });

    const classifications = permittedClassifications(principal);
    if (classifications.length === 0) return [];
    const scope = factNamespaceScope(principal);
    if (scope.kind === "enumerated" && scope.namespaces.length === 0) return [];

    const rows = await this.repo.listTrashed({
      namespaces: scope.kind === "all" ? undefined : scope.namespaces,
      classifications,
      limit: options.limit,
      offset: options.offset
    });

    const now = Date.now();
    return rows
      .filter((row) => authorizeQuiet(principal, row.namespace, row.classification))
      .map((row) => {
        const trashedAtMs = Date.parse(row.trashed_at ?? "");
        const purgeableAtMs = trashedAtMs + LIMITS.TRASH_RETENTION_HOURS * 3600_000;
        return {
          ...toFactDTO(row),
          trashedAt: row.trashed_at ?? "",
          statusBeforeTrash: row.status_before_trash ?? "active",
          purgeableAt: new Date(purgeableAtMs).toISOString(),
          minutesRemaining: Math.max(0, Math.floor((purgeableAtMs - now) / 60_000))
        };
      });
  }

  /** Restore a prior version's content as the new current version. */
  async rollback(principal: Principal, namespace: string, key: string, targetVersion: number, updatedBy: string): Promise<FactDTO> {
    assertAuthorized(principal, { action: "facts.write" });
    const row = await this.repo.rollbackToVersion(namespace, key, targetVersion, updatedBy);
    return toFactDTO(row);
  }
}

function authorizeQuiet(principal: Principal, namespace: string, classification: FactRow["classification"]): boolean {
  try {
    assertAuthorized(principal, { action: "facts.read", resource: { namespace, classification } });
    return true;
  } catch {
    return false;
  }
}
