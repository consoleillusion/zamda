import {argon2id, argon2Verify} from 'hash-wasm'

// --- portable CSPRNG: browser/Deno/modern-Node expose globalThis.crypto;
// older Node needs the node:crypto webcrypto shim. Resolved once, lazily. ---
let getRandomValues
async function randomBytes(n) {
  if (!getRandomValues) {
    if (globalThis.crypto?.getRandomValues) {
      getRandomValues = (buf) => globalThis.crypto.getRandomValues(buf)
    } else {
      const {webcrypto} = await import('node:crypto')
      getRandomValues = (buf) => webcrypto.getRandomValues(buf)
    }
  }
  return getRandomValues(new Uint8Array(n))
}

// OWASP-aligned defaults for argon2id (m=19 MiB, t=2, p=1).
const DEFAULTS = {
  parallelism: 1,
  iterations: 10,
  memorySize: 32768, // KiB
  hashLength: 32,
  saltLength: 16,
}

async function hash (password, options = {}) {
  const opts = {...DEFAULTS, ...options}
  const salt = opts.salt ?? await randomBytes(opts.saltLength)
  return argon2id({
    password,
    salt,
    parallelism: opts.parallelism,
    iterations: opts.iterations,
    memorySize: opts.memorySize,
    hashLength: opts.hashLength,
    outputType: 'encoded', // self-describing PHC string; params travel with the hash
  })
}
export { hash as argon2id}

export async function verify(password, encoded) {
  return argon2Verify({password, hash: encoded})
}
/*
export const sha256 =
  async input => {
    if (typeof crypto?.subtle !== "undefined") {
      const data = new TextEncoder().encode(input);
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      return btoa(String.fromCharCode(...new Uint8Array(hashBuffer)))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    } else {
      const { createHash } = await import("crypto");
      return createHash("sha256")
        .update(input)
        .digest("base64")
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
  }
import ag2 from "argon2-browser";
 */
    /*
const sha256Raw = async input =>
  typeof crypto?.subtle !== "undefined"
    ? new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
      )
    : Uint8Array.from(
        (await import("crypto"))
          .createHash("sha256")
          .update(input)
          .digest()
      );

const toHex = bytes =>
  Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");

const toBase64 = bytes =>
  typeof Buffer !== "undefined"
    ? Buffer.from(bytes).toString("base64")
    : btoa(String.fromCharCode(...bytes));

const toBase64Url = bytes =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Public functions
    //
export const sha256Hex       = async input => toHex(await sha256Raw(input));
export const sha256Base64    = async input => toBase64(await sha256Raw(input));
export const sha256Base64Url = async input => toBase64Url(await sha256Raw(input));
export const sha256Base64UrlSync = input => toBase64Url(await sha256Raw(input));
export const sha256          = sha256Base64Url

//export const argon2 = ag2
import { sha256 as _sha256 } from "@noble/hashes/sha2.js";

// formatters
const toHex = bytes => Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");

const toBase64 = bytes =>
  (typeof Buffer !== "undefined" && typeof Buffer.from === "function")
    ? Buffer.from(bytes).toString("base64")
    : btoa(String.fromCharCode(...bytes));

const toBase64Url = bytes => toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/,"");

// core sync hash to bytes (Uint8Array)
const sha256Raw = input =>
  // accept string or Uint8Array
  _sha256(typeof input === "string" ? new TextEncoder().encode(input) : input);

// public sync APIs
export const sha256Hex       = input => toHex(sha256Raw(input));
export const sha256Base64    = input => toBase64(sha256Raw(input));
export const sha256Base64Url = input => toBase64Url(sha256Raw(input));

*/
