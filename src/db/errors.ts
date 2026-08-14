/** Thrown by repository update methods on an optimistic-concurrency mismatch. */
export class StaleVersionError extends Error {
  constructor(entity: string, expected: number, actual: number) {
    super(`${entity} was updated concurrently: expected version ${expected}, found ${actual}`);
  }
}

/** Thrown when a unique constraint (e.g. namespace+key, slug, code) is violated on create. */
export class DuplicateEntityError extends Error {
  constructor(entity: string, identifier: string) {
    super(`${entity} already exists: ${identifier}`);
  }
}
