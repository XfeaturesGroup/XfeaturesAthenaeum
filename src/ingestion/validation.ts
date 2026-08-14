import { ALLOWED_UPLOAD_EXTENSIONS, ALLOWED_UPLOAD_MIME_TYPES, LIMITS } from "../config";
import { ApiError, ErrorCode } from "../utils/responses";

export interface UploadCandidate {
  filename: string;
  mimeType: string;
  size: number;
}

/**
 * Validates an upload before it ever touches R2. Filename is
 * used only for extension/display validation -- it is never used to build
 * the storage key (see buildDocumentR2Key).
 */
export function validateUploadCandidate(candidate: UploadCandidate): void {
  if (candidate.filename.length === 0 || candidate.filename.length > LIMITS.FILENAME_MAX_LENGTH) {
    throw new ApiError(ErrorCode.INVALID_REQUEST, "Filename length is invalid.");
  }
  if (candidate.filename.includes("..") || candidate.filename.includes("/") || candidate.filename.includes("\\")) {
    throw new ApiError(ErrorCode.INVALID_REQUEST, "Filename contains disallowed path characters.");
  }

  const extMatch = /\.[a-z0-9]+$/i.exec(candidate.filename);
  const extension = extMatch ? extMatch[0].toLowerCase() : "";
  if (!ALLOWED_UPLOAD_EXTENSIONS.has(extension)) {
    throw new ApiError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, `File extension not allowed: ${extension}`);
  }
  if (!ALLOWED_UPLOAD_MIME_TYPES.has(candidate.mimeType)) {
    throw new ApiError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, `MIME type not allowed: ${candidate.mimeType}`);
  }

  if (candidate.size <= 0) {
    throw new ApiError(ErrorCode.INVALID_REQUEST, "Uploaded file is empty.");
  }
  if (candidate.size > LIMITS.UPLOAD_MAX_BYTES) {
    throw new ApiError(ErrorCode.PAYLOAD_TOO_LARGE, `File exceeds the ${String(LIMITS.UPLOAD_MAX_BYTES)} byte limit.`);
  }
}
