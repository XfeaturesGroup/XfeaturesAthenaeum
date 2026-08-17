import type {
  ApiErrorPayload,
  DocumentContentDTO,
  DocumentDTO,
  FactDTO,
  FactsListResponse,
  FeedbackRequest,
  PlanDTO,
  PolicyDTO,
  ProductDTO,
  ProposeDocumentRequest,
  SearchRequest,
  SearchResponse
} from "@xfeatures/athenaeum-types";

export type {
  ApiErrorPayload,
  Classification,
  DocumentContentDTO,
  DocumentDTO,
  FactDTO,
  FactsListResponse,
  FeedbackRequest,
  PlanDTO,
  PolicyDTO,
  ProductDTO,
  ProposeDocumentRequest,
  SearchRequest,
  SearchResponse,
  SearchResultDTO
} from "@xfeatures/athenaeum-types";

/**
 * Thrown for every non-2xx response. Carries the same envelope Athenaeum
 * itself returns (`{error: {code, message, request_id}}`) rather than a
 * generic HTTP error, so callers can branch on `code` the same way the
 * Worker's own routes do.
 */
export class AthenaeumApiError extends Error {
  readonly code: string;
  readonly requestId: string;
  readonly status: number;

  constructor(payload: ApiErrorPayload, status: number) {
    super(payload.message);
    this.name = "AthenaeumApiError";
    this.code = payload.code;
    this.requestId = payload.request_id;
    this.status = status;
  }
}

export interface AthenaeumClientOptions {
  /** e.g. "https://athenaeum.xfeatures.net" -- no trailing slash. */
  baseUrl: string;
  /**
   * A bearer token: an Xfeatures Account access token (client_credentials for
   * a service application, or a human's own login via the Developer Access
   * application -- see docs/AGENT-INTEGRATION.md in xfeatures-athenaeum).
   * Athenaeum's own D1 still decides what this identity can do; the token
   * only proves who is asking.
   */
  token: string;
  /** Injectable for tests; defaults to the platform global. */
  fetch?: typeof fetch;
}

/**
 * REST client for Xfeatures Athenaeum. Deliberately thin: one method per
 * endpoint, no retry/caching logic (Athenaeum itself is the single source of
 * truth on every call -- Section 8/17 in the ecosystem ADR), and every error
 * surfaces as `AthenaeumApiError` rather than being swallowed.
 */
export class AthenaeumClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AthenaeumClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    if (init.body && !headers.has("content-type") && typeof init.body === "string") {
      headers.set("content-type", "application/json");
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    const text = await response.text();
    let json: unknown;
    try {
      json = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Athenaeum returned a non-JSON response (HTTP ${String(response.status)}) for ${path}.`);
    }

    if (!response.ok) {
      const errorBody = json as { error?: ApiErrorPayload };
      if (errorBody.error) {
        throw new AthenaeumApiError(errorBody.error, response.status);
      }
      throw new Error(`Athenaeum request to ${path} failed with HTTP ${String(response.status)}.`);
    }

    return json as T;
  }

  /** Semantic search. Prefer the deterministic getters below when you know exactly what you need. */
  async search(body: SearchRequest): Promise<SearchResponse> {
    return this.request<SearchResponse>("/v1/knowledge/search", { method: "POST", body: JSON.stringify(body) });
  }

  async getFact(namespace: string, key: string): Promise<FactDTO> {
    const res = await this.request<{ fact: FactDTO }>(`/v1/facts/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`);
    return res.fact;
  }

  async listFacts(namespace: string, options: { limit?: number; offset?: number } = {}): Promise<FactsListResponse> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.offset !== undefined) params.set("offset", String(options.offset));
    const qs = params.toString();
    return this.request<FactsListResponse>(`/v1/facts/${encodeURIComponent(namespace)}${qs ? `?${qs}` : ""}`);
  }

  async getDocument(idOrSlug: string, options: { includeContent?: boolean } = {}): Promise<DocumentDTO | DocumentContentDTO> {
    const qs = options.includeContent ? "?include=content" : "";
    const res = await this.request<{ document: DocumentDTO | DocumentContentDTO }>(`/v1/documents/${encodeURIComponent(idOrSlug)}${qs}`);
    return res.document;
  }

  async getProduct(code: string): Promise<ProductDTO> {
    const res = await this.request<{ product: ProductDTO }>(`/v1/products/${encodeURIComponent(code)}`);
    return res.product;
  }

  async getPlan(code: string): Promise<PlanDTO> {
    const res = await this.request<{ plan: PlanDTO }>(`/v1/plans/${encodeURIComponent(code)}`);
    return res.plan;
  }

  async getPolicy(code: string): Promise<PolicyDTO> {
    const res = await this.request<{ policy: PolicyDTO }>(`/v1/policies/${encodeURIComponent(code)}`);
    return res.policy;
  }

  async submitFeedback(body: FeedbackRequest): Promise<void> {
    await this.request<unknown>("/v1/feedback", { method: "POST", body: JSON.stringify(body) });
  }

  /**
   * Creates a DRAFT document. Requires `documents.write` (and `admin.documents`
   * at the route gate) -- e.g. the `content-contributor` role. Never
   * publishes: the returned document is invisible to search/getDocument until
   * a human approves it via `submitDocumentForReview` + HQ (human-in-the-loop
   * publish, mirroring the MCP tools of the same name).
   */
  async proposeDocument(input: ProposeDocumentRequest): Promise<DocumentDTO> {
    const format = input.format ?? "markdown";
    const contentType = { markdown: "text/markdown", text: "text/plain", json: "application/json", html: "text/html" }[format];
    const extension = { markdown: "md", text: "txt", json: "json", html: "html" }[format];

    const metadata = {
      slug: input.slug,
      title: input.title,
      domain: input.domain,
      category: input.category,
      classification: input.classification,
      language: input.language,
      source_type: input.source_type,
      source_reference: input.source_reference
    };

    const form = new FormData();
    form.set("metadata", JSON.stringify(metadata));
    form.set("file", new Blob([input.content], { type: contentType }), `${input.slug}.${extension}`);

    const headers = new Headers({ authorization: `Bearer ${this.token}` });
    const response = await this.fetchImpl(`${this.baseUrl}/v1/admin/documents`, { method: "POST", headers, body: form });
    const text = await response.text();
    const json = text.length > 0 ? (JSON.parse(text) as { document?: DocumentDTO; error?: ApiErrorPayload }) : {};
    if (!response.ok) {
      if (json.error) throw new AthenaeumApiError(json.error, response.status);
      throw new Error(`Athenaeum rejected the document proposal (HTTP ${String(response.status)}).`);
    }
    if (!json.document) throw new Error("Athenaeum returned no document in a successful proposal response.");
    return json.document;
  }

  /** Hands a draft to a human reviewer. Never publishes it -- see proposeDocument. */
  async submitDocumentForReview(documentId: string): Promise<{ documentId: string; workflowInstanceId: string }> {
    const res = await this.request<{ submission: { document_id: string; workflow_instance_id: string } }>(
      `/v1/admin/documents/${encodeURIComponent(documentId)}/submit-for-review`,
      { method: "POST", body: JSON.stringify({}) }
    );
    return { documentId: res.submission.document_id, workflowInstanceId: res.submission.workflow_instance_id };
  }
}
