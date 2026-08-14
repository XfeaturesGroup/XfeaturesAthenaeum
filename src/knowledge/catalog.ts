import { assertAuthorized, assertAuthorizedOrNotFound } from "../auth/authorize";
import type { Principal } from "../auth/types";
import type { PlanRow, ProductRow, ServiceRow, ServiceType } from "../db/rows";
import type { CatalogRepository } from "../repositories/catalog.repository";
import { isWithinValidityWindow } from "../utils/time";
import { ApiError, ErrorCode } from "../utils/responses";
import type { PlanDTO, ProductDTO, ServiceDTO } from "./dto";

function productToDTO(row: ProductRow): ProductDTO {
  return {
    code: row.code,
    name: row.name,
    description: row.description,
    category: row.category,
    region: row.region,
    status: row.status,
    classification: row.classification,
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as unknown) : null,
    version: row.version,
    updatedAt: row.updated_at
  };
}

function planToDTO(row: PlanRow, productCode: string | null): PlanDTO {
  return {
    code: row.code,
    productCode,
    name: row.name,
    description: row.description,
    priceAmount: row.price_amount,
    priceCurrency: row.price_currency,
    billingPeriod: row.billing_period,
    sla: row.sla_json ? (JSON.parse(row.sla_json) as unknown) : null,
    limits: row.limits_json ? (JSON.parse(row.limits_json) as unknown) : null,
    status: row.status,
    classification: row.classification,
    version: row.version,
    updatedAt: row.updated_at
  };
}

function serviceToDTO(row: ServiceRow): ServiceDTO {
  return {
    code: row.code,
    serviceType: row.service_type,
    name: row.name,
    description: row.description,
    region: row.region,
    status: row.status,
    sla: row.sla_json ? (JSON.parse(row.sla_json) as unknown) : null,
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as unknown) : null,
    classification: row.classification,
    version: row.version,
    updatedAt: row.updated_at
  };
}

/** Deterministic catalog lookups: products, plans, services/nodes/regions. */
export class CatalogService {
  constructor(private readonly repo: CatalogRepository) {}

  async getProduct(principal: Principal, code: string): Promise<ProductDTO> {
    assertAuthorized(principal, { action: "products.read" });
    const row = await this.repo.getProductByCode(code);
    if (!row || !isWithinValidityWindow(row.valid_from, row.valid_until)) {
      throw new ApiError(ErrorCode.NOT_FOUND, "Product not found.");
    }
    assertAuthorizedOrNotFound(
      principal,
      { action: "facts.read", resource: { namespace: "products", classification: row.classification } },
      "Product not found."
    );
    return productToDTO(row);
  }

  async getPlan(principal: Principal, code: string): Promise<PlanDTO> {
    assertAuthorized(principal, { action: "prices.read" });
    const row = await this.repo.getPlanByCode(code);
    if (!row || !isWithinValidityWindow(row.valid_from, row.valid_until)) {
      throw new ApiError(ErrorCode.NOT_FOUND, "Plan not found.");
    }
    assertAuthorizedOrNotFound(
      principal,
      { action: "facts.read", resource: { namespace: "plans", classification: row.classification } },
      "Plan not found."
    );

    let productCode: string | null = null;
    if (row.product_id) {
      const product = await this.repo.getProductById(row.product_id);
      productCode = product?.code ?? null;
    }
    return planToDTO(row, productCode);
  }

  async getService(principal: Principal, code: string): Promise<ServiceDTO> {
    const row = await this.repo.getServiceByCode(code);
    if (!row || !isWithinValidityWindow(row.valid_from, row.valid_until)) {
      throw new ApiError(ErrorCode.NOT_FOUND, "Service not found.");
    }
    assertAuthorizedOrNotFound(
      principal,
      { action: row.classification === "RESTRICTED" ? "network.restricted.read" : "network.read" },
      "Service not found."
    );
    assertAuthorizedOrNotFound(
      principal,
      { action: "facts.read", resource: { namespace: "services", classification: row.classification } },
      "Service not found."
    );
    return serviceToDTO(row);
  }

  /** getNode(): a `service_type = "node"` service, same authorization path as getService. */
  async getNode(principal: Principal, code: string): Promise<ServiceDTO> {
    const dto = await this.getService(principal, code);
    if (dto.serviceType !== ("node" satisfies ServiceType)) {
      throw new ApiError(ErrorCode.NOT_FOUND, "Node not found.");
    }
    return dto;
  }
}
