import { jsonResponse } from "../../utils/responses";
import type { RouteContext } from "../router";

/**
 * What a client should ask Xfeatures Account for when it wants a token this
 * resource will accept.
 *
 * These are ordinary identity scopes, and that is the point: Athenaeum's own
 * permissions never travel in a token (ADR 0001 §2). The scope set only has to
 * be one the "Athenaeum Developer Access" application can actually grant --
 * asking for more is silently dropped at consent, which looks to the person
 * signing in like the client asked for something it did not get.
 *
 * Kept in step with that application's `allowed_scopes` registration in
 * Xfeatures Account.
 */
const DEVELOPER_ACCESS_SCOPES = ["openid", "profile:username", "email"] as const;

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * The first link in the discovery chain an MCP client walks: it gets a 401
 * from `/mcp` carrying `WWW-Authenticate: Bearer resource_metadata="..."`,
 * fetches this document, reads `authorization_servers`, and continues to that
 * issuer's own RFC 8414 metadata. Athenaeum is the resource server in that
 * exchange and describes only itself -- it is not an authorization server,
 * hosts no `/authorize`, and proxies nothing.
 *
 * `authorization_servers` is an explicitly configured issuer
 * (`ACCOUNT_ISSUER`), not an inference from the introspection endpoint: a
 * client validates the issuer it was sent to against the `issuer` field of the
 * document it then fetches, so this value has to be the authorization server's
 * real identity rather than whichever hostname Athenaeum happens to introspect
 * against. An unconfigured environment reports an empty list, which is honest
 * -- there is no authorization server to discover -- and matches this repo's
 * fail-closed default everywhere else.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function handleProtectedResourceMetadata(request: Request, ctx: RouteContext): Promise<Response> {
  const resource = new URL(request.url).origin;
  const issuer = ctx.env.ACCOUNT_ISSUER;
  const authorizationServers = issuer !== undefined && issuer.length > 0 ? [issuer] : [];

  return jsonResponse({
    resource,
    authorization_servers: authorizationServers,
    bearer_methods_supported: ["header"],
    scopes_supported: [...DEVELOPER_ACCESS_SCOPES],
    resource_documentation: "https://github.com/XfeaturesGroup/XfeaturesAthenaeum#readme"
  });
}
