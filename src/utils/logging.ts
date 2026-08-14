/**
 * Structured, metadata-only logging. Never pass raw query text, document
 * content, PII, or credentials here -- see docs/SECURITY.md "Log security".
 * `debugContent` fields are dropped unless LOG_CONTENT_DEBUG is explicitly
 * enabled, which must never be true in production.
 */

const REDACTED_KEYS = new Set([
  "authorization",
  "cookie",
  "cf-access-jwt-assertion",
  "cf-access-client-secret",
  "rpc_key",
  "rpckey",
  "secret",
  "token",
  "password"
]);

export type LogEvent = Record<string, string | number | boolean | null | undefined>;

function redact(event: LogEvent): LogEvent {
  const clean: LogEvent = {};
  for (const [key, value] of Object.entries(event)) {
    clean[key] = REDACTED_KEYS.has(key.toLowerCase()) ? "[redacted]" : value;
  }
  return clean;
}

function emit(level: "info" | "warn" | "error", event: string, fields: LogEvent): void {
  const payload = { level, event, ts: new Date().toISOString(), ...redact(fields) };
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields: LogEvent = {}): void => emit("info", event, fields),
  warn: (event: string, fields: LogEvent = {}): void => emit("warn", event, fields),
  error: (event: string, fields: LogEvent = {}): void => emit("error", event, fields)
};

/** Security-relevant events get a dedicated `security_event` tag for alerting/SIEM filters. */
export const SecurityEvent = {
  AUTH_FAILURE: "AUTH_FAILURE",
  AUTHZ_DENY: "AUTHZ_DENY",
  RATE_LIMIT: "RATE_LIMIT",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  INVALID_TOKEN: "INVALID_TOKEN",
  ADMIN_CHANGE: "ADMIN_CHANGE",
  PERMISSION_CHANGE: "PERMISSION_CHANGE",
  RESTRICTED_ACCESS: "RESTRICTED_ACCESS",
  SUSPICIOUS_QUERY: "SUSPICIOUS_QUERY"
} as const;

export type SecurityEvent = (typeof SecurityEvent)[keyof typeof SecurityEvent];

export function logSecurityEvent(kind: SecurityEvent, fields: LogEvent = {}): void {
  emit("warn", "security_event", { security_event: kind, ...fields });
}
