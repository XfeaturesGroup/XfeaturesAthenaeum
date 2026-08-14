#!/usr/bin/env node
/**
 * Fails if the OpenAPI document and the real route table have drifted apart.
 *
 * A published API document that quietly falls behind the code is worse than no
 * document: it tells an outside developer something confidently wrong. The
 * route table in `src/api/routes/index.ts` is the only source of truth about
 * what this Worker actually serves, so it is the thing the document is checked
 * against.
 *
 *   node scripts/verify-openapi.mjs
 *
 * This checks *coverage*, not correctness of every schema -- that a route is
 * described at all, and that nothing is described which no longer exists.
 * Request/response shapes still mirror `src/api/schemas/*` by hand.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTES = join(ROOT, 'src', 'api', 'routes', 'index.ts');
const SPEC = join(ROOT, 'docs', 'openapi.yaml');

/**
 * Routes that are deliberately absent from the OpenAPI document, with why.
 * MCP is not a REST API -- it speaks JSON-RPC over a single endpoint and
 * describes itself through its own tool listing, so an OpenAPI path entry
 * would misrepresent it.
 */
const INTENTIONALLY_UNDOCUMENTED = new Map([
	['POST /mcp', 'MCP transport (JSON-RPC); self-describing via tools/list'],
	['GET /mcp', 'MCP transport (JSON-RPC); self-describing via tools/list'],
	['DELETE /mcp', 'MCP transport (JSON-RPC); self-describing via tools/list'],
]);

/** `/v1/facts/:namespace/:key` -> `/v1/facts/{namespace}/{key}` */
const normalise = (path) => path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');

const routeSource = readFileSync(ROUTES, 'utf8');
const codeRoutes = new Set(
	[...routeSource.matchAll(/router\.(get|post|patch|delete)\("([^"]+)"/g)].map(
		(m) => `${m[1].toUpperCase()} ${normalise(m[2])}`,
	),
);

const specSource = readFileSync(SPEC, 'utf8');
const specRoutes = new Set();
{
	let currentPath = null;
	for (const line of specSource.split('\n')) {
		const pathMatch = /^ {2}(\/\S*):\s*$/.exec(line);
		if (pathMatch) {
			currentPath = pathMatch[1];
			continue;
		}
		const verbMatch = /^ {4}(get|post|patch|delete|put):\s*$/.exec(line);
		if (verbMatch && currentPath) specRoutes.add(`${verbMatch[1].toUpperCase()} ${currentPath}`);
		// Any non-indented or shallower key ends the current path block.
		if (/^ {0,1}\S/.test(line)) currentPath = null;
	}
}

const missing = [...codeRoutes].filter((r) => !specRoutes.has(r) && !INTENTIONALLY_UNDOCUMENTED.has(r));
const stale = [...specRoutes].filter((r) => !codeRoutes.has(r));

console.log(`Route table: ${codeRoutes.size} routes    OpenAPI: ${specRoutes.size} documented\n`);

if (INTENTIONALLY_UNDOCUMENTED.size > 0) {
	console.log('Intentionally undocumented:');
	for (const [route, why] of INTENTIONALLY_UNDOCUMENTED) console.log(`  - ${route.padEnd(34)} ${why}`);
	console.log('');
}

let failed = false;
if (missing.length > 0) {
	failed = true;
	console.error(`Served but NOT documented (${missing.length}):`);
	for (const r of missing.sort()) console.error(`  - ${r}`);
	console.error('');
}
if (stale.length > 0) {
	failed = true;
	console.error(`Documented but NOT served (${stale.length}):`);
	for (const r of stale.sort()) console.error(`  - ${r}`);
	console.error('');
}

if (failed) {
	console.error('docs/openapi.yaml does not match the route table.');
	process.exit(1);
}
console.log('OpenAPI covers every served route.');
