# Architecture

## System overview

```mermaid
flowchart TB
    subgraph agents["AI Agents"]
        support["Support Agent"]
        billing["Billing Agent"]
        assistant["Internal Assistant"]
        publicbot["Public Chatbot"]
        external["External / non-Worker agent"]
    end

    subgraph kc["Xfeatures Athenaeum (this Worker)"]
        rest["REST API<br/>/v1/*"]
        rpc["RPC entrypoint<br/>KnowledgeCoreRpc"]
        mcp["MCP server<br/>/mcp"]
        authn["authenticate()"]
        authz["authorize()"]
        svc["Knowledge services<br/>facts / documents / catalog / policies / search"]
    end

    D1[("D1<br/>facts, documents metadata,<br/>catalog, agents/roles/permissions,<br/>audit, feedback, ingestion_jobs")]
    R2[("R2<br/>canonical document bytes")]
    AISEARCH[("AI Search<br/>retrieval index over R2")]
    QUEUE(["Ingestion Queue"])
    WORKFLOW(["Publish Workflow"])

    support -- "Service Binding / RPC" --> rpc
    billing -- "Service Binding / RPC" --> rpc
    assistant -- "Service Binding / RPC" --> rpc
    publicbot -- "Access JWT + REST/MCP" --> rest
    external -- "Access JWT + REST/MCP" --> mcp

    rest --> authn
    rpc --> authn
    mcp --> authn
    authn --> authz
    authz --> svc

    svc --> D1
    svc --> R2
    svc -- "search() only, never generate" --> AISEARCH
    svc -- "publish/reindex" --> QUEUE
    svc -- "submit for review" --> WORKFLOW
    QUEUE --> D1
    WORKFLOW --> D1
    AISEARCH -. "indexes" .-> R2
```

Every arrow into `authn`/`authz` is the *same* code path (`src/auth/pipeline.ts`) regardless of which of the three edges it came in on. There is no separate, looser ACL for MCP or RPC callers.

## Trust boundaries

```mermaid
flowchart LR
    subgraph internet["Untrusted: public internet"]
        ext["External clients"]
    end
    subgraph access["Cloudflare Access"]
        gate["Service token verification<br/>JWT minting"]
    end
    subgraph cf["Cloudflare account: trusted internal zone"]
        subgraph workers["Other Workers"]
            agent["Agent Worker"]
        end
        kcworker["Xfeatures Athenaeum Worker"]
        d1[(D1)]
        r2[(R2)]
        aisearch[(AI Search)]
    end
    subgraph llm["External trust zone"]
        model["Agent's LLM provider<br/>(any vendor)"]
    end

    ext --> gate --> kcworker
    agent -- "Service Binding<br/>(account-scoped trust)<br/>+ RPC credential" --> kcworker
    kcworker --> d1
    kcworker --> r2
    kcworker --> aisearch
    agent -. "evidence only,<br/>agent decides what the model sees" .-> model
```

Xfeatures Athenaeum never talks to an LLM provider and never sees which model an agent uses (model-agnostic). It hands back evidence; the calling agent decides what — if anything — reaches its model's context window, and is responsible for its own prompt-injection-aware handling of that evidence (reinforced by the `EVIDENCE_NOTICE` string that ships inside every MCP tool result and every REST/RPC response's implicit "this is retrieved data" contract).

## Authentication flow

```mermaid
sequenceDiagram
    participant Caller
    participant Ath as Xfeatures Athenaeum
    participant Account as Xfeatures Account
    participant D1

    alt Bearer token (REST or MCP) -- the usual path
        Caller->>Ath: request + Authorization: Bearer <token>
        Ath->>Account: POST /oauth/introspect (Athenaeum's own client credentials)
        Account-->>Ath: {active, client_id, sub, scope}
        Ath->>Ath: require the `athenaeum` scope,<br/>or the one pre-registered Developer Access client with a subject
        Note over Ath: a positive result is cached for at most 60s;<br/>a negative one is never cached
    else Cloudflare Access JWT
        Caller->>Ath: request + Cf-Access-Jwt-Assertion
        Ath->>Ath: verify signature via JWKS, check iss + aud
    else Internal Worker (Service Binding / RPC)
        Caller->>Ath: RPC call + {agentKey, rpcKey}
        Ath->>Ath: timing-safe compare against the stored peppered hash
    end

    Ath->>D1: SELECT * FROM agents WHERE ... AND environment = <this Worker's ENVIRONMENT>
    D1-->>Ath: agent row (or none)
    alt unknown, disabled, revoked, wrong environment, or any lookup error
        Ath-->>Caller: 401 UNAUTHENTICATED (fail closed)
    else active agent
        Ath->>D1: agent_roles -> role_permissions -> permissions
        D1-->>Ath: permission set
        Ath->>Ath: build Principal {agentId, agentKey, environment, permissions}
    end
```

The environment check in that D1 lookup is load-bearing: an agent row's
`environment` must equal the Worker's own, so a development credential cannot
authenticate against production even if it leaks.

