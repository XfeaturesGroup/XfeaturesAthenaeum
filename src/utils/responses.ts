export const ErrorCode = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  INVALID_REQUEST: "INVALID_REQUEST",
  RATE_LIMITED: "RATE_LIMITED",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  CONFLICT: "CONFLICT",
  STALE_VERSION: "STALE_VERSION",
  INGESTION_FAILED: "INGESTION_FAILED",
  DEPENDENCY_UNAVAILABLE: "DEPENDENCY_UNAVAILABLE",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  INTERNAL_ERROR: "INTERNAL_ERROR"
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429,
  CONFLICT: 409,
  STALE_VERSION: 409,
  INGESTION_FAILED: 422,
  DEPENDENCY_UNAVAILABLE: 503,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  METHOD_NOT_ALLOWED: 405,
  INTERNAL_ERROR: 500
};

export class ApiError extends Error {
  /** True reason. Drives audit and internal control flow -- never necessarily what the client sees. */
  readonly code: ErrorCode;
  /**
   * Code actually returned to the client. Differs from `code` only when the
   * true reason must not be disclosed -- specifically an authorization denial
   * on a resource that was found, which is reported as NOT_FOUND so a caller
   * cannot use 403-vs-404 to probe for the existence of restricted resources
   * (SR-009).
   */
  readonly publicCode: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>, publicCode?: ErrorCode) {
    super(message);
    this.code = code;
    this.publicCode = publicCode ?? code;
    this.details = details;
  }
}

/**
 * Standard error envelope. Never includes stack traces, SQL errors, or
 * provider responses -- those go to the (protected) structured logs only.
 */
export function errorResponse(error: ApiError, requestId: string, extraHeaders?: HeadersInit): Response {
  const status = STATUS_BY_CODE[error.publicCode];
  return jsonResponse(
    {
      error: {
        code: error.publicCode,
        message: error.message,
        request_id: requestId
      }
    },
    status,
    extraHeaders
  );
}

export function jsonResponse(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(body), { status, headers });
}
