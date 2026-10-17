/**
 * SHA-256 digests for reviewed-operation manifests.
 */

/**
 * Hash UTF-8 text with SHA-256.
 *
 * @param text - Text to hash, usually a `JSON.stringify` manifest.
 * @returns The digest as 64 lowercase hex characters.
 * @example
 * const digest = await sha256Hex(JSON.stringify(manifest));
 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
