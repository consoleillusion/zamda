import $ from 'sanctuary-def'
import {jsonSchemaDef, typeFromSchema} from './jsonSchemaDef.js'

let pass = 0, fail = 0
const is = $.test ([])
const check = (label, T, value, expected) => {
  const got = is (T) (value)
  if (got === expected) { pass++ }
  else { fail++; console.log (`FAIL: ${label} — expected ${expected}, got ${got}  value=${JSON.stringify(value)}`) }
}

// 1. primitive with bounds
{
  const T = typeFromSchema ({type: 'integer', minimum: 1, maximum: 10})
  check ('int in range', T, 5, true)
  check ('int too big', T, 11, false)
  check ('int too small', T, 0, false)
  check ('not integer', T, 5.5, false)
  check ('not number', T, 'x', false)
}

// 2. string format + length + pattern
{
  const T = typeFromSchema ({type: 'string', format: 'email', maxLength: 40})
  check ('valid email', T, 'a@b.com', true)
  check ('bad email', T, 'nope', false)
  const P = typeFromSchema ({type: 'string', pattern: '^[A-Z]{3}$'})
  check ('pattern ok', P, 'ABC', true)
  check ('pattern no', P, 'abc', false)
}

// 3. enum & const (the Bun-sensitive path — must use jsonEqual, not Z.equals)
{
  const T = typeFromSchema ({enum: ['lowerCase', 'upperCase', 'camelCase']})
  check ('enum member', T, 'camelCase', true)
  check ('enum non-member', T, 'aobu', false)
  const C = typeFromSchema ({const: 42})
  check ('const ok', C, 42, true)
  check ('const no', C, 43, false)
  const CO = typeFromSchema ({const: {a: 1, b: [2, 3]}})
  check ('const object ok', CO, {a: 1, b: [2, 3]}, true)
  check ('const object no', CO, {a: 1, b: [2, 4]}, false)
}

// 4. object with required defaulting to all-listed
{
  const T = typeFromSchema ({
    type: 'object',
    properties: {name: {type: 'string'}, age: {type: 'integer', minimum: 0}},
  })
  check ('obj complete', T, {name: 'M', age: 3}, true)
  check ('obj missing age (required by default)', T, {name: 'M'}, false)
  check ('obj wrong type', T, {name: 'M', age: -1}, false)

  const R = typeFromSchema ({
    type: 'object',
    properties: {name: {type: 'string'}, age: {type: 'integer'}},
    required: ['name'],
  })
  check ('explicit required: age optional', R, {name: 'M'}, true)
  check ('explicit required: name missing', R, {age: 3}, false)
}

// 5. additionalProperties false
{
  const T = typeFromSchema ({
    type: 'object',
    properties: {x: {type: 'number'}},
    required: ['x'],
    additionalProperties: false,
  })
  check ('no extras ok', T, {x: 1}, true)
  check ('extra rejected', T, {x: 1, y: 2}, false)
}

// 6. array: homogeneous + uniqueItems
{
  const T = typeFromSchema ({type: 'array', items: {type: 'string'}, minItems: 1, uniqueItems: true})
  check ('arr ok', T, ['a', 'b'], true)
  check ('arr dup', T, ['a', 'a'], false)
  check ('arr empty', T, [], false)
  check ('arr wrong elem', T, ['a', 1], false)
}

// 7. tuple via prefixItems
{
  const T = typeFromSchema ({
    type: 'array',
    prefixItems: [{type: 'string'}, {type: 'integer'}],
    items: false,
  })
  check ('tuple ok', T, ['a', 1], true)
  check ('tuple wrong order', T, [1, 'a'], false)
  check ('tuple too long', T, ['a', 1, 2], false)
}

// 8. combinators
{
  const T = typeFromSchema ({anyOf: [{type: 'string'}, {type: 'integer'}]})
  check ('anyOf string', T, 'x', true)
  check ('anyOf int', T, 3, true)
  check ('anyOf neither', T, true, false)

  const O = typeFromSchema ({oneOf: [{type: 'number', minimum: 0}, {type: 'number', maximum: 5}]})
  check ('oneOf exactly one', O, 10, true)   // only first
  check ('oneOf both match -> fail', O, 3, false)  // matches both

  const N = typeFromSchema ({type: 'string', not: {const: 'forbidden'}})
  check ('not ok', N, 'fine', true)
  check ('not forbidden', N, 'forbidden', false)
}

// 9. $ref with $defs + recursion (linked list)
{
  const schema = {
    $defs: {
      node: {
        type: 'object',
        properties: {
          value: {type: 'integer'},
          next: {anyOf: [{type: 'null'}, {$ref: '#/$defs/node'}]},
        },
        required: ['value'],
      },
    },
    $ref: '#/$defs/node',
  }
  const T = typeFromSchema (schema)
  check ('list depth 0', T, {value: 1, next: null}, true)
  check ('list depth 2', T, {value: 1, next: {value: 2, next: {value: 3, next: null}}}, true)
  check ('list bad inner', T, {value: 1, next: {value: 'x', next: null}}, false)
}

// 10. nullable union via type array
{
  const T = typeFromSchema ({type: ['string', 'null']})
  check ('nullable string', T, 'x', true)
  check ('nullable null', T, null, true)
  check ('nullable number', T, 3, false)
}

// 11. integration with def — must THROW on bad input
{
  const Casing = typeFromSchema ({enum: ['lowerCase', 'upperCase']})
  const env = $.env.concat ([Casing])
  const def = $.create ({checkTypes: true, env})
  const f = def ('f') ({}) ([Casing, $.String]) (c => c.toUpperCase ())
  let threw = false
  try { f ('aobu') } catch { threw = true }
  if (threw) pass++; else { fail++; console.log ('FAIL: def did not throw on bad enum value') }
  // good value works
  if (f ('lowerCase') === 'LOWERCASE') pass++; else { fail++; console.log ('FAIL: def rejected valid value') }
}

console.log (`\n${pass} passed, ${fail} failed`)
process.exit (fail ? 1 : 0)
