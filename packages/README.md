# Xfeatures Athenaeum client packages

Standalone npm packages, not part of the Worker's own build/lint/test (see the root `eslint.config.js` and `tsconfig.json`, which both exclude `packages/**` deliberately). Each has its own `package.json`, `tsconfig.json`, and build.

| Package | What it is |
|---|---|
| [`athenaeum-types`](athenaeum-types) | Hand-authored TypeScript types for the REST API. |
| [`athenaeum-sdk`](athenaeum-sdk) | Thin fetch-based REST client built on `athenaeum-types`. |
| [`athenaeum-cli`](athenaeum-cli) | `athenaeum` command-line tool: sign in with your own Xfeatures Account, then search/read/propose from the terminal. Built on `athenaeum-sdk`. |

Build order matters (each depends on the previous via `file:` references):

```bash
cd athenaeum-types && npm install && npm run build
cd ../athenaeum-sdk   && npm install && npm run build && npm test
cd ../athenaeum-cli   && npm install && npm run build && npm test
```

None of these are published to a registry yet -- `file:../...` dependencies only work from a checkout of this repository.
