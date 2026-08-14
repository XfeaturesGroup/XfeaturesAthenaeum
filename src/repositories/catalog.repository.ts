import type { CatalogStatus, PlanRow, ProductRow, ServiceRow, ServiceStatus, ServiceType } from "../db/rows";
import type { Classification } from "../security/classification";
import { generateId } from "../utils/ids";
import { nowIso } from "../utils/time";

export interface CreateProductInput {
  code: string;
  name: string;
  description?: string;
  category?: string;
  region?: string;
  classification: Classification;
  metadataJson?: string;
  sourceId?: string;
  validFrom?: string;
  validUntil?: string;
  createdBy: string;
}

export interface UpdateProductInput {
  name?: string;
  description?: string;
  category?: string;
  region?: string;
  status?: CatalogStatus;
  classification?: Classification;
  metadataJson?: string;
  updatedBy: string;
}

export interface CreatePlanInput {
  code: string;
  productId?: string;
  name: string;
  description?: string;
  priceAmount?: number;
  priceCurrency?: string;
  billingPeriod?: string;
  slaJson?: string;
  limitsJson?: string;
  classification: Classification;
  sourceId?: string;
  createdBy: string;
}

export interface UpdatePlanInput {
  name?: string;
  description?: string;
  priceAmount?: number;
  priceCurrency?: string;
  billingPeriod?: string;
  slaJson?: string;
  limitsJson?: string;
  status?: CatalogStatus;
  classification?: Classification;
  updatedBy: string;
}

export interface CreateServiceInput {
  code: string;
  serviceType: ServiceType;
  name: string;
  description?: string;
  region?: string;
  slaJson?: string;
  metadataJson?: string;
  classification: Classification;
  sourceId?: string;
  createdBy: string;
}

export interface UpdateServiceInput {
  name?: string;
  description?: string;
  region?: string;
  status?: ServiceStatus;
  slaJson?: string;
  metadataJson?: string;
  classification?: Classification;
  updatedBy: string;
}

export class CatalogRepository {
  constructor(private readonly db: D1Database) {}

  // --- Products -------------------------------------------------------

  async getProductByCode(code: string): Promise<ProductRow | null> {
    const row = await this.db.prepare("SELECT * FROM products WHERE code = ?1").bind(code).first<ProductRow>();
    return row ?? null;
  }

  async getProductById(id: string): Promise<ProductRow | null> {
    const row = await this.db.prepare("SELECT * FROM products WHERE id = ?1").bind(id).first<ProductRow>();
    return row ?? null;
  }

  async listProducts(status: CatalogStatus | undefined, limit: number, offset: number): Promise<ProductRow[]> {
    const query = status
      ? this.db.prepare("SELECT * FROM products WHERE status = ?1 ORDER BY code LIMIT ?2 OFFSET ?3").bind(status, limit, offset)
      : this.db.prepare("SELECT * FROM products ORDER BY code LIMIT ?1 OFFSET ?2").bind(limit, offset);
    const { results } = await query.all<ProductRow>();
    return results;
  }

  async createProduct(input: CreateProductInput): Promise<ProductRow> {
    const row: ProductRow = {
      id: generateId(),
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      category: input.category ?? null,
      region: input.region ?? null,
      status: "active",
      classification: input.classification,
      metadata_json: input.metadataJson ?? null,
      version: 1,
      valid_from: input.validFrom ?? null,
      valid_until: input.validUntil ?? null,
      source_id: input.sourceId ?? null,
      created_at: nowIso(),
      updated_at: nowIso(),
      created_by: input.createdBy,
      updated_by: input.createdBy
    };
    await this.db
      .prepare(
        `INSERT INTO products (id, code, name, description, category, region, status, classification, metadata_json, version, valid_from, valid_until, source_id, created_at, updated_at, created_by, updated_by)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`
      )
      .bind(
        row.id, row.code, row.name, row.description, row.category, row.region, row.status, row.classification,
        row.metadata_json, row.version, row.valid_from, row.valid_until, row.source_id, row.created_at, row.updated_at, row.created_by, row.updated_by
      )
      .run();
    return row;
  }

  async updateProduct(code: string, input: UpdateProductInput): Promise<void> {
    const current = await this.getProductByCode(code);
    if (!current) throw new Error(`Product not found: ${code}`);
    await this.db
      .prepare(
        `UPDATE products SET name=?1, description=?2, category=?3, region=?4, status=?5, classification=?6, metadata_json=?7, version=?8, updated_at=?9, updated_by=?10
         WHERE code=?11`
      )
      .bind(
        input.name ?? current.name,
        input.description ?? current.description,
        input.category ?? current.category,
        input.region ?? current.region,
        input.status ?? current.status,
        input.classification ?? current.classification,
        input.metadataJson ?? current.metadata_json,
        current.version + 1,
        nowIso(),
        input.updatedBy,
        code
      )
      .run();
  }

  // --- Plans ------------------------------------------------------------

