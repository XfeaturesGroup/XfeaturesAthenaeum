# @xfeatures/athenaeum-types

TypeScript types for Xfeatures Athenaeum's REST API: the DTOs (`FactDTO`, `DocumentDTO`, `SearchResultDTO`, ...) and the request/response envelope shapes every route uses.

Hand-authored from the Worker's own `src/knowledge/dto.ts` and `src/api/schemas/*` (in `xfeatures-athenaeum`), not generated — there is no OpenAPI-to-TS pipeline wired up yet, even though `docs/openapi.yaml` exists. Keep this package in sync by hand when those change.

```bash
npm run build
```

Consumed by [`@xfeatures/athenaeum-sdk`](../athenaeum-sdk); most code should depend on that instead of this package directly.
