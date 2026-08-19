/** Client-facing shapes. Internal-only DB columns (audit ids, row ids used only for joins) are never included. */
import type { Classification } from "../security/classification";

export interface FactDTO {
  namespace: string;
  key: string;
  version: number;
  value: unknown;
  title: string | null;
  description: string | null;
  classification: Classification;
  status: string;
  validFrom: string | null;
  validUntil: string | null;
  updatedAt: string;
  sourceId: string | null;
}

export interface DocumentDTO {
  id: string;
  slug: string;
  title: string;
  domain: string;
  category: string | null;
  classification: Classification;
  language: string;
  status: string;
  version: number;
  updatedAt: string;
  sourceReference: string | null;
}

export interface DocumentContentDTO extends DocumentDTO {
  content: string;
  contentType: string;
}

export interface ProductDTO {
  code: string;
  name: string;
  description: string | null;
  category: string | null;
  region: string | null;
  status: string;
  classification: Classification;
  metadata: unknown;
  version: number;
  updatedAt: string;
}

export interface PlanDTO {
  code: string;
  productCode: string | null;
  name: string;
  description: string | null;
  priceAmount: number | null;
  priceCurrency: string | null;
  billingPeriod: string | null;
  sla: unknown;
  limits: unknown;
  status: string;
  classification: Classification;
  version: number;
  updatedAt: string;
}

export interface ServiceDTO {
  code: string;
  serviceType: string;
  name: string;
  description: string | null;
  region: string | null;
  status: string;
  sla: unknown;
  metadata: unknown;
  classification: Classification;
  version: number;
  updatedAt: string;
}

export interface PolicyDTO {
  code: string;
  title: string;
  bodyMarkdown: string | null;
  documentId: string | null;
  classification: Classification;
  status: string;
  version: number;
  updatedAt: string;
}

export interface SearchResultDTO {
  type: "document_chunk" | "fact";
  sourceId: string;
  documentId: string | null;
  title: string;
  content: string;
  section: string | null;
  classification: Classification;
  version: number | null;
  updatedAt: string | null;
  score: number;
}
