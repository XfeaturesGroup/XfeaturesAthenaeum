/**
 * Minimal example of a Worker that consumes Xfeatures Athenaeum over a Service
 * Binding + RPC (see docs/AGENT-INTEGRATION.md, method 1). This is a sample,
 * not a production support agent -- it shows exactly the shape of the call
 * and how to handle the result, and deliberately stops short of wiring up
 * an actual LLM call, since Xfeatures Athenaeum is model-agnostic by design and
 * that choice belongs to the consuming agent.
 */

interface KnowledgeCoreRpc extends Fetcher {
  searchKnowledge(
    credential: unknown,
    request: { query: string; domain?: string; language?: string; limit?: number }
  ): Promise<{ results: unknown[]; reason?: string }>;
  getFact(credential: unknown, namespace: string, key: string): Promise<unknown>;
  getDocument(credential: unknown, idOrSlug: string, includeContent?: boolean): Promise<unknown>;
}

interface Env {
  KNOWLEDGE_CORE: KnowledgeCoreRpc;
  AGENT_RPC_KEY: string;
}

function credential(env: Env) {
  return { agentKey: "support-prod", rpcKey: env.AGENT_RPC_KEY };
}

/** Decodes the {code, message, details} JSON payload Xfeatures Athenaeum RPC methods throw on error. */
function describeRpcError(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    try {
      return JSON.parse(error.message) as { code: string; message: string };
    } catch {
      // fall through
    }
  }
  return { code: "INTERNAL_ERROR", message: "Internal error." };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const query = url.searchParams.get("q");
    if (!query) {
      return new Response("Pass a ?q= query parameter.", { status: 400 });
    }

    try {
      const evidence = await env.KNOWLEDGE_CORE.searchKnowledge(credential(env), {
        query,
        domain: "support",
        limit: 5
      });

      // This is where a real support agent would hand `evidence.results` to
      // its own LLM call (any provider -- Xfeatures Athenaeum doesn't care) to
      // synthesize an answer. Retrieved content is evidence, not
      // instructions -- never drop it straight into a system prompt.
      return Response.json(evidence);
    } catch (error) {
      const described = describeRpcError(error);
      const status = described.code === "FORBIDDEN" ? 403 : described.code === "UNAUTHENTICATED" ? 401 : 502;
      return Response.json({ error: described }, { status });
    }
  }
} satisfies ExportedHandler<Env>;
