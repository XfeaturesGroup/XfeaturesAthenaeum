import type { Classification } from "../security/classification";
import { generateId } from "../utils/ids";

/**
 * Custom metadata written on every stored document object.
 *
 * Only the five attributes declared in AI_SEARCH_CUSTOM_METADATA_SCHEMA
 * (`document_id`, `classification`, `domain`, `language`, `status`) are
 * extracted into the search index and usable in a retrieval filter -- AI
 * Search caps an instance at five custom attributes. The remaining fields are
 * carried for operator legibility when browsing the bucket directly; nothing
 * reads them back for authorization or for citations.
 *
 * `tests/security/index-metadata-contract.test.ts` asserts every declared
 * attribute is actually written here, so the filter can never reference an
 * attribute the objects do not carry.
 */
export interface DocumentR2Metadata {
  document_id: string;
  classification: Classification;
  domain: string;
  title: string;
  version: string;
  language: string;
  status: string;
  updated_at: string;
}

export interface DocumentStorage {
  put(key: string, content: ArrayBuffer, contentType: string, metadata: DocumentR2Metadata): Promise<void>;
  updateMetadata(key: string, metadata: DocumentR2Metadata): Promise<void>;
  get(key: string): Promise<ReadableStream | null>;
  delete(key: string): Promise<void>;
}

/**
 * R2 keys are server-generated, never derived from a caller-supplied
 * filename (No path traversal via `../../secret`, no user
 * filenames as keys). The classification/domain segments are for human
 * browsing only -- they are NOT the security boundary. The security boundary
 * is the `documents.classification` column in D1, checked by authorize() on
 * every read; R2 object keys are never guessable-but-secret and objects are
 * never served by a public R2 URL.
 */
/**
 * The indexer decides how to parse an object from its key's extension, and
 * skips anything it does not recognise. A key ending in `.bin` therefore
 * stores the document perfectly and indexes none of it, so the extension is
 * derived from the validated content type rather than fixed.
 *
 * Only content types this project already accepts on upload appear here
 * (see ALLOWED_UPLOAD_MIME_TYPES); an unrecognised type falls back to `.txt`,
 * which the indexer reads as plain text, rather than to an extension it would
 * silently skip.
 *
 * https://developers.cloudflare.com/ai-search/configuration/data-source/#supported-file-types
 */
const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "text/markdown": "md",
  "text/plain": "txt",
  "application/json": "json",
  "text/html": "html"
};

export function documentR2Extension(contentType: string): string {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return EXTENSION_BY_CONTENT_TYPE[normalized] ?? "txt";
}

export function buildDocumentR2Key(
  classification: Classification,
  domain: string,
  documentId: string,
  version: number,
  contentType: string
): string {
  const safeDomain = domain.replace(/[^a-z0-9-]/gi, "_").toLowerCase();
  const extension = documentR2Extension(contentType);
  return `knowledge/${classification.toLowerCase()}/${safeDomain}/${documentId}/v${String(version)}.${extension}`;
}

function toCustomMetadata(metadata: DocumentR2Metadata): Record<string, string> {
  return { ...metadata };
}

export class R2DocumentStorage implements DocumentStorage {
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, content: ArrayBuffer, contentType: string, metadata: DocumentR2Metadata): Promise<void> {
    await this.bucket.put(key, content, {
      httpMetadata: { contentType },
      customMetadata: toCustomMetadata(metadata)
    });
  }

  /** Re-indexing/status changes don't always change the bytes -- avoid re-uploading content just to update metadata. */
  async updateMetadata(key: string, metadata: DocumentR2Metadata): Promise<void> {
    const object = await this.bucket.get(key);
    if (!object) return;
    const content = await object.arrayBuffer();
    await this.bucket.put(key, content, {
      httpMetadata: { contentType: object.httpMetadata?.contentType ?? "text/plain" },
      customMetadata: toCustomMetadata(metadata)
    });
  }

  async get(key: string): Promise<ReadableStream | null> {
    const object = await this.bucket.get(key);
    return object?.body ?? null;
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}

export function generateUploadStagingId(): string {
  return generateId();
}
