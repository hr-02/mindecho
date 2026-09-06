import crypto from "node:crypto";

// Stably derive a 32-byte AES-256 key from server environment or secret
const SECRET_SEED =
  process.env.VAULT_ENCRYPTION_KEY ||
  process.env.GEMINI_API_KEY ||
  "mindecho-internal-vault-salt-key-2026";

const MASTER_KEY = crypto.createHash("sha256").update(SECRET_SEED).digest();

/**
 * Encrypts an API key using AES-256-GCM.
 * Returns an unforgeable payload: "ivHex:authTagHex:encryptedHex"
 */
export function encryptApiKey(plainTextKey) {
  if (!plainTextKey || typeof plainTextKey !== "string") {
    throw new Error("Invalid API key to encrypt");
  }
  const iv = crypto.randomBytes(12); // Standard 96-bit IV for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", MASTER_KEY, iv);
  let encrypted = cipher.update(plainTextKey.trim(), "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Decrypts an AES-256-GCM encrypted payload.
 * Returns the plaintext key or null if tampering or decryption failure occurs.
 */
export function decryptApiKey(encryptedPayload) {
  if (!encryptedPayload || typeof encryptedPayload !== "string") return null;
  const parts = encryptedPayload.split(":");
  if (parts.length !== 3) return null;
  const [ivHex, authTagHex, encryptedHex] = parts;
  try {
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", MASTER_KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedHex, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted.trim();
  } catch (err) {
    console.error("Failed to decrypt user API key from vault:", err.message);
    return null;
  }
}
