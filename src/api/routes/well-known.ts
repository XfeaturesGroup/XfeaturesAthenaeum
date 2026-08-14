import { jsonResponse } from "../../utils/responses";
import type { RouteContext } from "../router";

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * Lets an MCP client that speaks the spec's OAuth discovery flow find out,
 * without being told out of band, which authorization server issues tokens
 * Athenaeum accepts. Athenaeum is the resource server here -- this document
 * describes Athenaeum itself, never Account (which is the authorization
 * server, and is not this repository's to document).
 *
 * `authorization_servers` is empty when the Account integration is
 * unconfigured, which is honest rather than hidden: an unconfigured
 * environment has no working authorization server to discover, matching this
 * repo's fail-closed default everywhere else (`account-token.ts`).
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function handleProtectedResourceMetadata(request: Request, ctx: RouteContext): Promise<Response> {
  const resource = new URL(request.url).origin;
  const authorizationServers = ctx.env.ACCOUNT_INTROSPECTION_URL ? [new URL(ctx.env.ACCOUNT_INTROSPECTION_URL).origin] : [];

  return jsonResponse({
    resource,
    authorization_servers: authorizationServers,
    bearer_methods_supported: ["header"]
  });
}
