import { expect, test, describe } from "bun:test"
import { Z } from "./setup.ts"

describe("math", () => {

  describe("add", () => {
    test('adding', () => {
      expect(Z.add(1)(2)).toBe(3)
    })
    test('adding', () => {
      expect(() => Z.add(1)('2')).toThrow()
    })
  })
})
