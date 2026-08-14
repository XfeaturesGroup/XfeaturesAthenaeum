import type { PermissionRow, RoleRow } from "../db/rows";
import { generateId } from "../utils/ids";
import { nowIso } from "../utils/time";

export class RolesRepository {
  constructor(private readonly db: D1Database) {}

  async list(): Promise<RoleRow[]> {
    const { results } = await this.db.prepare("SELECT * FROM roles ORDER BY name").all<RoleRow>();
    return results;
  }

  async getByName(name: string): Promise<RoleRow | null> {
    const row = await this.db.prepare("SELECT * FROM roles WHERE name = ?1").bind(name).first<RoleRow>();
    return row ?? null;
  }

  async getById(id: string): Promise<RoleRow | null> {
    const row = await this.db.prepare("SELECT * FROM roles WHERE id = ?1").bind(id).first<RoleRow>();
    return row ?? null;
  }

  async create(name: string, description: string | undefined): Promise<RoleRow> {
    const row: RoleRow = { id: generateId(), name, description: description ?? null, created_at: nowIso(), updated_at: nowIso() };
    await this.db
      .prepare("INSERT INTO roles (id, name, description, created_at, updated_at) VALUES (?1,?2,?3,?4,?5)")
      .bind(row.id, row.name, row.description, row.created_at, row.updated_at)
      .run();
    return row;
  }

  async listPermissions(): Promise<PermissionRow[]> {
    const { results } = await this.db.prepare("SELECT * FROM permissions ORDER BY key").all<PermissionRow>();
    return results;
  }

  async getPermissionByKey(key: string): Promise<PermissionRow | null> {
    const row = await this.db.prepare("SELECT * FROM permissions WHERE key = ?1").bind(key).first<PermissionRow>();
    return row ?? null;
  }

  async listPermissionsForRole(roleId: string): Promise<PermissionRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT p.* FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?1 ORDER BY p.key`
      )
      .bind(roleId)
      .all<PermissionRow>();
    return results;
  }

  async grantPermission(roleId: string, permissionId: string): Promise<void> {
    await this.db
      .prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES (?1, ?2, ?3)")
      .bind(roleId, permissionId, nowIso())
      .run();
  }

  async revokePermission(roleId: string, permissionId: string): Promise<void> {
    await this.db.prepare("DELETE FROM role_permissions WHERE role_id = ?1 AND permission_id = ?2").bind(roleId, permissionId).run();
  }
}
