import Z from '..'
import { expect, test } from "bun:test";

test("Z.add", () => {
  expect(Z.add(1)(2)).toBe(3);
});

Z.log(Z.Right)
