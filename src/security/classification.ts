export const Classification = {
  PUBLIC: "PUBLIC",
  INTERNAL: "INTERNAL",
  CONFIDENTIAL: "CONFIDENTIAL",
  RESTRICTED: "RESTRICTED"
} as const;

export type Classification = (typeof Classification)[keyof typeof Classification];

const ALL: readonly Classification[] = [
  Classification.PUBLIC,
  Classification.INTERNAL,
  Classification.CONFIDENTIAL,
  Classification.RESTRICTED
];

export function isClassification(value: unknown): value is Classification {
  return typeof value === "string" && (ALL as readonly string[]).includes(value);
}

/**
 * The spec requires the default to never be PUBLIC. This is the
 * fallback used whenever a caller omits classification on write -- it is
 * intentionally not configurable down to PUBLIC via env var, only up.
 */
export const HARD_MINIMUM_DEFAULT_CLASSIFICATION: Classification = Classification.INTERNAL;

export function resolveDefaultClassification(envValue: string | undefined): Classification {
  if (isClassification(envValue) && envValue !== Classification.PUBLIC) {
    return envValue;
  }
  return HARD_MINIMUM_DEFAULT_CLASSIFICATION;
}
