/**
 * Suffix-wildcard permission matching only: a granted "documents.read.*"
 * satisfies a required "documents.read.support". A bare "*" (grant
 * everything) is deliberately unsupported anywhere in this codebase --
 * explicitly forbids an "all-agents-admin-token" style grant, and
 * every seed/admin path that writes permission rows should be read against
 * that assumption. Keep this the single code path that interprets wildcards
 * ("wildcard parser должен быть тщательно протестирован") --
 * every call site MUST go through hasPermission/hasAnyPermission, never
 * compare permission strings directly.
 */
/**
 * Minimum number of concrete segments before a trailing `.*`. `documents.read.*`
 * (2 segments) is valid; `documents.*` and `admin.*` (1 segment) are not, and
 * are treated as granting nothing.
 *
 * SR-007: without this floor, a single mis-seeded `admin.*` or `documents.*`
 * row would silently confer every administrative permission or every document
 * verb (read AND write AND publish). It also makes domain enumeration in
 * `documentDomainScope` sound, since the only wildcard that can grant a
 * document read is exactly `documents.read.*`.
 */
const MIN_WILDCARD_SEGMENTS = 2;

export function permissionSatisfies(granted: string, required: string): boolean {
  if (granted.length === 0 || required.length === 0) return false;
  if (granted === required) return true;
  if (!granted.endsWith(".*")) return false;

  const prefix = granted.slice(0, -1); // keep trailing "."
  // Concrete segments preceding the wildcard, e.g. "documents.read." -> 2.
  const segments = prefix.split(".").filter((segment) => segment.length > 0);
  if (segments.length < MIN_WILDCARD_SEGMENTS) return false;

  return required.startsWith(prefix) && required.length > prefix.length;
}

export function hasPermission(grantedSet: ReadonlySet<string>, required: string): boolean {
  for (const granted of grantedSet) {
    if (permissionSatisfies(granted, required)) return true;
  }
  return false;
}

export function hasAnyPermission(grantedSet: ReadonlySet<string>, required: readonly string[]): boolean {
  return required.some((requiredKey) => hasPermission(grantedSet, requiredKey));
}

export function hasAllPermissions(grantedSet: ReadonlySet<string>, required: readonly string[]): boolean {
  return required.every((requiredKey) => hasPermission(grantedSet, requiredKey));
}
