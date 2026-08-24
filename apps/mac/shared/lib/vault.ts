import crypto from "crypto";

// Encrypted per-user secret vault for hosted runs: provider API keys and
// connector tokens, AES-256-GCM under a server master key. Values decrypt
// ONLY inside server code (the executor and the vault API never return them);
// Firestore rules give vault docs no client access at all.

const VAULT_VERSION = "v1";

/** Slots the vault accepts: providers for BYOK, connectors for grounding. */
export const VAULT_PROVIDER_SLOTS = ["openai", "anthropic", "gemini", "openrouter"] as const;
export const VAULT_CONNECTOR_SLOTS = [
  "github_token",
  "github_refresh_token",
  "github_expires_at",
  "jira_token",
  "jira_refresh_token",
  "jira_expires_at",
  "jira_site",
  "jira_name",
  "linear_token",
  "linear_refresh_token",
  "linear_expires_at",
  "notion_token",
  "notion_refresh_token",
  "notion_expires_at",
  "figma_token",
  "figma_refresh_token",
  "figma_expires_at",
  "slack_token",
  "slack_refresh_token",
  "slack_expires_at",
  "slack_team",
  "slack_team_id",
  "gitlab_token",
  "gitlab_refresh_token",
  "gitlab_expires_at",
  "bitbucket_token",
  "bitbucket_refresh_token",
  "bitbucket_expires_at",
  "vercel_token",
  "vercel_refresh_token",
  "vercel_expires_at",
  "vercel_team_id",
] as const;
export type VaultSlot = (typeof VAULT_PROVIDER_SLOTS)[number] | (typeof VAULT_CONNECTOR_SLOTS)[number];

export function isVaultSlot(value: unknown): value is VaultSlot {
  return typeof value === "string" &&
    ([...VAULT_PROVIDER_SLOTS, ...VAULT_CONNECTOR_SLOTS] as string[]).includes(value);
}

export const VAULT_VALUE_MAX_CHARS = 4096;

export function isVaultConfigured() {
  return Boolean(process.env.VAULT_MASTER_KEY?.trim());
}

// SHA-256 of the env value → always a valid 32-byte key, whatever format the
// operator pasted (raw string, hex, base64).
function masterKey(): Buffer {
  const raw = process.env.VAULT_MASTER_KEY?.trim();
  if (!raw) throw new Error("VAULT_MASTER_KEY is not configured");
  return crypto.createHash("sha256").update(raw).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VAULT_VERSION, iv.toString("base64"), tag.toString("base64"), data.toString("base64")].join(":");
}

export function decryptSecret(sealed: string): string {
  const [version, iv, tag, data] = sealed.split(":");
  if (version !== VAULT_VERSION || !iv || !tag || !data) throw new Error("Unrecognized vault ciphertext format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

export interface VaultDoc {
  secrets?: Record<string, { enc: string; addedAt: string }>;
}

/** Decrypt selected slots from a vault doc; missing/corrupt slots are skipped. */
export function decryptSlots(doc: VaultDoc | undefined, slots: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!doc?.secrets || !isVaultConfigured()) return out;
  for (const slot of slots) {
    const entry = doc.secrets[slot];
    if (!entry?.enc) continue;
    try {
      out[slot] = decryptSecret(entry.enc);
    } catch {
      // A rotated/lost master key must not break runs, so the slot just drops out.
    }
  }
  return out;
}
