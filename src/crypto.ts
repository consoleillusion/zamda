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

