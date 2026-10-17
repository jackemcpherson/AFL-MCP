import { expect, it } from "vitest";
import { sha256Hex } from "../../src/lib/hash";

it.each([
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  // Hashes the UTF-8 bytes C3 A9, not the UTF-16 code unit.
  ["é", "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c"],
])("hashes %j to its SHA-256 test vector", async (text, digest) => {
  expect(await sha256Hex(text)).toBe(digest);
});
