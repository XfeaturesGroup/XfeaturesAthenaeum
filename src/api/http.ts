import type { z } from "zod";
import { LIMITS } from "../config";
import { ApiError, ErrorCode } from "../utils/responses";

export async function readJsonBody<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
  maxBytes: number = LIMITS.REQUEST_JSON_MAX_BYTES
): Promise<z.infer<Schema>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ApiError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, "Expected application/json.");
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader && Number(contentLengthHeader) > maxBytes) {
    throw new ApiError(ErrorCode.PAYLOAD_TOO_LARGE, "Request body exceeds the size limit.");
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new ApiError(ErrorCode.PAYLOAD_TOO_LARGE, "Request body exceeds the size limit.");
  }

  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(ErrorCode.INVALID_REQUEST, "Malformed JSON body.");
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    throw new ApiError(ErrorCode.INVALID_REQUEST, "Request validation failed.", {
      issues: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    });
  }
  return result.data;
}

export function parseQuery<Schema extends z.ZodType>(url: URL, schema: Schema): z.infer<Schema> {
  const raw = Object.fromEntries(url.searchParams.entries());
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ApiError(ErrorCode.INVALID_REQUEST, "Query parameter validation failed.", {
      issues: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    });
  }
  return result.data;
}

export interface UploadCandidateFile {
  filename: string;
  mimeType: string;
  bytes: ArrayBuffer;
}

/** Multipart upload with a `file` part and a `metadata` JSON part. */
export async function readMultipartUpload<Schema extends z.ZodType>(
  request: Request,
  metadataSchema: Schema
): Promise<{ file: UploadCandidateFile; metadata: z.infer<Schema> }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw new ApiError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, "Expected multipart/form-data.");
  }

  // SR-014: `request.formData()` buffers the entire body into isolate memory
  // before any per-part size is observable, so the size gate has to happen
  // BEFORE that call. A missing or unparseable Content-Length is therefore
  // rejected outright rather than trusted -- otherwise an attacker could omit
  // the header and stream an arbitrarily large body straight into memory.
  const contentLengthHeader = request.headers.get("content-length");
  const declaredLength = contentLengthHeader === null ? Number.NaN : Number(contentLengthHeader);
  if (!Number.isFinite(declaredLength) || declaredLength < 0) {
    throw new ApiError(ErrorCode.INVALID_REQUEST, "A valid Content-Length is required for uploads.");
  }
  if (declaredLength > LIMITS.UPLOAD_MAX_BYTES) {
    throw new ApiError(ErrorCode.PAYLOAD_TOO_LARGE, "Upload exceeds the size limit.");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ApiError(ErrorCode.INVALID_REQUEST, "Malformed multipart body.");
  }

  const filePart = form.get("file");
  if (!(filePart instanceof File)) {
    throw new ApiError(ErrorCode.INVALID_REQUEST, "Missing 'file' part.");
  }
  const metadataPart = form.get("metadata");
  if (typeof metadataPart !== "string") {
    throw new ApiError(ErrorCode.INVALID_REQUEST, "Missing 'metadata' part.");
  }

  let metadataJson: unknown;
  try {
    metadataJson = JSON.parse(metadataPart);
  } catch {
    throw new ApiError(ErrorCode.INVALID_REQUEST, "'metadata' part is not valid JSON.");
  }
  const metadataResult = metadataSchema.safeParse(metadataJson);
  if (!metadataResult.success) {
    throw new ApiError(ErrorCode.INVALID_REQUEST, "Upload metadata validation failed.", {
      issues: metadataResult.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    });
  }

  if (filePart.size > LIMITS.UPLOAD_MAX_BYTES) {
    throw new ApiError(ErrorCode.PAYLOAD_TOO_LARGE, "Upload exceeds the size limit.");
  }

  return {
    file: { filename: filePart.name, mimeType: filePart.type, bytes: await filePart.arrayBuffer() },
    metadata: metadataResult.data
  };
}
