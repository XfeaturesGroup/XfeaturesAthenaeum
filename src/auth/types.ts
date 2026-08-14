import type { AgentEnvironment } from "../db/rows";

export interface Principal {
  agentId: string;
  agentKey: string;
  environment: AgentEnvironment;
  /** Exact permission keys plus suffix wildcards (e.g. "documents.read.*"). */
  permissions: ReadonlySet<string>;
}

export type AuthFailureReason =
  | "MISSING_CREDENTIALS"
  | "INVALID_TOKEN"
  | "UNKNOWN_AGENT"
  | "AGENT_DISABLED"
  | "DEPENDENCY_UNAVAILABLE";

export interface AuthFailure {
  ok: false;
  reason: AuthFailureReason;
}

export interface AuthSuccess {
  ok: true;
  principal: Principal;
}

export type AuthResult = AuthSuccess | AuthFailure;

export interface AuthzDenial {
  allowed: false;
  reason: string;
}

export interface AuthzApproval {
  allowed: true;
}

export type AuthzResult = AuthzApproval | AuthzDenial;
