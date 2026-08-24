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

export interface ListFactsOptions {
  /** Namespaces the caller may read; undefined means "no namespace restriction" (a `facts.read.*` holder). */
  namespaces?: readonly string[];
  classifications: readonly Classification[];
  status?: FactStatus;
  /** Free-text match against key, title, description and the stored value. */
  query?: string;
  limit: number;
  offset: number;
}

/** One namespace and how much of it a caller can see, per classification tier. */
export interface NamespaceCountRow {
  namespace: string;
  classification: Classification;
  fact_count: number;
}

/**
 * LIKE treats % and _ as wildcards, so an operator searching for "50_off" would
 * silently match "5000ff". Escaped rather than stripped: both characters are
 * legitimate inside a key or a value, and a search box should find what was
 * typed into it.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export class FactsRepository {
  constructor(private readonly db: D1Database) {}

  async getActive(namespace: string, key: string): Promise<FactRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM facts WHERE namespace = ?1 AND key = ?2 AND status = 'active' AND trashed_at IS NULL")
      .bind(namespace, key)
      .first<FactRow>();
    return row ?? null;
  }

  /**
   * The row whatever its status, as long as it is not already in the trash.
   *
   * `getActive` is the right lookup for every read path; it is the wrong one
   * for deleting something, because a fact that was deprecated first -- which
   * is the usual order -- would look like it did not exist.
   */
  async getByKey(namespace: string, key: string): Promise<FactRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM facts WHERE namespace = ?1 AND key = ?2 AND trashed_at IS NULL")
      .bind(namespace, key)
      .first<FactRow>();
    return row ?? null;
  }

  /**
   * The current rows behind a set of namespace/key pairs, in one query.
   *
   * Used by the review queue, which has to show a reviewer what a proposal
   * would replace. One query rather than one per proposal: a queue of twenty
   * proposals should not be twenty round trips, and a reviewer looking at a
   * stale page is worse than one looking at a slow one.
   */
  async getManyByKeys(targets: readonly { namespace: string; key: string }[]): Promise<FactRow[]> {
    if (targets.length === 0) return [];
    const params: unknown[] = [];
    const pairs = targets.map((target) => {
      params.push(target.namespace, target.key);
      return `(namespace = ?${String(params.length - 1)} AND key = ?${String(params.length)})`;
    });
    const { results } = await this.db
      .prepare(`SELECT * FROM facts WHERE trashed_at IS NULL AND (${pairs.join(" OR ")})`)
      .bind(...params)
      .all<FactRow>();
    return results;
  }

  /** The row as it sits in the trash. Nothing else returns it, by design. */
  async getTrashed(namespace: string, key: string): Promise<FactRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM facts WHERE namespace = ?1 AND key = ?2 AND trashed_at IS NOT NULL")
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
      .prepare("SELECT * FROM facts WHERE namespace = ?1 AND status = 'active' AND trashed_at IS NULL ORDER BY key LIMIT ?2 OFFSET ?3")
      .bind(namespace, limit, offset)
      .all<FactRow>();
    return results;
  }

  async listVersions(namespace: string, key: string): Promise<FactRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, ?1 AS namespace, ?2 AS key, version, value_json, title, description, classification, status,
                source_id, valid_from, valid_until, NULL AS trashed_at, NULL AS status_before_trash,
                created_at, created_at AS updated_at, created_by, created_by AS updated_by
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
      trashed_at: null,
      status_before_trash: null,
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

  /**
   * Facts across every namespace the caller may read, for the administrative
   * console.
   *
   * The namespace and classification bounds are applied in SQL rather than to
   * the page after it arrives: filtering afterwards lets unreadable rows consume
   * the page budget, and the shortfall tells the caller how many facts exist
   * that it may not see. Per-row authorization still runs on top of this -- the
   * query is the pre-filter, never the decision.
   *
   * Trashed facts are excluded. They have a view of their own, and something on
   * its way out does not belong in the list of things that are not.
   */
  async listAll(options: ListFactsOptions): Promise<FactRow[]> {
    if (options.classifications.length === 0) return [];
    if (options.namespaces?.length === 0) return [];

    const conditions = ["trashed_at IS NULL"];
    const params: unknown[] = [];
    const mark = (value: unknown): string => `?${String(params.push(value))}`;

    if (options.namespaces !== undefined) {
      conditions.push(`namespace IN (${options.namespaces.map(mark).join(",")})`);
    }
    conditions.push(`classification IN (${options.classifications.map(mark).join(",")})`);
    if (options.status) {
      conditions.push(`status = ${mark(options.status)}`);
    }

    // Every term has to appear somewhere in the row, so "annual 990" narrows
    // rather than widens. A single-word query is just the one-term case.
    for (const term of options.query?.trim().split(/\s+/).filter((part) => part.length > 0) ?? []) {
      const pattern = mark(`%${escapeLike(term)}%`);
      conditions.push(
        `(key LIKE ${pattern} ESCAPE '\\' OR COALESCE(title,'') LIKE ${pattern} ESCAPE '\\'` +
          ` OR COALESCE(description,'') LIKE ${pattern} ESCAPE '\\' OR value_json LIKE ${pattern} ESCAPE '\\')`
      );
    }

    const limitMark = mark(options.limit);
    const offsetMark = mark(options.offset);
    const { results } = await this.db
      .prepare(
        `SELECT * FROM facts WHERE ${conditions.join(" AND ")}
          ORDER BY namespace, key
          LIMIT ${limitMark} OFFSET ${offsetMark}`
      )
      .bind(...params)
      .all<FactRow>();
    return results;
  }

  /**
   * How many active facts each namespace holds, per classification tier.
   *
   * Split by tier rather than summed in SQL because the caller has to drop the
   * tiers it may not read before it reports a total. A count is a disclosure
   * like any other: "products: 40" tells a PUBLIC-only reader that 37 facts
   * exist which it will never be shown.
   */
  async countByNamespace(options: {
    namespaces?: readonly string[];
    classifications: readonly Classification[];
  }): Promise<NamespaceCountRow[]> {
    if (options.classifications.length === 0) return [];
    if (options.namespaces?.length === 0) return [];

    const conditions = ["status = 'active'", "trashed_at IS NULL"];
    const params: unknown[] = [];
    const mark = (value: unknown): string => `?${String(params.push(value))}`;

    if (options.namespaces !== undefined) {
      conditions.push(`namespace IN (${options.namespaces.map(mark).join(",")})`);
    }
    conditions.push(`classification IN (${options.classifications.map(mark).join(",")})`);

    const { results } = await this.db
      .prepare(
        `SELECT namespace, classification, COUNT(*) AS fact_count
           FROM facts WHERE ${conditions.join(" AND ")}
          GROUP BY namespace, classification
          ORDER BY namespace`
      )
      .bind(...params)
      .all<NamespaceCountRow>();
    return results;
  }

  /**
   * Moves a fact to the trash, recording when and what to come back to.
   *
   * `status_before_trash = status` reads the row's existing value -- every
   * assignment in a SQL UPDATE is evaluated against the pre-update row -- so the
   * state being left behind is captured in the same statement that leaves it,
   * with no window where the two disagree.
   *
   * `deprecated` is not a euphemism: it is the state no read path returns
   * (SR-008), which is what makes the fact unanswerable the moment this runs.
   * `trashed_at` is what distinguishes "deprecated" from "deprecated and on its
   * way out", and the `trashed_at IS NULL` guard makes a second call a no-op
   * rather than restarting the retention window.
   */
  async moveToTrash(namespace: string, key: string, updatedBy: string): Promise<FactRow | null> {
    const now = nowIso();
    const row = await this.db
      .prepare(
        `UPDATE facts
            SET status_before_trash = status, status = 'deprecated',
                trashed_at = ?1, updated_at = ?1, updated_by = ?2
          WHERE namespace = ?3 AND key = ?4 AND trashed_at IS NULL
        RETURNING *`
      )
      .bind(now, updatedBy, namespace, key)
      .first<FactRow>();
    return row ?? null;
  }

  /** Returns a trashed fact to the exact state it was in before. */
  async restoreFromTrash(namespace: string, key: string, updatedBy: string): Promise<FactRow | null> {
    const row = await this.db
      .prepare(
        `UPDATE facts
            SET status = COALESCE(status_before_trash, status), status_before_trash = NULL, trashed_at = NULL,
                updated_at = ?1, updated_by = ?2
          WHERE namespace = ?3 AND key = ?4 AND trashed_at IS NOT NULL
        RETURNING *`
      )
      .bind(nowIso(), updatedBy, namespace, key)
      .first<FactRow>();
    return row ?? null;
  }

  /** The trash, bounded by the caller's readable namespaces and classifications. */
  async listTrashed(options: {
    namespaces?: readonly string[];
    classifications: readonly Classification[];
    limit: number;
    offset: number;
  }): Promise<FactRow[]> {
    if (options.classifications.length === 0) return [];
    if (options.namespaces?.length === 0) return [];

    const conditions = ["trashed_at IS NOT NULL"];
    const params: unknown[] = [];
    const mark = (value: unknown): string => `?${String(params.push(value))}`;

    if (options.namespaces !== undefined) {
      conditions.push(`namespace IN (${options.namespaces.map(mark).join(",")})`);
    }
    conditions.push(`classification IN (${options.classifications.map(mark).join(",")})`);

    const limitMark = mark(options.limit);
    const offsetMark = mark(options.offset);
    const { results } = await this.db
      .prepare(
        `SELECT * FROM facts WHERE ${conditions.join(" AND ")}
          ORDER BY trashed_at DESC
          LIMIT ${limitMark} OFFSET ${offsetMark}`
      )
      .bind(...params)
      .all<FactRow>();
    return results;
  }

  /** Trashed facts whose retention window has closed. */
  async findPurgeable(cutoffIso: string, limit: number): Promise<FactRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM facts
          WHERE trashed_at IS NOT NULL AND trashed_at <= ?1
          ORDER BY trashed_at ASC LIMIT ?2`
      )
      .bind(cutoffIso, limit)
      .all<FactRow>();
    return results;
  }

  /**
   * Destroys a purged fact and every version of it.
   *
   * `fact_versions` is keyed by namespace/key rather than by a foreign key, so
   * nothing cascades and the history has to be removed explicitly -- otherwise
   * the purge would leave behind precisely the values it was asked to destroy.
   *
   * Audit events are untouched. `resource_id` is a plain column, so the record
   * that this fact existed and was removed outlives the fact itself, and it
   * carries no fact content.
   */
  async purgeFact(namespace: string, key: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM fact_versions WHERE fact_namespace = ?1 AND fact_key = ?2").bind(namespace, key),
      this.db.prepare("DELETE FROM facts WHERE namespace = ?1 AND key = ?2 AND trashed_at IS NOT NULL").bind(namespace, key)
    ]);
  }
}
