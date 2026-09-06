// Retrieves the Gemini API key without ever hardcoding it in source.
//
// Priority order:
//   1. GEMINI_API_KEY env var â€” a local-dev-only shortcut (see .env.example).
//   2. Google Cloud Secret Manager â€” what production (Cloud Run) uses.
//
// The key is fetched once and cached in memory for the life of the process,
// so a Cloud Run instance only calls Secret Manager on its first request
// (or on cold start), not on every journal entry.

import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

let cachedKey = null;
let client = null;

export async function getGeminiApiKey() {
  if (cachedKey) return cachedKey;

  // Local development shortcut â€” never set this in production.
  if (process.env.GEMINI_API_KEY) {
    cachedKey = process.env.GEMINI_API_KEY;
    return cachedKey;
  }

  const projectId =
    process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || "gen-lang-client-09340952-87717";
  const secretName = process.env.GEMINI_SECRET_NAME || "gemini-api-key";

  if (!projectId) {
    throw new Error(
      "GOOGLE_CLOUD_PROJECT is not set, and GEMINI_API_KEY is not set either. " +
        "Set one of them â€” see .env.example."
    );
  }

  if (!client) {
    client = new SecretManagerServiceClient();
  }

  const versionPath = `projects/${projectId}/secrets/${secretName}/versions/latest`;
  const [version] = await client.accessSecretVersion({ name: versionPath });
  cachedKey = version.payload.data.toString("utf8").trim();

  if (!cachedKey) {
    throw new Error(`Secret ${secretName} exists but its value is empty.`);
  }

  return cachedKey;
}

