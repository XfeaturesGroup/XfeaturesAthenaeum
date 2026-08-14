import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface StoredCredentials {
  accessToken: string;
  refreshToken: string | null;
  /** Unix seconds. */
  expiresAt: number;
  athenaeumBaseUrl: string;
}

const CREDENTIALS_DIR = join(homedir(), ".athenaeum");
const CREDENTIALS_PATH = join(CREDENTIALS_DIR, "credentials.json");

export async function saveCredentials(credentials: StoredCredentials): Promise<void> {
  await mkdir(CREDENTIALS_DIR, { recursive: true });
  // Mode 0600: this file holds a live bearer token, readable only by the
  // owner -- same posture as an SSH private key or a `wrangler login` token.
  await writeFile(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2), { mode: 0o600 });
}

export async function loadCredentials(): Promise<StoredCredentials | null> {
  try {
    const raw = await readFile(CREDENTIALS_PATH, "utf8");
    return JSON.parse(raw) as StoredCredentials;
  } catch {
    return null;
  }
}

export async function clearCredentials(): Promise<void> {
  await rm(CREDENTIALS_PATH, { force: true });
}

export function credentialsPath(): string {
  return CREDENTIALS_PATH;
}