Client-claimed roles are never trusted — the JWT/RPC credential only proves *identity*; every permission comes from a fresh D1 read keyed off that identity.

## Retrieval (search) flow — ACL before retrieval

```mermaid
sequenceDiagram
    participant Agent
    participant KC as Xfeatures Athenaeum
    participant AISearch as AI Search
    participant D1

    Agent->>KC: searchKnowledge(query, domain?)
    KC->>KC: authorize("knowledge.search")
    KC->>KC: permittedClassifications(principal)<br/>-- derived from the Principal, never client-supplied
    KC->>AISearch: search(query, filters: classification IN (...), domain IN (...))
    AISearch-->>KC: chunks + metadata (classification, domain, document_id, version)
    KC->>KC: drop any chunk whose metadata classification<br/>isn't in the permitted set (defense in depth)
    KC->>D1: SELECT status, classification, domain FROM documents WHERE id IN (...)
    D1-->>KC: live document rows
    KC->>KC: drop chunks for documents that are no longer<br/>active or were reclassified since last index
    KC->>KC: authorize() again per result against the LIVE row
    KC-->>Agent: results (or {results: [], reason: "NO_RELIABLE_MATCH"})
```

The pre-filter sent to AI Search is the primary gate; the live-D1 cross-check afterward is a second, independent gate against index staleness — a document archived or reclassified a minute ago can't leak through a not-yet-refreshed index entry. Neither gate alone is trusted as sufficient.

## Ingestion / publish flow

```mermaid
flowchart TB
    upload["POST /v1/admin/documents<br/>(multipart upload)"] --> validate["validate MIME/extension/size<br/>(src/ingestion/validation.ts)"]
    validate --> hash["content hash (dedup / change detection)"]
    hash --> r2put["R2 put with custom metadata:<br/>classification, domain, document_id, title,<br/>version, language, status, updated_at"]
    r2put --> d1row["D1: documents + document_versions row<br/>(status = draft)"]

    d1row --> review{"submit-for-review?"}
    review -- "no: direct publish" --> patchstatus["PATCH .../status {active}"]
    review -- "yes" --> workflow["Publish Workflow instance<br/>(id = document id)"]
    workflow --> pending["D1: status = pending_review"]
    pending --> wait["step.waitForEvent<br/>'document-review-decision'<br/>timeout 7 days"]
    wait --> decision["POST .../review-decision<br/>{approved, note}"]
    decision --> apply["apply decision:<br/>approved -> active + reindex<br/>rejected -> back to draft"]

    patchstatus --> enqueue["enqueue ingestion_job<br/>(reindex or delete)"]
    apply --> enqueue
    enqueue --> queue(["Ingestion Queue"])
    queue --> consumer["Queue consumer:<br/>confirm document state,<br/>mark job completed/failed"]
    consumer --> dlq{"exhausted retries?"}
    dlq -- "yes" --> deadletter["DLQ consumer:<br/>mark job permanently failed"]
```

AI Search re-indexes the R2 bucket on its own schedule once metadata is written — Xfeatures Athenaeum doesn't (and, as far as this build could verify, can't) force a synchronous re-index via the Workers binding. That's exactly why the retrieval flow above never trusts the index alone for freshness.

## Data model

`facts` and `documents` are the two content types with full point-in-time version history (`fact_versions`, `document_versions`) since those are the ones the spec calls out for rollback/audit by name. `products`, `plans`, `services`, and `policies` bump an in-place `version` integer and rely on `audit_events.old_value_json`/`new_value_json` for history instead — four more near-duplicate `*_versions` tables would be a lot of repetitive schema for a need `audit_events` already covers. See the header comment in [`migrations/0001_init.sql`](../migrations/0001_init.sql) for the full column-level design notes.

Full ERD-level detail lives in the migration file itself (it's the source of truth); this doc stays intentionally high-level so it doesn't drift out of sync with the schema.

## Why these Cloudflare products and not others

- **AI Search over hand-rolled Vectorize + embeddings**: the point of Xfeatures Athenaeum is being replaceable (of the design brief: "keep the architecture replaceable") — AI Search's `KnowledgeSearchProvider` abstraction (`src/search/types.ts`) is one implementation; swapping engines later doesn't touch any caller.
- **No Durable Objects**: nothing here needs strongly-coordinated state, locking, or WebSockets — not rate limiting (native Workers Rate Limiting API instead), not MCP sessions (stateless Streamable HTTP), not ingestion coordination (Queues' own retry/DLQ semantics).
- **Workflows only for the publish-approval gate**: plain ingestion (parse/hash/store/index) is a simple idempotent Queue consumer; only the "wait for a human, possibly for days" step genuinely needs Workflows' durability.
- **KV isn't used at all**: nothing here is a good fit for eventually-consistent, low-write-latency cache-style storage over D1's strong consistency, and, KV must never be the backing store for permissions or classification decisions anyway.
