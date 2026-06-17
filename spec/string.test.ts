import { expect, test, describe } from "bun:test"
import { Z } from "./setup.ts"

describe("string", () => {
  describe("changeCase", () => {
    test("pascalCase", () => {
      expect(Z.changeCase('pascalCase')('the duck stares into the abyss')).toBe('TheDuckStaresIntoTheAbyss')
    })
    test("snakeCase from camel input", () => {
      expect(Z.changeCase('snakeCase')('quietNonBitterLoneliness')).toBe('quiet_non_bitter_loneliness')
    })
  })

  describe("replace", () => {
    test("reports the offset of every match", () => {
      expect(Z.replace(/e/g)(x => "" + x.offset)('sovereignty')).toBe('sov3r5ignty')
    })
    test("exposes capture groups", () => {
      expect(Z.replace(/(\d)/g)(x => `[${x.ps[0]}]`)('room 101, cell 6')).toBe('room [1][0][1], cell [6]')
    })
  })

  describe("split / join", () => {
    test("split on empty string explodes into characters", () => {
      expect(Z.split('')('duck')).toEqual(['d', 'u', 'c', 'k'])
    })
    test("join inverts split on a single delimiter", () => {
      const s = 'the quieter you become the more you are able to hear'
      expect(Z.join(' ')(Z.split(' ')(s))).toBe(s)
    })
    test("join with a multi-char unicode separator", () => {
      expect(Z.join(' \u2192 ')(['abyss', 'fish', 'duck'])).toBe('abyss \u2192 fish \u2192 duck')
    })
  })
})
