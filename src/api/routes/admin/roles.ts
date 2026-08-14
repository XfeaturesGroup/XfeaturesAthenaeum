import { authenticateHttpRequest } from "../../../auth/authenticate";
import { runAuthenticatedOperation } from "../../../auth/pipeline";
import { enforceRateLimit } from "../../../security/rate-limit";
import { jsonResponse } from "../../../utils/responses";
import { buildServices } from "../../services";
import type { RouteContext } from "../../router";

/**
 * The full role catalogue with each role's permissions expanded, for the HQ
 * Access page's "what does this role actually grant" reference panel.
 *
 * Read-only and requires `admin.roles` -- distinct from `admin.agents`,
 * because seeing what a role *could* grant is a smaller disclosure than
 * being able to hand out agent identities, and the two are ordinarily held
 * together but need not be.
 */
export async function handleListRoles(request: Request, ctx: RouteContext): Promise<Response> {
  const services = buildServices(ctx.env);

  const roles = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.roles" } },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "read");
      const allRoles = await services.rolesRepo.list();
      return Promise.all(
        allRoles.map(async (role) => ({
          id: role.id,
          name: role.name,
          description: role.description,
          permissions: (await services.rolesRepo.listPermissionsForRole(role.id)).map((p) => p.key).sort()
        }))
      );
    }
  });

  // Deliberately unpaginated: the role catalogue is a small, bounded,
  // administrator-defined set, and a client needs all of it to render a
  // grant UI. Documented as complete rather than silently truncated.
  return jsonResponse({ request_id: ctx.requestId, roles });
}
