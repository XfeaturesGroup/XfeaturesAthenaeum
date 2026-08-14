/**
 * Single source of truth for the product name.
 *
 * The working name is "Xfeatures Athenaeum". Renaming the product means
 * editing this file and nothing else in `src/` -- no other module hardcodes a
 * display name. `SLUG` is used in machine-facing places (OAuth scope, MCP
 * server name, user agents), so changing it is a breaking protocol change and
 * should be done deliberately rather than as a cosmetic rename.
 */
export const BRANDING = {
  /** Human-facing product name. Safe to change freely. */
  NAME: "Xfeatures Athenaeum",
  /** Short human-facing name. Safe to change freely. */
  SHORT_NAME: "Athenaeum",
  /**
   * Machine identifier. Appears in the Xfeatures Account OAuth scope
   * (`athenaeum`), the MCP server name, and client user agents. Changing this
   * requires coordinated changes in Xfeatures Account's scope registry and in
   * every deployed client.
   */
  SLUG: "athenaeum",
  VERSION: "0.2.0"
} as const;

/** The coarse Xfeatures Account OAuth scope a principal must hold to reach Athenaeum at all. */
export const ATHENAEUM_ACCESS_SCOPE = BRANDING.SLUG;
