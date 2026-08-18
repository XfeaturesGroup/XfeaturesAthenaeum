/** Client-facing shapes. Internal-only DB columns (audit ids, row ids used only for joins) are never included. */
import type { DocumentStatusView } from "../db/rows";
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
  status: DocumentStatusView;
  version: number;
  updatedAt: string;
  sourceReference: string | null;
}

export interface DocumentContentDTO extends DocumentDTO {
  content: string;
  contentType: string;
}

/**
 * A document in the trash, with the one thing the operator actually needs:
 * how long is left. The remaining time is computed server-side from the
 * retention window rather than left for each client to work out, so the console
 * and the API can never disagree about when something expires.
 */
export interface TrashedDocumentDTO extends DocumentDTO {
  trashedAt: string;
  /** The state a restore returns it to. */
  statusBeforeTrash: string;
  /** ISO timestamp at which this becomes eligible for purge. */
  purgeableAt: string;
  /** Whole minutes remaining; 0 once the window has closed. */
  minutesRemaining: number;
}

/**
 * One entry in a document's history. Deliberately carries no R2 key: an
 * operator picking a version to restore needs to recognise it, not to be handed
 * a storage path they could fetch around the authorization layer with.
 */
export interface DocumentVersionDTO {
  version: number;
  title: string;
  classification: Classification;
  status: string;
  changeNote: string | null;
  contentHash: string;
  createdAt: string;
  createdBy: string | null;
  isCurrent: boolean;
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
