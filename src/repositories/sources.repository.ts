import type { KnowledgeSourceRow } from "../db/rows";
import { generateId } from "../utils/ids";
import { nowIso } from "../utils/time";

export interface CreateSourceInput {
  name: string;
  sourceType: "manual" | "import" | "api";
  authority: "official" | "internal_verified" | "imported" | "external" | "unverified";
  reference?: string;
}

export class SourcesRepository {
  constructor(private readonly db: D1Database) {}

  async getById(id: string): Promise<KnowledgeSourceRow | null> {
    const row = await this.db.prepare("SELECT * FROM knowledge_sources WHERE id = ?1").bind(id).first<KnowledgeSourceRow>();
    return row ?? null;
  }

  async create(input: CreateSourceInput): Promise<KnowledgeSourceRow> {
    const row: KnowledgeSourceRow = {
      id: generateId(),
      name: input.name,
      source_type: input.sourceType,
      authority: input.authority,
      reference: input.reference ?? null,
      created_at: nowIso(),
      updated_at: nowIso()
    };
    await this.db
      .prepare("INSERT INTO knowledge_sources (id, name, source_type, authority, reference, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)")
      .bind(row.id, row.name, row.source_type, row.authority, row.reference, row.created_at, row.updated_at)
      .run();
    return row;
  }
}
