import type { Classification } from "../security/classification";
import { StaleVersionError } from "../db/errors";
import type { FactRow, FactStatus } from "../db/rows";
import { generateId } from "../utils/ids";
import { nowIso } from "../utils/time";

export interface CreateFactInput {
  namespace: string;
  key: string;
  valueJson: string;
  title?: string;
  description?: string;
  classification: Classification;
  sourceId?: string;
  validFrom?: string;
  validUntil?: string;
  createdBy: string;
}

export interface UpdateFactInput {
  valueJson?: string;
  title?: string;
  description?: string;
  classification?: Classification;
  sourceId?: string;
  validFrom?: string;
  validUntil?: string;
  status?: FactStatus;
  updatedBy: string;
  /** Optimistic concurrency: if provided and stale, throws StaleVersionError. */
  expectedVersion?: number;
}

export class FactsRepository {
  constructor(private readonly db: D1Database) {}

  async getActive(namespace: string, key: string): Promise<FactRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM facts WHERE namespace = ?1 AND key = ?2 AND status = 'active'")
      .bind(namespace, key)
      .first<FactRow>();
    return row ?? null;
  }

  /**
   * SR-008: only active facts. An earlier revision omitted the status filter,
   * so a deprecated fact -- superseded precisely because it was wrong or
   * outdated -- was served through the list endpoint as if current, while the
   * single-fact endpoint correctly hid it.
   */
  async listByNamespace(namespace: string, limit: number, offset: number): Promise<FactRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM facts WHERE namespace = ?1 AND status = 'active' ORDER BY key LIMIT ?2 OFFSET ?3")
      .bind(namespace, limit, offset)
      .all<FactRow>();
    return results;
  }

  async listVersions(namespace: string, key: string): Promise<FactRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, ?1 AS namespace, ?2 AS key, version, value_json, title, description, classification, status,
                source_id, valid_from, valid_until, created_at, created_at AS updated_at, created_by, created_by AS updated_by
         FROM fact_versions WHERE fact_namespace = ?1 AND fact_key = ?2 ORDER BY version DESC`
      )
      .bind(namespace, key)
      .all<FactRow>();
    return results;
  }

  async create(input: CreateFactInput): Promise<FactRow> {
    const id = generateId();
    const now = nowIso();
    const row: FactRow = {
      id,
      namespace: input.namespace,
      key: input.key,
      version: 1,
      value_json: input.valueJson,
      title: input.title ?? null,
      description: input.description ?? null,
      classification: input.classification,
      status: "active",
      source_id: input.sourceId ?? null,
      valid_from: input.validFrom ?? null,
      valid_until: input.validUntil ?? null,
      created_at: now,
      updated_at: now,
      created_by: input.createdBy,
      updated_by: input.createdBy
    };

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO facts
             (id, namespace, key, version, value_json, title, description, classification, status, source_id, valid_from, valid_until, created_at, updated_at, created_by, updated_by)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`
        )
        .bind(
          row.id,
          row.namespace,
          row.key,
          row.version,
          row.value_json,
          row.title,
          row.description,
          row.classification,
          row.status,
          row.source_id,
          row.valid_from,
          row.valid_until,
          row.created_at,
          row.updated_at,
          row.created_by,
          row.updated_by
        ),
      this.db
        .prepare(
          `INSERT INTO fact_versions
             (id, fact_namespace, fact_key, version, value_json, title, description, classification, status, source_id, valid_from, valid_until, created_at, created_by)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
        )
        .bind(
          generateId(),
          row.namespace,
          row.key,
          row.version,
          row.value_json,
          row.title,
          row.description,
          row.classification,
          row.status,
          row.source_id,
          row.valid_from,
          row.valid_until,
          row.created_at,
          row.created_by
        )
    ]);

    return row;
  }

  async update(namespace: string, key: string, input: UpdateFactInput): Promise<FactRow> {
    const current = await this.getActive(namespace, key);
    if (!current) {
      throw new Error(`Fact not found: ${namespace}/${key}`);
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
      throw new StaleVersionError(`fact:${namespace}/${key}`, input.expectedVersion, current.version);
    }

    const now = nowIso();
    const next: FactRow = {
      ...current,
      version: current.version + 1,
      value_json: input.valueJson ?? current.value_json,
      title: input.title ?? current.title,
      description: input.description ?? current.description,
      classification: input.classification ?? current.classification,
      status: input.status ?? current.status,
      source_id: input.sourceId ?? current.source_id,
      valid_from: input.validFrom ?? current.valid_from,
      valid_until: input.validUntil ?? current.valid_until,
      updated_at: now,
      updated_by: input.updatedBy
    };

    await this.db.batch([
      this.db
        .prepare(
          `UPDATE facts SET version = ?1, value_json = ?2, title = ?3, description = ?4, classification = ?5,
             status = ?6, source_id = ?7, valid_from = ?8, valid_until = ?9, updated_at = ?10, updated_by = ?11
           WHERE namespace = ?12 AND key = ?13`
        )
        .bind(
          next.version,
          next.value_json,
          next.title,
          next.description,
          next.classification,
          next.status,
          next.source_id,
          next.valid_from,
          next.valid_until,
          next.updated_at,
          next.updated_by,
          namespace,
          key
        ),
      this.db
        .prepare(
          `INSERT INTO fact_versions
             (id, fact_namespace, fact_key, version, value_json, title, description, classification, status, source_id, valid_from, valid_until, created_at, created_by)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
        )
        .bind(
          generateId(),
          next.namespace,
          next.key,
          next.version,
          next.value_json,
          next.title,
          next.description,
          next.classification,
          next.status,
          next.source_id,
          next.valid_from,
          next.valid_until,
          next.updated_at,
          next.updated_by
        )
    ]);

    return next;
  }

  async deprecate(namespace: string, key: string, updatedBy: string): Promise<void> {
    await this.update(namespace, key, { status: "deprecated", updatedBy });
  }

  async getVersion(namespace: string, key: string, version: number): Promise<FactRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM fact_versions WHERE fact_namespace = ?1 AND fact_key = ?2 AND version = ?3")
      .bind(namespace, key, version)
      .first<{
        value_json: string;
        title: string | null;
        description: string | null;
        classification: FactRow["classification"];
        source_id: string | null;
        valid_from: string | null;
        valid_until: string | null;
      }>();
    if (!row) return null;
    const current = await this.getActive(namespace, key);
    if (!current) return null;
    return { ...current, ...row };
  }

  /**
   * (rollback): restores a prior version's content as a new
   * current version -- history is append-only, so "rollback" means
   * forward-fixing to old content under a fresh version number, never
   * rewriting fact_versions in place.
   */
  async rollbackToVersion(namespace: string, key: string, targetVersion: number, updatedBy: string): Promise<FactRow> {
    const target = await this.getVersion(namespace, key, targetVersion);
    if (!target) {
      throw new Error(`Fact version not found: ${namespace}/${key} v${String(targetVersion)}`);
    }
    return this.update(namespace, key, {
      valueJson: target.value_json,
      title: target.title ?? undefined,
      description: target.description ?? undefined,
      classification: target.classification,
      sourceId: target.source_id ?? undefined,
      validFrom: target.valid_from ?? undefined,
      validUntil: target.valid_until ?? undefined,
      status: "active",
      updatedBy
    });
  }
}
