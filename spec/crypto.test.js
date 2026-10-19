import { expect, test, describe } from "bun:test"
import { Z } from "./setup.js"

describe("crypto", () => {
  describe("argon2id", () => {
    test("produces a PHC hash", async () => {
      const hash = await Z.argon2id({ password: 'correct horse battery staple' })
      expect(hash.startsWith('$argon2id$')).toBe(true)
    })
    test("salts: same password, different hashes", async () => {
      const a = await Z.argon2id({ password: 'the merit of all things lies in their difficulty' })
      const b = await Z.argon2id({ password: 'the merit of all things lies in their difficulty' })
      expect(a).not.toBe(b)
    })
  })

  describe("argon2Verify", () => {
    test("round-trip verifies the right password", async () => {
      const password = 'still waters run deep'
      const hash = await Z.argon2id({ password })
      expect(await Z.argon2Verify({ password, hash })).toBe(true)
    })
    test("rejects the wrong password", async () => {
      const hash = await Z.argon2id({ password: 'he who knows does not speak' })
      expect(await Z.argon2Verify({ password: 'he who speaks does not know', hash })).toBe(false)
    })
    test("rejects a malformed hash", () => {
      expect(() => Z.argon2Verify({ password: 'password123', hash: '3' })).toThrow()
    })
  })
})
