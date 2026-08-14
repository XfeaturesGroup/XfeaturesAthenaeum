/**
 * Client-facing types for Xfeatures Athenaeum's REST API.
 *
 * Mirrors `src/knowledge/dto.ts` and `src/api/schemas/*` in the Worker
 * (`xfeatures-athenaeum`) at the time of writing. Hand-authored, not
 * generated, because there is no OpenAPI-to-TS pipeline wired up yet
 * (`docs/openapi.yaml` exists but nothing consumes it) -- keep this file in
 * sync by hand when those change, not by assuming the two drift together.
 */

export type Classification = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";

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

// --- Request bodies -----------------------------------------------------

export interface SearchRequest {
  query: string;
  domain?: string;
  language?: string;
  limit?: number;
}

export interface FeedbackRequest {
  source_id: string;
  source_type?: string;
  type: "incorrect" | "outdated" | "missing" | "irrelevant" | "conflicting";
  message?: string;
}

/** Matches createDocumentMetadataSchema; `content`/`format` are SDK-level, sent as the multipart file part. */
export interface ProposeDocumentRequest {
  slug: string;
  title: string;
  domain: string;
  category?: string;
  classification: Classification;
  language: string;
  content: string;
  format?: "markdown" | "text" | "json" | "html";
  source_type?: string;
  source_reference?: string;
}

// --- Response envelopes --------------------------------------------------
// Every REST response includes `request_id`; every REST error follows
// ApiErrorPayload (src/utils/responses.ts's errorResponse).

export interface ApiErrorPayload {
  code: string;
  message: string;
  request_id: string;
}

export interface SearchResponse {
  request_id: string;
  results: SearchResultDTO[];
  reason?: "NO_RELIABLE_MATCH";
}

export interface FactResponse {
  request_id: string;
  fact: FactDTO;
}

export interface FactsListResponse {
  request_id: string;
  facts: FactDTO[];
  limit: number;
  offset: number;
}

export interface DocumentResponse<T extends DocumentDTO = DocumentDTO> {
  request_id: string;
  document: T;
}

export interface ProductResponse {
  request_id: string;
  product: ProductDTO;
}

export interface PlanResponse {
  request_id: string;
  plan: PlanDTO;
}

export interface PolicyResponse {
  request_id: string;
  policy: PolicyDTO;
}

export interface DocumentDraftResponse {
  request_id: string;
  document: DocumentDTO;
}

export interface SubmitForReviewResponse {
  request_id: string;
  submission: { document_id: string; workflow_instance_id: string };
}
