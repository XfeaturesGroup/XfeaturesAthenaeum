import { handleMcpRequest } from "../../mcp/server";
import { Router, type RouteContext } from "../router";
import {
  handleSetAgentStatus,
  handleSetAgentQuota,
  handleCreateAgent,
  handleListAgents,
  handleGetAgent,
  handleAssignAgentRole,
  handleUnassignAgentRole
} from "./admin/agents";
import { handleApproveFactProposal, handleListFactProposals, handleRejectFactProposal } from "./admin/fact-proposals";
import { handleListRoles } from "./admin/roles";
import { handleListAuditEvents } from "./admin/audit";
import {
  handleCreateDocumentDraft,
  handleListDocuments,
  handleGetDocumentForAdmin,
  handleCreateDocumentVersion,
  handleListDocumentVersions,
  handleTrashDocument,
  handleRestoreDocument,
  handleListTrash,
  handleReviewDecision,
  handleRollbackDocument,
  handleSubmitForReview,
  handleTransitionDocumentStatus
} from "./admin/documents";
import {
  handleCreateFact,
  handleDeprecateFact,
  handleListFactTrash,
  handleListFactVersions,
  handleListFactsForAdmin,
  handleRestoreFact,
  handleRollbackFact,
  handleTrashFact,
  handleUpdateFact
} from "./admin/facts";
import { handleListIngestionJobs, handleReindexAll, handleReindexDocument } from "./admin/ingestion";
import { handleGetDocument } from "./documents";
import { handleListFacts, handleGetFact, handleListFactNamespaces } from "./facts";
import { handleSubmitFeedback } from "./feedback";
import { handleDependencyHealth, handleHealth } from "./health";
import { handleGetPolicy } from "./policies";
import { handleGetPlan, handleGetProduct } from "./products";
import { handleSearch } from "./search";
import { handleOpenAiAppsChallenge, handleProtectedResourceMetadata } from "./well-known";

export function buildRouter(): Router {
  const router = new Router();

  router.get("/health", handleHealth);
  router.get("/v1/admin/health/dependencies", handleDependencyHealth);
  router.get("/.well-known/oauth-protected-resource", handleProtectedResourceMetadata);
  router.get("/.well-known/openai-apps-challenge", handleOpenAiAppsChallenge);

  router.post("/v1/knowledge/search", handleSearch);

  router.get("/v1/facts", handleListFactNamespaces);
  router.get("/v1/facts/:namespace", handleListFacts);
  router.get("/v1/facts/:namespace/:key", handleGetFact);

  router.get("/v1/documents/:id", handleGetDocument);

  router.get("/v1/products/:code", handleGetProduct);
  router.get("/v1/plans/:code", handleGetPlan);

  router.get("/v1/policies/:code", handleGetPolicy);

  router.post("/v1/feedback", handleSubmitFeedback);

  // --- Admin surface (logically distinct from read-only routes) ---
  router.get("/v1/admin/facts", handleListFactsForAdmin);
  router.post("/v1/admin/facts", handleCreateFact);
  // `trash` is a view, not a namespace: this path has one segment where
  // :namespace/:key has two, so the two patterns cannot collide.
  router.get("/v1/admin/facts/trash", handleListFactTrash);
  router.patch("/v1/admin/facts/:namespace/:key", handleUpdateFact);
  router.delete("/v1/admin/facts/:namespace/:key", handleDeprecateFact);
  router.get("/v1/admin/facts/:namespace/:key/versions", handleListFactVersions);
  router.post("/v1/admin/facts/:namespace/:key/rollback", handleRollbackFact);
  router.post("/v1/admin/facts/:namespace/:key/trash", handleTrashFact);
  router.post("/v1/admin/facts/:namespace/:key/restore", handleRestoreFact);

  // The review queue for facts proposed over MCP. Nothing an agent proposes
  // changes what the platform answers until one of these approves it.
  router.get("/v1/admin/fact-proposals", handleListFactProposals);
  router.post("/v1/admin/fact-proposals/:id/approve", handleApproveFactProposal);
  router.post("/v1/admin/fact-proposals/:id/reject", handleRejectFactProposal);

  router.get("/v1/admin/documents", handleListDocuments);
  router.get("/v1/admin/documents/:id", handleGetDocumentForAdmin);
  router.post("/v1/admin/documents", handleCreateDocumentDraft);
  router.get("/v1/admin/documents/:id/versions", handleListDocumentVersions);
  // Deliberately not under /v1/admin/documents/: a literal segment there
  // would be shadowed by the :id route depending on registration order.
  router.get("/v1/admin/trash", handleListTrash);
  router.post("/v1/admin/documents/:id/trash", handleTrashDocument);
  router.post("/v1/admin/documents/:id/restore", handleRestoreDocument);
  router.post("/v1/admin/documents/:id/versions", handleCreateDocumentVersion);
  router.patch("/v1/admin/documents/:id/status", handleTransitionDocumentStatus);
  router.post("/v1/admin/documents/:id/submit-for-review", handleSubmitForReview);
  router.post("/v1/admin/documents/:id/review-decision", handleReviewDecision);
  router.post("/v1/admin/documents/:id/rollback", handleRollbackDocument);

  router.post("/v1/admin/agents", handleCreateAgent);
  router.get("/v1/admin/agents", handleListAgents);
  router.get("/v1/admin/agents/:id", handleGetAgent);
  router.patch("/v1/admin/agents/:id/status", handleSetAgentStatus);
  router.patch("/v1/admin/agents/:id/quota", handleSetAgentQuota);
  router.post("/v1/admin/agents/:id/roles", handleAssignAgentRole);
  router.delete("/v1/admin/agents/:id/roles/:role", handleUnassignAgentRole);

  router.get("/v1/admin/roles", handleListRoles);

  router.get("/v1/admin/ingestion", handleListIngestionJobs);
  router.post("/v1/admin/ingestion/:id/reindex", handleReindexDocument);
  router.post("/v1/admin/ingestion/reindex-all", handleReindexAll);

  router.get("/v1/admin/audit", handleListAuditEvents);

  // MCP: Streamable HTTP, stateless. The transport itself
  // decides what each method means; we just need every method it might see
  // routed to the same handler instead of bouncing off our own 405 check.
  const mcpHandler = (request: Request, ctx: RouteContext): Promise<Response> => handleMcpRequest(request, ctx.env);
  router.post("/mcp", mcpHandler);
  router.get("/mcp", mcpHandler);
  router.delete("/mcp", mcpHandler);

  return router;
}
