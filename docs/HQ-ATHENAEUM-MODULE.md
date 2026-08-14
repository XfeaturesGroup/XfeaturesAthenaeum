# The Athenaeum module in HQ

HQ is the control plane for Xfeatures Athenaeum. It is a **client**, never a
peer — being first-party Xfeatures software grants it nothing.

## How a request is authorized

```
HQ operator (browser session)
  │  1. HQ role gate        staff only, before permissions are consulted
  │  2. HQ permission       athenaeum:documents:publish, athenaeum:search, …
  ▼
HQ API
  │  3. HQ's own machine credential
  │     Account client_credentials → machine token
  ▼
Athenaeum
  │  4. Athenaeum authorization on the resolved principal
  ▼
D1 · R2 · AI Search
```

Gates 1 and 2 decide **which operator may ask**. Gate 4 decides **whether it
may happen at all**, and it is the authority. Hiding a navigation item is
presentation, not access control: an operator who crafts the request by hand
still meets every server-side check, and HQ can never exceed the Athenaeum role
attached to its own principal.

Revoking `agent-hq-console` inside Athenaeum cuts the whole module off without
touching HQ's Account identity — proven in the security suite.

## Permissions

| Permission | Grants |
|---|---|
| `athenaeum:documents:view` | List and open documents and facts |
| `athenaeum:documents:manage` | Create drafts, edit facts |
| `athenaeum:documents:publish` | Publish, deprecate, deprecate a fact |
| `athenaeum:search` | Run authorized retrieval |
| `athenaeum:ingestion:view` | See indexing state |
| `athenaeum:ingestion:manage` | Request re-indexing |
| `athenaeum:audit:view` | Read Athenaeum's audit trail |
| `athenaeum:access:manage` | Reserved for principal management |

Managing a document deliberately does not confer publishing it: drafting
knowledge and approving it for every consumer of the platform are different
acts, and the split is enforced server-side.

## Sections

- **Documents** — list, filter, create (write or upload), and move through
  draft → review → published → deprecated. Classification is shown on every
  row because it decides who can read the document, and it defaults to
  INTERNAL rather than PUBLIC.
- **Facts** — deterministic key/value knowledge answered from D1. Used where a
  paraphrase would be a bug: prices, SLAs, limits.
- **Ingestion** — where a document sits between "stored" and "answerable". A
  published-but-not-yet-indexed document is not a failure, and showing that
  plainly stops an operator concluding the knowledge base is wrong when it is
  merely behind.
- **Search** — the same authorized retrieval an agent gets, not a privileged
  preview. Provenance shown with each result comes from the canonical D1 row.
- **Audit** — every decision Athenaeum made, refusals included. The actor is
  always derived server-side.

## Proven end to end

Against real dev infrastructure:

| Suite | Result |
|---|---|
| HQ acceptance milestone (create → publish → index → search → provenance) | **16/16** |
| HQ module security | **14/14** |
| Machine authentication | **8/8** |

The provenance checks matter most: a citation's title, version and timestamp
are read from the D1 row, never from index metadata, so a stale or tampered
index cannot change what a citation claims about a document.
