export function nowIso(): string {
  return new Date().toISOString();
}

/** UTC calendar date (`YYYY-MM-DD`). The unit daily quotas reset on -- deliberately UTC, not the caller's local day. */
export function todayDate(): string {
  return nowIso().slice(0, 10);
}

export function isWithinValidityWindow(
  validFrom: string | null,
  validUntil: string | null,
  at: string = nowIso()
): boolean {
  if (validFrom && at < validFrom) return false;
  if (validUntil && at > validUntil) return false;
  return true;
}
