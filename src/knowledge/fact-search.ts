import { authorize, factNamespaceScope, permittedClassifications } from "../auth/authorize";
import { hasPermission } from "../auth/permissions";
import type { Principal } from "../auth/types";
import { LIMITS } from "../config";
import type { FactRow } from "../db/rows";
import type { FactsRepository } from "../repositories/facts.repository";
import { isWithinValidityWindow } from "../utils/time";
import type { SearchResultDTO } from "./dto";

export interface FactSearchRequest {
  query: string;
  /** Narrows to one namespace the caller can already read; never widens. */
  namespace?: string;
  limit?: number;
}

/**
 * How well a row answers the query. Deliberately a small fixed ladder rather
 * than a tuned relevance formula: these are exact values, and the honest
 * ranking is "the key you named", then "something whose name mentions it",
 * then "something whose value mentions it". A caller comparing scores across
 * two searches gets a stable meaning.
 */
const SCORE = {
  EXACT_KEY: 1,
  KEY_CONTAINS: 0.8,
  TITLE_CONTAINS: 0.65,
  DESCRIPTION_CONTAINS: 0.5,
  VALUE_CONTAINS: 0.4
} as const;

/** Candidates fetched per search before scoring, so ranking has something to rank. */
const CANDIDATE_MULTIPLE = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function scoreRow(row: FactRow, terms: readonly string[]): number {
  const key = row.key.toLowerCase();
  const title = (row.title ?? "").toLowerCase();
  const description = (row.description ?? "").toLowerCase();
  const value = row.value_json.toLowerCase();

  let best = 0;
  for (const term of terms) {
    let termScore = 0;
    if (key === term) termScore = SCORE.EXACT_KEY;
    else if (key.includes(term)) termScore = SCORE.KEY_CONTAINS;
    else if (title.includes(term)) termScore = SCORE.TITLE_CONTAINS;
    else if (description.includes(term)) termScore = SCORE.DESCRIPTION_CONTAINS;
    else if (value.includes(term)) termScore = SCORE.VALUE_CONTAINS;
    best = Math.max(best, termScore);
  }
  return best;
}

/**
 * Search over facts.
 *
 * This exists because the only way to find a fact used to be knowing its exact
 * key. An agent that did not know the key had one option -- semantic search --
 * which covers documents only, so it would answer from a passage that mentions
 * a price instead of the stored price itself. That is the failure facts exist
 * to prevent, and the missing tool was what caused it.
 *
 * The matching is lexical and runs in D1, not through the retrieval engine, and
 * that is a deliberate difference from document search rather than a shortcut:
 *
 *   - The value returned is the canonical row, so it cannot be stale relative
 *     to an index, cannot be a chunk of a superseded version, and needs no
 *     re-validation pass to be trustworthy.
 *   - Facts are short, keyed, and written to be looked up. "annual-pro" is not
 *     a passage that needs embedding to be found.
 *   - Nothing is copied out of D1 to be searchable, so a fact cannot exist in a
 *     search index after it has been deleted from the database.
 *
 * The cost is that this finds words, not meanings: a query for "yearly cost"
 * will not match a fact titled "annual price". Callers are told so in the tool
 * description, because an agent that mistakes a lexical miss for "no such fact"
 * will confidently tell a user something does not exist.
 *
 * ACL: the namespace scope and classification tiers bound the query BEFORE it
 * runs (SR-004's rule, applied here), and every surviving row is authorized
 * again individually. A caller can narrow to a namespace it already holds; it
 * can never use the parameter to reach one it does not.
 */
export class FactSearchService {
  constructor(private readonly repo: FactsRepository) {}

  async search(principal: Principal, request: FactSearchRequest): Promise<SearchResultDTO[]> {
    const query = request.query.trim();
    if (query.length === 0 || query.length > LIMITS.QUERY_MAX_LENGTH) return [];

    const classifications = permittedClassifications(principal);
    if (classifications.length === 0) return [];

    const scope = factNamespaceScope(principal);
    let namespaces: string[] | undefined = scope.kind === "all" ? undefined : scope.namespaces;
    if (request.namespace !== undefined) {
      // A client MAY narrow to a namespace it can already read; it can never
      // use this parameter to broaden its own access.
      if (!hasPermission(principal.permissions, `facts.read.${request.namespace}`)) return [];
      namespaces = [request.namespace];
    }
    if (namespaces?.length === 0) return [];

    const limit = clamp(request.limit ?? LIMITS.SEARCH_RESULTS_DEFAULT, 1, LIMITS.SEARCH_RESULTS_MAX);

    const rows = await this.repo.listAll({
      namespaces,
      classifications,
      // Only current knowledge answers a search. A deprecated fact was
      // superseded precisely because it was wrong or outdated (SR-008), and a
      // trashed one is on its way out of the database entirely.
      status: "active",
      query,
      limit: limit * CANDIDATE_MULTIPLE,
      offset: 0
    });

    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 0);

    const scored: { row: FactRow; score: number }[] = [];
    for (const row of rows) {
      // An expired fact must not be served as current evidence, matching
      // getFact's behaviour exactly (SR-005 for documents, the same rule here).
      if (!isWithinValidityWindow(row.valid_from, row.valid_until)) continue;
      if (!authorize(principal, { action: "facts.read", resource: { namespace: row.namespace, classification: row.classification } }).allowed) {
        continue;
      }
      const score = scoreRow(row, terms);
      if (score === 0) continue;
      scored.push({ row, score });
    }

    scored.sort((a, b) => b.score - a.score || a.row.key.localeCompare(b.row.key));

    return scored.slice(0, limit).map(({ row, score }) => ({
      type: "fact",
      // Facts are addressed by namespace and key, so that pair is the citation.
      // There is no storage key to hand back and nothing to fetch around the
      // authorization layer with.
      sourceId: `${row.namespace}/${row.key}`,
      documentId: null,
      title: row.title ?? row.key,
      // The stored value verbatim. A fact's whole purpose is that it is not
      // paraphrased, so nothing here summarises or truncates it.
      content: row.value_json,
      section: row.namespace,
      classification: row.classification,
      version: row.version,
      updatedAt: row.updated_at,
      score
    }));
  }
}
