import type { AgentEnvironment, AgentRow, AgentStatus, AuthMode, PrincipalType } from "../db/rows";
import { generateId } from "../utils/ids";
import { nowIso } from "../utils/time";

export interface CreateAgentInput {
  agentKey: string;
  name: string;
  description?: string;
  environment: AgentEnvironment;
  authMode: AuthMode;
  rpcKeyHash?: string;
  principalType?: PrincipalType;
  /** Xfeatures Account oauth_applications.client_id (APPLICATION / AI_AGENT). */
  accountClientId?: string;
  /** Xfeatures Account users.id (USER). */
  accountUserId?: string;
  createdBy: string;
}

export interface ListAgentsOptions {
  /** Include tombstoned principals. Off by default: a deleted principal is gone from Access. */
  includeDeleted?: boolean;
  status?: AgentStatus;
  /** Xfeatures Account oauth_applications.client_id -- used by HQ to find the
   * Athenaeum agent (if any) already linked to a given service application. */
  accountClientId?: string;
  limit: number;
  offset: number;
}

export class AgentsRepository {
  constructor(private readonly db: D1Database) {}

  async findByAgentKey(agentKey: string): Promise<AgentRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM agents WHERE agent_key = ?1 AND deleted_at IS NULL")
      .bind(agentKey)
      .first<AgentRow>();
    return row ?? null;
  }

  /**
   * Resolve an Athenaeum principal from a verified Xfeatures Account identity
   * (ADR 0001 §2). The lookup is keyed on the introspected client_id / subject
   * -- never on anything the caller supplied -- and requires auth_mode
   * 'account' so an RPC- or Access-mode row cannot be reached through the
   * Account path.
   */
  async findByAccountClientId(clientId: string): Promise<AgentRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM agents WHERE account_client_id = ?1 AND auth_mode = 'account' AND deleted_at IS NULL")
      .bind(clientId)
      .first<AgentRow>();
    return row ?? null;
  }

  async findByAccountUserId(userId: string): Promise<AgentRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM agents WHERE account_user_id = ?1 AND auth_mode = 'account' AND deleted_at IS NULL")
      .bind(userId)
      .first<AgentRow>();
    return row ?? null;
  }

  async findById(id: string): Promise<AgentRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM agents WHERE id = ?1 AND deleted_at IS NULL")
      .bind(id)
      .first<AgentRow>();
    return row ?? null;
  }

  /** Only permissions reachable from an *active* agent's roles -- disabled/revoked agents resolve to an empty set. */
  async resolvePermissions(agentId: string): Promise<Set<string>> {
    const { results } = await this.db
      .prepare(
        `SELECT DISTINCT p.key AS key
         FROM agent_roles ar
         JOIN role_permissions rp ON rp.role_id = ar.role_id
         JOIN permissions p ON p.id = rp.permission_id
         JOIN agents a ON a.id = ar.agent_id
         WHERE ar.agent_id = ?1 AND a.status = 'active' AND a.deleted_at IS NULL`
      )
      .bind(agentId)
      .all<{ key: string }>();
    return new Set(results.map((r) => r.key));
  }

  async create(input: CreateAgentInput): Promise<AgentRow> {
    const row: AgentRow = {
      id: generateId(),
      agent_key: input.agentKey,
      name: input.name,
      description: input.description ?? null,
      environment: input.environment,
      status: "active",
      auth_mode: input.authMode,
      rpc_key_hash: input.rpcKeyHash ?? null,
      principal_type: input.principalType ?? (input.authMode === "rpc" ? "SERVICE" : "APPLICATION"),
      account_client_id: input.accountClientId ?? null,
      account_user_id: input.accountUserId ?? null,
      deleted_at: null,
      deleted_by: null,
      created_at: nowIso(),
      updated_at: nowIso(),
      created_by: input.createdBy,
      updated_by: input.createdBy
    };
    await this.db
      .prepare(
        `INSERT INTO agents
           (id, agent_key, name, description, environment, status, auth_mode, rpc_key_hash,
            principal_type, account_client_id, account_user_id, created_at, updated_at, created_by, updated_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`
      )
      .bind(
        row.id,
        row.agent_key,
        row.name,
        row.description,
        row.environment,
        row.status,
        row.auth_mode,
        row.rpc_key_hash,
        row.principal_type,
        row.account_client_id,
        row.account_user_id,
        row.created_at,
        row.updated_at,
        row.created_by,
        row.updated_by
      )
      .run();
    return row;
  }

  /** The `deleted_at IS NULL` guard is what stops a deleted principal being brought back to `active`. */
  async setStatus(id: string, status: AgentStatus, updatedBy: string): Promise<void> {
    await this.db
      .prepare("UPDATE agents SET status = ?1, updated_at = ?2, updated_by = ?3 WHERE id = ?4 AND deleted_at IS NULL")
      .bind(status, nowIso(), updatedBy, id)
      .run();
  }

  async rotateRpcKey(id: string, rpcKeyHash: string, updatedBy: string): Promise<void> {
    await this.db
      .prepare("UPDATE agents SET rpc_key_hash = ?1, updated_at = ?2, updated_by = ?3 WHERE id = ?4 AND deleted_at IS NULL")
      .bind(rpcKeyHash, nowIso(), updatedBy, id)
      .run();
  }

  async assignRole(agentId: string, roleId: string): Promise<void> {
    await this.db
      .prepare("INSERT OR IGNORE INTO agent_roles (agent_id, role_id, created_at) VALUES (?1, ?2, ?3)")
      .bind(agentId, roleId, nowIso())
      .run();
  }

  async unassignRole(agentId: string, roleId: string): Promise<void> {
    await this.db.prepare("DELETE FROM agent_roles WHERE agent_id = ?1 AND role_id = ?2").bind(agentId, roleId).run();
  }

  async listRoleNames(agentId: string): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT r.name AS name FROM agent_roles ar JOIN roles r ON r.id = ar.role_id WHERE ar.agent_id = ?1 ORDER BY r.name`
      )
      .bind(agentId)
      .all<{ name: string }>();
    return results.map((r) => r.name);
  }

  /**
   * How many records still point at this principal.
   *
   * The three tables named here are the ones with no cascade, and they are the
   * ones worth protecting: who Athenaeum decided a caller was, who reported a
   * fact was wrong, and who asked for a value to change. A non-zero count is
   * what makes deletion a tombstone rather than a DELETE -- see migration 0007.
   */
  async countReferences(agentId: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM audit_events WHERE actor_agent_id = ?1)
         + (SELECT COUNT(*) FROM knowledge_feedback WHERE submitted_by_agent_id = ?1)
         + (SELECT COUNT(*) FROM fact_proposals WHERE proposed_by = ?1 OR reviewed_by = ?1)
           AS reference_count`
      )
      .bind(agentId)
      .first<{ reference_count: number }>();
    return row?.reference_count ?? 0;
  }

  /**
   * Destroys a principal that left no trace. Roles and quotas go with it
   * through the cascades already on those tables.
   *
   * Conditional on the row still being revoked and not already a tombstone, so
   * a race against a status change cannot destroy a principal that has just
   * been made active again.
   */
  async purge(id: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM agents WHERE id = ?1 AND status = 'revoked' AND deleted_at IS NULL")
      .bind(id)
      .run();
    return result.meta.changes > 0;
  }

  /**
   * Turns a principal into a tombstone.
   *
   * Every credential binding is cleared in the same statement that marks it
   * deleted: the RPC key hash and the Account client/user link. Both halves of
   * that matter. Nothing is left to authenticate with, and -- because
   * `account_client_id` and `account_user_id` are UNIQUE -- clearing them is
   * what allows a fresh principal to be created for the same Account identity
   * afterwards, which is usually the reason the old one was being deleted.
   *
   * `auth_mode` becomes 'access' because the CHECK constraint from migration
   * 0002 requires credential material consistent with the mode ('rpc' needs a
   * key hash, 'account' needs exactly one Account link), and 'access' is its
   * only branch that requires none. Widening that CHECK would mean rebuilding
   * the table, which is the cascade hazard that shaped migrations 0003 and
   * 0005. It does not make the tombstone reachable through the Cloudflare
   * Access path: that path resolves through `findByAgentKey`, which excludes
   * deleted rows, and then requires `status = 'active'`, which a tombstone is
   * not -- and there is no credential left to present in any case.
   *
   * The name and key stay: an audit event naming this principal is unreadable
   * without them.
   */
  async softDelete(id: string, deletedBy: string): Promise<AgentRow | null> {
    const now = nowIso();
    const row = await this.db
      .prepare(
        `UPDATE agents
            SET deleted_at = ?1, deleted_by = ?2, updated_at = ?1, updated_by = ?2,
                auth_mode = 'access',
                rpc_key_hash = NULL, account_client_id = NULL, account_user_id = NULL
          WHERE id = ?3 AND status = 'revoked' AND deleted_at IS NULL
        RETURNING *`
      )
      .bind(now, deletedBy, id)
      .first<AgentRow>();
    return row ?? null;
  }

  async list(options: ListAgentsOptions): Promise<AgentRow[]> {
    // Deleted principals are gone from Access by default. `includeDeleted`
    // exists for the one caller with a reason to see a tombstone: an operator
    // asking what happened to a principal an audit event still names.
    const conditions: string[] = options.includeDeleted === true ? [] : ["deleted_at IS NULL"];
    const params: unknown[] = [];
    if (options.status) {
      conditions.push(`status = ?${params.length + 1}`);
      params.push(options.status);
    }
    if (options.accountClientId) {
      conditions.push(`account_client_id = ?${params.length + 1}`);
      params.push(options.accountClientId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(options.limit, options.offset);
    const { results } = await this.db
      .prepare(
        `SELECT * FROM agents ${where} ORDER BY created_at DESC LIMIT ?${params.length - 1} OFFSET ?${params.length}`
      )
      .bind(...params)
      .all<AgentRow>();
    return results;
  }
}
