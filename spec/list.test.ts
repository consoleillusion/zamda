import { expect, test, describe } from "bun:test"
import { Z } from "./setup.ts"

describe("list", () => {
  describe("map", () => {
    test("doubles, preserving sign and fractions", () => {
      expect(Z.map(x => x * 2)([0.5, -3, 2.5])).toEqual([1, -6, 5])
    })
    test("over empty array is empty", () => {
      expect(Z.map(x => x * 2)([])).toEqual([])
    })
  })

  describe("forSeries", () => {
    test("visits every element in order", async () => {
      const seen = []
      await Z.forSeries(async x => { seen.push(x * 2) })([1, 2, 3])
      expect(seen).toEqual([2, 4, 6])
    })
    test("stays sequential despite inverted delays", async () => {
      const seen = []
      await Z.forSeries(async x => {
        await new Promise(r => setTimeout(r, (4 - x) * 10))
        seen.push(x)
      })([1, 2, 3])
      expect(seen).toEqual([1, 2, 3])
    })
  })
})
