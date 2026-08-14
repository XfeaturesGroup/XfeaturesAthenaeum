import { assertAuthorizedOrNotFound } from "../auth/authorize";
import type { Principal } from "../auth/types";
import type { PolicyRow } from "../db/rows";
import type { PoliciesRepository } from "../repositories/policies.repository";
import { isWithinValidityWindow } from "../utils/time";
import { ApiError, ErrorCode } from "../utils/responses";
import type { PolicyDTO } from "./dto";

function toDTO(row: PolicyRow): PolicyDTO {
  return {
    code: row.code,
    title: row.title,
    bodyMarkdown: row.body_markdown,
    documentId: row.document_id,
    classification: row.classification,
    status: row.status,
    version: row.version,
    updatedAt: row.updated_at
  };
}

export class PoliciesService {
  constructor(private readonly repo: PoliciesRepository) {}

  async getPolicy(principal: Principal, code: string): Promise<PolicyDTO> {
    const row = await this.repo.getByCode(code);
    if (row?.status !== "active" || !isWithinValidityWindow(row.valid_from, row.valid_until)) {
      throw new ApiError(ErrorCode.NOT_FOUND, "Policy not found.");
    }
    assertAuthorizedOrNotFound(
      principal,
      { action: "facts.read", resource: { namespace: "policies", classification: row.classification } },
      "Policy not found."
    );
    return toDTO(row);
  }
}
