import type { Env } from "../env";
import { generateRequestId } from "../utils/ids";
import { log } from "../utils/logging";
import { ApiError, ErrorCode, errorResponse } from "../utils/responses";

export interface RouteContext {
  env: Env;
  params: Record<string, string>;
  requestId: string;
  url: URL;
  /**
   * Client IP from `CF-Connecting-IP`. Used only as a pre-identity
   * rate-limit key -- never for authorization. The Cloudflare edge sets and
   * overwrites this header on every proxied request, so a client cannot
   * forge it (docs/SECURITY-ASSUMPTIONS.md A-4).
   */
  clientKey: string;
}

export type RouteHandler = (request: Request, ctx: RouteContext) => Promise<Response>;

interface RouteDef {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

function splitPath(pattern: string): string[] {
  return pattern.split("/").filter((segment) => segment.length > 0);
}

function matchSegments(patternSegments: string[], pathSegments: string[]): Record<string, string> | null {
  if (patternSegments.length !== pathSegments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const patternSegment = patternSegments[i];
    const pathSegment = pathSegments[i];
    if (patternSegment === undefined || pathSegment === undefined) return null;
    if (patternSegment.startsWith(":")) {
      params[patternSegment.slice(1)] = decodeURIComponent(pathSegment);
    } else if (patternSegment !== pathSegment) {
      return null;
    }
  }
  return params;
}

/**
 * Minimal hand-rolled router -- the route table here is small and bounded
 * (minimize dependencies), so a full HTTP framework isn't
 * pulled in just for path matching and method dispatch.
 */
export class Router {
  private readonly routes: RouteDef[] = [];

  get(pattern: string, handler: RouteHandler): void {
    this.routes.push({ method: "GET", segments: splitPath(pattern), handler });
  }
  post(pattern: string, handler: RouteHandler): void {
    this.routes.push({ method: "POST", segments: splitPath(pattern), handler });
  }
  patch(pattern: string, handler: RouteHandler): void {
    this.routes.push({ method: "PATCH", segments: splitPath(pattern), handler });
  }
  delete(pattern: string, handler: RouteHandler): void {
    this.routes.push({ method: "DELETE", segments: splitPath(pattern), handler });
  }

  /**
   * The registered route table, for tests that assert every route is covered
   * by an authorization regression case (see
   * tests/security/admin-authorization.test.ts).
   */
  registeredRoutes(): { method: string; path: string }[] {
    return this.routes.map((route) => ({ method: route.method, path: `/${route.segments.join("/")}` }));
  }

  async handle(request: Request, env: Env): Promise<Response> {
    const requestId = generateRequestId();
    const url = new URL(request.url);
    const pathSegments = splitPath(url.pathname);
    const clientKey = request.headers.get("CF-Connecting-IP") ?? "unknown";

    try {
      const pathMatches = this.routes.filter((route) => matchSegments(route.segments, pathSegments) !== null);
      if (pathMatches.length === 0) {
        throw new ApiError(ErrorCode.NOT_FOUND, "Not found.");
      }

      const methodMatch = pathMatches.find((route) => route.method === request.method);
      if (!methodMatch) {
        const allowed = [...new Set(pathMatches.map((route) => route.method))].join(", ");
        return errorResponse(new ApiError(ErrorCode.METHOD_NOT_ALLOWED, "Method not allowed."), requestId, { Allow: allowed });
      }

      const params = matchSegments(methodMatch.segments, pathSegments) ?? {};
      return await methodMatch.handler(request, { env, params, requestId, url, clientKey });
    } catch (error) {
      if (error instanceof ApiError) {
        return errorResponse(error, requestId);
      }
      log.error("unhandled_request_error", { request_id: requestId, path: url.pathname, method: request.method });
      return errorResponse(new ApiError(ErrorCode.INTERNAL_ERROR, "Internal error."), requestId);
    }
  }
}
