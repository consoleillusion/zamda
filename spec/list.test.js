import { expect, test, describe } from "bun:test"
import { Z } from "./setup.js"

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
  
  describe("mapParallel", () => {
    test("maps async fn over array, resolving to results", async () => {
      const out = await Z.mapParallel(x => Promise.resolve(x * 2))([0.5, -3, 2.5])
      expect(out).toEqual([1, -6, 5])
    })

    test("preserves input order even when later items resolve sooner", async () => {
      const delay = (ms, v) => new Promise(r => setTimeout(() => r(v), ms))
      const out = await Z.mapParallel(x => delay(x, x))([30, 10, 20])
      expect(out).toEqual([30, 10, 20])
    })

    test("runs concurrently — total time near the slowest, not the sum", async () => {
      const delay = ms => new Promise(r => setTimeout(() => r(ms), ms))
      const start = Date.now()
      await Z.mapParallel(delay)([100, 100, 100])
      const elapsed = Date.now() - start
      expect(elapsed).toBeLessThan(250)   // ~100ms concurrent, not ~300ms
    })

    test("over empty array resolves to empty", async () => {
      const out = await Z.mapParallel(x => Promise.resolve(x * 2))([])
      expect(out).toEqual([])
    })

    test("rejects if any element rejects", async () => {
      await expect(
        Z.mapParallel(x => x === 2 ? Promise.reject(new Error("boom")) : Promise.resolve(x))([1, 2, 3])
      ).rejects.toThrow("boom")
    })
  })

  describe("mapSeries", () => {
    test("maps async fn over array, resolving to results", async () => {
      const out = await Z.mapSeries(x => Promise.resolve(x * 2))([0.5, -3, 2.5])
      expect(out).toEqual([1, -6, 5])
    })

    test("preserves input order", async () => {
      const delay = (ms, v) => new Promise(r => setTimeout(() => r(v), ms))
      const out = await Z.mapSeries(x => delay(x, x))([30, 10, 20])
      expect(out).toEqual([30, 10, 20])
    })

    test("runs sequentially — each call starts after the previous resolves", async () => {
      const order = []
      const step = x => new Promise(r => setTimeout(() => { order.push(x); r(x) }, 20))
      await Z.mapSeries(step)([1, 2, 3])
      expect(order).toEqual([1, 2, 3])   // strict completion order
    })

    test("total time near the sum, not the slowest", async () => {
      const delay = ms => new Promise(r => setTimeout(() => r(ms), ms))
      const start = Date.now()
      await Z.mapSeries(delay)([50, 50, 50])
      const elapsed = Date.now() - start
      expect(elapsed).toBeGreaterThan(140)   // ~150ms sequential, not ~50ms
    })

    test("over empty array resolves to empty", async () => {
      const out = await Z.mapSeries(x => Promise.resolve(x * 2))([])
      expect(out).toEqual([])
    })

    test("rejects if any element rejects, stopping the chain", async () => {
      const seen = []
      await expect(
        Z.mapSeries(x => {
          seen.push(x)
          return x === 2 ? Promise.reject(new Error("boom")) : Promise.resolve(x)
        })([1, 2, 3])
      ).rejects.toThrow("boom")
      expect(seen).toEqual([1, 2])   // never reached 3 — series short-circuits
    })
  })

})
