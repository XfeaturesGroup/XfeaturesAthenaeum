import { assertAuthorized, assertAuthorizedOrNotFound } from "../auth/authorize";
import type { Principal } from "../auth/types";
import type { FactRow } from "../db/rows";
import type { FactsRepository } from "../repositories/facts.repository";
import { isWithinValidityWindow } from "../utils/time";
import { ApiError, ErrorCode } from "../utils/responses";
import type { FactDTO } from "./dto";

function toDTO(row: FactRow): FactDTO {
  return {
    namespace: row.namespace,
    key: row.key,
    version: row.version,
    value: JSON.parse(row.value_json) as unknown,
    title: row.title,
    description: row.description,
    classification: row.classification,
    status: row.status,
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
    return toDTO(row);
  }

  async getFacts(principal: Principal, namespace: string, limit: number, offset: number): Promise<FactDTO[]> {
    const rows = await this.repo.listByNamespace(namespace, limit, offset);
    const visible: FactDTO[] = [];
    for (const row of rows) {
      if (!isWithinValidityWindow(row.valid_from, row.valid_until)) continue;
      const authz = authorizeQuiet(principal, namespace, row.classification);
      if (authz) visible.push(toDTO(row));
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

  /** Restore a prior version's content as the new current version. */
  async rollback(principal: Principal, namespace: string, key: string, targetVersion: number, updatedBy: string): Promise<FactDTO> {
    assertAuthorized(principal, { action: "facts.write" });
    const row = await this.repo.rollbackToVersion(namespace, key, targetVersion, updatedBy);
    return toDTO(row);
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
