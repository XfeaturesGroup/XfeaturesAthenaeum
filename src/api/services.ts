import type { Env } from "../env";
import { CatalogService } from "../knowledge/catalog";
import { DocumentsService } from "../knowledge/documents";
import { FactsService } from "../knowledge/facts";
import { FeedbackService } from "../knowledge/feedback";
import { PoliciesService } from "../knowledge/policies";
import { SearchService } from "../knowledge/search";
import { AgentsRepository } from "../repositories/agents.repository";
import { AuditRepository } from "../repositories/audit.repository";
import { CatalogRepository } from "../repositories/catalog.repository";
import { DocumentsRepository } from "../repositories/documents.repository";
import { FactsRepository } from "../repositories/facts.repository";
import { FeedbackRepository } from "../repositories/feedback.repository";
import { IngestionRepository } from "../repositories/ingestion.repository";
import { PoliciesRepository } from "../repositories/policies.repository";
import { QuotaRepository } from "../repositories/quota.repository";
import { RolesRepository } from "../repositories/roles.repository";
import { SourcesRepository } from "../repositories/sources.repository";
import { AiSearchProvider } from "../search/ai-search";
import { R2DocumentStorage } from "../storage/r2";

/**
 * Everything is instantiated fresh per request -- repositories only close
 * over `env.DB`/`env.DOCS`, so there is no shared mutable state across
 * requests within an isolate -- there are no request-scoped mutable globals.
 */
export interface Services {
  facts: FactsService;
  documents: DocumentsService;
  catalog: CatalogService;
  policies: PoliciesService;
  search: SearchService;
  feedback: FeedbackService;

  agentsRepo: AgentsRepository;
  rolesRepo: RolesRepository;
  auditRepo: AuditRepository;
  ingestionRepo: IngestionRepository;
  sourcesRepo: SourcesRepository;
  catalogRepo: CatalogRepository;
  documentsRepo: DocumentsRepository;
  factsRepo: FactsRepository;
  policiesRepo: PoliciesRepository;
  feedbackRepo: FeedbackRepository;
  quotaRepo: QuotaRepository;
}

export function buildServices(env: Env): Services {
  const factsRepo = new FactsRepository(env.DB);
  const documentsRepo = new DocumentsRepository(env.DB);
  const catalogRepo = new CatalogRepository(env.DB);
  const policiesRepo = new PoliciesRepository(env.DB);
  const feedbackRepo = new FeedbackRepository(env.DB);
  const ingestionRepo = new IngestionRepository(env.DB);
  const agentsRepo = new AgentsRepository(env.DB);
  const rolesRepo = new RolesRepository(env.DB);
  const auditRepo = new AuditRepository(env.DB);
  const sourcesRepo = new SourcesRepository(env.DB);
  const quotaRepo = new QuotaRepository(env.DB);

  const storage = new R2DocumentStorage(env.DOCS);
  const searchProvider = new AiSearchProvider(env);

  return {
    facts: new FactsService(factsRepo),
    documents: new DocumentsService(documentsRepo, ingestionRepo, storage, env),
    catalog: new CatalogService(catalogRepo),
    policies: new PoliciesService(policiesRepo),
    search: new SearchService(searchProvider, documentsRepo),
    feedback: new FeedbackService(feedbackRepo),
    agentsRepo,
    rolesRepo,
    auditRepo,
    ingestionRepo,
    sourcesRepo,
    catalogRepo,
    documentsRepo,
    factsRepo,
    policiesRepo,
    feedbackRepo,
    quotaRepo
  };
}
