#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { AthenaeumApiError, AthenaeumClient } from "@xfeatures/athenaeum-sdk";
import { parseFlags } from "./args.js";
import { loadConfig } from "./config.js";
import { clearCredentials, credentialsPath, loadCredentials, saveCredentials } from "./credentials.js";
import { loginWithAccount } from "./oauth-flow.js";

const USAGE = `athenaeum -- personal command-line access to Xfeatures Athenaeum

Usage:
  athenaeum login                              Sign in with your Xfeatures Account
  athenaeum logout                             Forget the stored token
  athenaeum whoami                             Show token status and confirm Athenaeum accepts it
  athenaeum search <query> [--domain D] [--limit N]
  athenaeum get-fact <namespace> <key>
  athenaeum get-document <id-or-slug> [--content]
  athenaeum get-product <code>
  athenaeum get-plan <code>
  athenaeum get-policy <code>
  athenaeum propose-document <slug> --title T --domain D --classification C --language L --file PATH [--category C] [--format markdown|text|json|html]
  athenaeum submit-for-review <document-id>

Environment (only needed for "login"; see README.md):
  ATHENAEUM_CLIENT_ID                            The "Athenaeum Developer Access" Account application
                                                 (a public client -- there is no secret to configure)
  ATHENAEUM_ACCOUNT_WEB_URL                      default https://account.xfeatures.net
  ATHENAEUM_ACCOUNT_API_URL                      default https://api.account.xfeatures.net
  ATHENAEUM_BASE_URL                             default https://athenaeum.xfeatures.net
`;


async function requireClient(): Promise<AthenaeumClient> {
  const credentials = await loadCredentials();
  if (!credentials) {
    throw new Error('Not signed in. Run "athenaeum login" first.');
  }
  if (credentials.expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new Error('Your session has expired. Run "athenaeum login" again.');
  }
  return new AthenaeumClient({ baseUrl: credentials.athenaeumBaseUrl, token: credentials.accessToken });
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function runLogin(): Promise<void> {
  const config = loadConfig();
  const token = await loginWithAccount(config);
  await saveCredentials({
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    expiresAt: Math.floor(Date.now() / 1000) + token.expires_in,
    athenaeumBaseUrl: config.athenaeumBaseUrl
  });
  console.log(`Signed in. Credentials stored at ${credentialsPath()}.`);
}

async function runLogout(): Promise<void> {
  await clearCredentials();
  console.log("Signed out.");
}

async function runWhoami(): Promise<void> {
  const credentials = await loadCredentials();
  if (!credentials) {
    console.log('Not signed in. Run "athenaeum login".');
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const remaining = credentials.expiresAt - now;
  console.log(`Athenaeum:    ${credentials.athenaeumBaseUrl}`);
  console.log(`Token status: ${remaining > 0 ? `valid for ${String(remaining)}s more` : "expired"}`);
  if (remaining <= 0) return;

  // There is no dedicated "who am I" endpoint on Athenaeum -- this proves the
  // token is currently accepted (and by extension, that the signed-in person
  // has an Athenaeum principal at all) with the cheapest real call available.
  const client = new AthenaeumClient({ baseUrl: credentials.athenaeumBaseUrl, token: credentials.accessToken });
  try {
    await client.search({ query: "athenaeum-cli-whoami-probe", limit: 1 });
    console.log("Athenaeum:    accepted this token.");
  } catch (error) {
    if (error instanceof AthenaeumApiError) {
      console.log(`Athenaeum:    rejected this token (${error.code}: ${error.message}).`);
    } else {
      throw error;
    }
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);

  switch (command) {
    case "login":
      return runLogin();
    case "logout":
      return runLogout();
    case "whoami":
      return runWhoami();

    case "search": {
      const client = await requireClient();
      const query = positional[0];
      if (!query) throw new Error("Usage: athenaeum search <query> [--domain D] [--limit N]");
      const result = await client.search({
        query,
        domain: typeof flags["domain"] === "string" ? flags["domain"] : undefined,
        limit: typeof flags["limit"] === "string" ? Number(flags["limit"]) : undefined
      });
      printJson(result);
      return;
    }

    case "get-fact": {
      const client = await requireClient();
      const [namespace, key] = positional;
      if (!namespace || !key) throw new Error("Usage: athenaeum get-fact <namespace> <key>");
      printJson(await client.getFact(namespace, key));
      return;
    }

    case "get-document": {
      const client = await requireClient();
      const idOrSlug = positional[0];
      if (!idOrSlug) throw new Error("Usage: athenaeum get-document <id-or-slug> [--content]");
      printJson(await client.getDocument(idOrSlug, { includeContent: flags["content"] === true }));
      return;
    }

    case "get-product": {
      const client = await requireClient();
      const code = positional[0];
      if (!code) throw new Error("Usage: athenaeum get-product <code>");
      printJson(await client.getProduct(code));
      return;
    }

    case "get-plan": {
      const client = await requireClient();
      const code = positional[0];
      if (!code) throw new Error("Usage: athenaeum get-plan <code>");
      printJson(await client.getPlan(code));
      return;
    }

    case "get-policy": {
      const client = await requireClient();
      const code = positional[0];
      if (!code) throw new Error("Usage: athenaeum get-policy <code>");
      printJson(await client.getPolicy(code));
      return;
    }

    case "propose-document": {
      const client = await requireClient();
      const slug = positional[0];
      const title = flags["title"];
      const domain = flags["domain"];
      const classification = flags["classification"];
      const language = flags["language"];
      const filePath = flags["file"];
      if (
        !slug ||
        typeof title !== "string" ||
        typeof domain !== "string" ||
        typeof classification !== "string" ||
        typeof language !== "string" ||
        typeof filePath !== "string"
      ) {
        throw new Error(
          "Usage: athenaeum propose-document <slug> --title T --domain D --classification C --language L --file PATH"
        );
      }
      if (classification !== "PUBLIC" && classification !== "INTERNAL" && classification !== "CONFIDENTIAL" && classification !== "RESTRICTED") {
        throw new Error("--classification must be one of PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED");
      }
      const content = await readFile(filePath, "utf8");
      const format = flags["format"];
      const document = await client.proposeDocument({
        slug,
        title,
        domain,
        classification,
        language,
        content,
        category: typeof flags["category"] === "string" ? flags["category"] : undefined,
        format: format === "markdown" || format === "text" || format === "json" || format === "html" ? format : undefined
      });
      printJson(document);
      console.log('\nDraft created. Run "athenaeum submit-for-review <id>" to send it to a human reviewer.');
      return;
    }

    case "submit-for-review": {
      const client = await requireClient();
      const documentId = positional[0];
      if (!documentId) throw new Error("Usage: athenaeum submit-for-review <document-id>");
      printJson(await client.submitDocumentForReview(documentId));
      return;
    }

    case "help":
    case "--help":
    case undefined:
      console.log(USAGE);
      return;

    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  if (error instanceof AthenaeumApiError) {
    console.error(`Athenaeum error (${error.code}): ${error.message}`);
  } else if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});