  async getPlanByCode(code: string): Promise<PlanRow | null> {
    const row = await this.db.prepare("SELECT * FROM plans WHERE code = ?1").bind(code).first<PlanRow>();
    return row ?? null;
  }

  async listPlansByProduct(productId: string): Promise<PlanRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM plans WHERE product_id = ?1 ORDER BY code")
      .bind(productId)
      .all<PlanRow>();
    return results;
  }

  async createPlan(input: CreatePlanInput): Promise<PlanRow> {
    const row: PlanRow = {
      id: generateId(),
      code: input.code,
      product_id: input.productId ?? null,
      name: input.name,
      description: input.description ?? null,
      price_amount: input.priceAmount ?? null,
      price_currency: input.priceCurrency ?? null,
      billing_period: input.billingPeriod ?? null,
      sla_json: input.slaJson ?? null,
      limits_json: input.limitsJson ?? null,
      status: "active",
      classification: input.classification,
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
        `INSERT INTO plans (id, code, product_id, name, description, price_amount, price_currency, billing_period, sla_json, limits_json, status, classification, version, valid_from, valid_until, source_id, created_at, updated_at, created_by, updated_by)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)`
      )
      .bind(
        row.id, row.code, row.product_id, row.name, row.description, row.price_amount, row.price_currency,
        row.billing_period, row.sla_json, row.limits_json, row.status, row.classification, row.version,
        row.valid_from, row.valid_until, row.source_id, row.created_at, row.updated_at, row.created_by, row.updated_by
      )
      .run();
    return row;
  }

  async updatePlan(code: string, input: UpdatePlanInput): Promise<void> {
    const current = await this.getPlanByCode(code);
    if (!current) throw new Error(`Plan not found: ${code}`);
    await this.db
      .prepare(
        `UPDATE plans SET name=?1, description=?2, price_amount=?3, price_currency=?4, billing_period=?5, sla_json=?6, limits_json=?7, status=?8, classification=?9, version=?10, updated_at=?11, updated_by=?12
         WHERE code=?13`
      )
      .bind(
        input.name ?? current.name,
        input.description ?? current.description,
        input.priceAmount ?? current.price_amount,
        input.priceCurrency ?? current.price_currency,
        input.billingPeriod ?? current.billing_period,
        input.slaJson ?? current.sla_json,
        input.limitsJson ?? current.limits_json,
        input.status ?? current.status,
        input.classification ?? current.classification,
        current.version + 1,
        nowIso(),
        input.updatedBy,
        code
      )
      .run();
  }

  // --- Services / nodes / regions ---------------------------------------

  async getServiceByCode(code: string): Promise<ServiceRow | null> {
    const row = await this.db.prepare("SELECT * FROM services WHERE code = ?1").bind(code).first<ServiceRow>();
    return row ?? null;
  }

  async listServices(serviceType: ServiceType | undefined, limit: number, offset: number): Promise<ServiceRow[]> {
    const query = serviceType
      ? this.db.prepare("SELECT * FROM services WHERE service_type = ?1 ORDER BY code LIMIT ?2 OFFSET ?3").bind(serviceType, limit, offset)
      : this.db.prepare("SELECT * FROM services ORDER BY code LIMIT ?1 OFFSET ?2").bind(limit, offset);
    const { results } = await query.all<ServiceRow>();
    return results;
  }

  async createService(input: CreateServiceInput): Promise<ServiceRow> {
    const row: ServiceRow = {
      id: generateId(),
      code: input.code,
      service_type: input.serviceType,
      name: input.name,
      description: input.description ?? null,
      region: input.region ?? null,
      status: "operational",
      sla_json: input.slaJson ?? null,
      metadata_json: input.metadataJson ?? null,
      classification: input.classification,
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
        `INSERT INTO services (id, code, service_type, name, description, region, status, sla_json, metadata_json, classification, version, valid_from, valid_until, source_id, created_at, updated_at, created_by, updated_by)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)`
      )
      .bind(
        row.id, row.code, row.service_type, row.name, row.description, row.region, row.status, row.sla_json,
        row.metadata_json, row.classification, row.version, row.valid_from, row.valid_until, row.source_id,
        row.created_at, row.updated_at, row.created_by, row.updated_by
      )
      .run();
    return row;
  }

  async updateService(code: string, input: UpdateServiceInput): Promise<void> {
    const current = await this.getServiceByCode(code);
    if (!current) throw new Error(`Service not found: ${code}`);
    await this.db
      .prepare(
        `UPDATE services SET name=?1, description=?2, region=?3, status=?4, sla_json=?5, metadata_json=?6, classification=?7, version=?8, updated_at=?9, updated_by=?10
         WHERE code=?11`
      )
      .bind(
        input.name ?? current.name,
        input.description ?? current.description,
        input.region ?? current.region,
        input.status ?? current.status,
        input.slaJson ?? current.sla_json,
        input.metadataJson ?? current.metadata_json,
        input.classification ?? current.classification,
        current.version + 1,
        nowIso(),
        input.updatedBy,
        code
      )
      .run();
  }
}
