import type { DocumentStatus, PolicyRow } from "../db/rows";
import type { Classification } from "../security/classification";
import { generateId } from "../utils/ids";
import { nowIso } from "../utils/time";

export interface CreatePolicyInput {
  code: string;
  title: string;
  bodyMarkdown?: string;
  documentId?: string;
  classification: Classification;
  sourceId?: string;
  createdBy: string;
}

export interface UpdatePolicyInput {
  title?: string;
  bodyMarkdown?: string;
  documentId?: string;
  classification?: Classification;
  status?: DocumentStatus;
  updatedBy: string;
}

export class PoliciesRepository {
  constructor(private readonly db: D1Database) {}

  async getByCode(code: string): Promise<PolicyRow | null> {
    const row = await this.db.prepare("SELECT * FROM policies WHERE code = ?1").bind(code).first<PolicyRow>();
    return row ?? null;
  }

  async list(status: DocumentStatus | undefined, limit: number, offset: number): Promise<PolicyRow[]> {
    const query = status
      ? this.db.prepare("SELECT * FROM policies WHERE status = ?1 ORDER BY code LIMIT ?2 OFFSET ?3").bind(status, limit, offset)
      : this.db.prepare("SELECT * FROM policies ORDER BY code LIMIT ?1 OFFSET ?2").bind(limit, offset);
    const { results } = await query.all<PolicyRow>();
    return results;
  }

  async create(input: CreatePolicyInput): Promise<PolicyRow> {
    const row: PolicyRow = {
      id: generateId(),
      code: input.code,
      title: input.title,
      body_markdown: input.bodyMarkdown ?? null,
      document_id: input.documentId ?? null,
      classification: input.classification,
      status: "draft",
      version: 1,
      valid_from: null,
      valid_until: null,
      source_id: input.sourceId ?? null,
      created_at: nowIso(),
      updated_at: nowIso(),
      created_by: input.createdBy,
      updated_by: input.createdBy
    };
    await this.db
      .prepare(
        `INSERT INTO policies (id, code, title, body_markdown, document_id, classification, status, version, valid_from, valid_until, source_id, created_at, updated_at, created_by, updated_by)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`
      )
      .bind(
        row.id, row.code, row.title, row.body_markdown, row.document_id, row.classification, row.status,
        row.version, row.valid_from, row.valid_until, row.source_id, row.created_at, row.updated_at, row.created_by, row.updated_by
      )
      .run();
    return row;
  }

  async update(code: string, input: UpdatePolicyInput): Promise<PolicyRow> {
    const current = await this.getByCode(code);
    if (!current) throw new Error(`Policy not found: ${code}`);
    const next: PolicyRow = {
      ...current,
      title: input.title ?? current.title,
      body_markdown: input.bodyMarkdown ?? current.body_markdown,
      document_id: input.documentId ?? current.document_id,
      classification: input.classification ?? current.classification,
      status: input.status ?? current.status,
      version: current.version + 1,
      updated_at: nowIso(),
      updated_by: input.updatedBy
    };
    await this.db
      .prepare(
        `UPDATE policies SET title=?1, body_markdown=?2, document_id=?3, classification=?4, status=?5, version=?6, updated_at=?7, updated_by=?8
         WHERE code=?9`
      )
      .bind(next.title, next.body_markdown, next.document_id, next.classification, next.status, next.version, next.updated_at, next.updated_by, code)
      .run();
    return next;
  }
}
