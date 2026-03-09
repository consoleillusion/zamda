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
 */

  // Core hashing (cross-platform)
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

// Formatters
const toHex = bytes =>
  Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");

const toBase64 = bytes =>
  typeof Buffer !== "undefined"
    ? Buffer.from(bytes).toString("base64")
    : btoa(String.fromCharCode(...bytes));

const toBase64Url = bytes =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Public functions
export const sha256Hex = async input => toHex(await sha256Raw(input));
export const sha256Base64 = async input => toBase64(await sha256Raw(input));
export const sha256Base64Url = async input => toBase64Url(await sha256Raw(input));
export const sha256 = sha256Base64Url
