import { WorkerEntrypoint } from "cloudflare:workers";
import { buildServices, type Services } from "../api/services";
import { authenticateRpcCredential } from "../auth/authenticate";
import { runAuthenticatedOperation, type OperationAuthorization } from "../auth/pipeline";
import type { ResourceRef } from "../audit/audit";
import type { Principal } from "../auth/types";
import type { SearchDomain, SupportedLanguage } from "../config";
import type { Env } from "../env";
import type { FeedbackType } from "../db/rows";
import { enforceRateLimit } from "../security/rate-limit";
import { enforceQuota } from "../security/quota";
import { generateRequestId } from "../utils/ids";
import { throwRpcError } from "./errors";

/**
 * Every RPC method funnels through the same authenticate -> authorize ->
 * audit pipeline REST uses. `authorization` is the identical mandatory type,
 * so an RPC method cannot be added without an explicit authorization
 * decision -- the property that transport parity depends on (SR-001).
 */
async function withRpc<T>(
  env: Env,
  credential: unknown,
  authorization: OperationAuthorization,
  resource: ResourceRef | undefined,
  fn: (principal: Principal, services: Services) => Promise<T>
): Promise<T> {
  const requestId = generateRequestId();
  const services = buildServices(env);
  try {
    return await runAuthenticatedOperation({
      env,
      requestId,
      authorization,
      resource,
      authenticate: () => authenticateRpcCredential(credential, env),
      handler: (principal) => fn(principal, services)
    });
  } catch (error) {
    throwRpcError(error);
  }
}

/** Resource-scoped reads whose classification is unknown until the row is loaded. */
function deferredTo(enforcedBy: string, auditAction: string): OperationAuthorization {
  return { deferred: { auditAction, enforcedBy } };
}

export interface SearchKnowledgeRpcRequest {
  query: string;
  domain?: SearchDomain;
  language?: SupportedLanguage;
  limit?: number;
}

export interface SubmitFeedbackRpcRequest {
  sourceId: string;
  sourceType?: string;
  type: FeedbackType;
  message?: string;
}

/**
 * Internal Worker-to-Worker interface: a consuming Worker
 * declares a Service Binding to this Worker and calls these methods
 * directly, no HTTP hop. `credential` is `{agentKey, rpcKey}` -- Service
 * Bindings alone don't carry caller identity, so every method still goes
 * through the same authenticate -> authorize -> audit pipeline REST uses
 * (src/auth/pipeline.ts), just with the RPC credential path instead of an
 * Access JWT.
 */
export class KnowledgeCoreRpc extends WorkerEntrypoint<Env> {
  async searchKnowledge(credential: unknown, request: SearchKnowledgeRpcRequest) {
    return withRpc(this.env, credential, { enforce: { action: "knowledge.search" } }, undefined, async (principal, services) => {
      await enforceRateLimit(this.env, principal, "search");
      await enforceQuota(this.env, principal, "searches");
      return services.search.searchKnowledge(principal, request);
    });
  }

  async getFact(credential: unknown, namespace: string, key: string) {
    return withRpc(this.env, credential, deferredTo("FactsService.getFact", "facts.read"), { type: "fact", id: `${namespace}/${key}` }, async (principal, services) => {
      await enforceRateLimit(this.env, principal, "read");
      return services.facts.getFact(principal, namespace, key);
    });
  }

  async getFacts(credential: unknown, namespace: string, limit = 20, offset = 0) {
    return withRpc(this.env, credential, deferredTo("FactsService.getFacts", "facts.read"), { type: "fact_namespace", id: namespace }, async (principal, services) => {
      await enforceRateLimit(this.env, principal, "read");
      return services.facts.getFacts(principal, namespace, limit, offset);
    });
  }

  async getDocument(credential: unknown, idOrSlug: string, includeContent = false) {
    return withRpc(this.env, credential, deferredTo("DocumentsService.getDocument*", "documents.read"), { type: "document", id: idOrSlug }, async (principal, services) => {
      await enforceRateLimit(this.env, principal, "read");
      return includeContent
        ? services.documents.getDocumentContent(principal, idOrSlug)
        : services.documents.getDocumentMetadata(principal, idOrSlug);
    });
  }

  async getProduct(credential: unknown, code: string) {
    return withRpc(this.env, credential, { enforce: { action: "products.read" } }, { type: "product", id: code }, async (principal, services) => {
      await enforceRateLimit(this.env, principal, "read");
      return services.catalog.getProduct(principal, code);
    });
  }

  async getPlan(credential: unknown, code: string) {
    return withRpc(this.env, credential, { enforce: { action: "prices.read" } }, { type: "plan", id: code }, async (principal, services) => {
      await enforceRateLimit(this.env, principal, "read");
      return services.catalog.getPlan(principal, code);
    });
  }

  async getService(credential: unknown, code: string) {
    return withRpc(this.env, credential, deferredTo("CatalogService.getService", "network.read"), { type: "service", id: code }, async (principal, services) => {
      await enforceRateLimit(this.env, principal, "read");
      return services.catalog.getService(principal, code);
    });
  }

  async getNode(credential: unknown, code: string) {
    return withRpc(this.env, credential, deferredTo("CatalogService.getNode", "network.read"), { type: "node", id: code }, async (principal, services) => {
      await enforceRateLimit(this.env, principal, "read");
      return services.catalog.getNode(principal, code);
    });
  }

  async getPolicy(credential: unknown, code: string) {
    return withRpc(this.env, credential, deferredTo("PoliciesService.getPolicy", "facts.read"), { type: "policy", id: code }, async (principal, services) => {
      await enforceRateLimit(this.env, principal, "read");
      return services.policies.getPolicy(principal, code);
    });
  }

  async getIncident(credential: unknown, code: string) {
    return withRpc(this.env, credential, deferredTo("FactsService.getIncident", "facts.read"), { type: "incident", id: code }, async (principal, services) => {
      await enforceRateLimit(this.env, principal, "read");
      return services.facts.getIncident(principal, code);
    });
  }

  async getKnownIssue(credential: unknown, code: string) {
    return withRpc(this.env, credential, deferredTo("FactsService.getKnownIssue", "facts.read"), { type: "known_issue", id: code }, async (principal, services) => {
      await enforceRateLimit(this.env, principal, "read");
      return services.facts.getKnownIssue(principal, code);
    });
  }

  async submitFeedback(credential: unknown, request: SubmitFeedbackRpcRequest) {
    return withRpc(this.env, credential, { enforce: { action: "feedback.submit" } }, undefined, async (principal, services) => {
      await enforceRateLimit(this.env, principal, "read");
      return services.feedback.submit(principal, request);
    });
  }
}
