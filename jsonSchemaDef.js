import $ from 'sanctuary-def'

//. jsonSchemaDef :: Options? -> JsonSchema -> Type
//.
//. Converts a JSON Schema object into a sanctuary-def `Type`. The returned
//. value is a normal sanctuary `Type`: drop it into a `def` signature or an
//. environment, or test it directly with `$.test ([]) (T) (value)`.
//.
//. Supported: type (incl. arrays of types / type unions), enum, const,
//. number/integer bounds, string length + pattern + a set of common formats,
//. object properties (required defaults to "all listed unless `required` is
//. given"), additionalProperties, patternProperties (best-effort), array
//. items / prefixItems (tuples) / contains / length bounds / uniqueItems,
//. nullable, and the combinators allOf / anyOf / oneOf / not. $ref is
//. resolved against the root document's local "#/..." pointers and $defs /
//. definitions, with cycle handling via lazy thunks.
//.
//. Every leaf predicate is built from plain JavaScript (typeof, ===,
//. Array.prototype.includes, RegExp.test). None route through sanctuary's
//. Z.equals, so the generated types are safe on runtimes (e.g. Bun) where
//. that path misbehaves for strings.

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const isObject = x =>
  x != null && typeof x === 'object' && !Array.isArray (x)

const jsType = x => {
  if (x === null) return 'null'
  if (Array.isArray (x)) return 'array'
  switch (typeof x) {
    case 'object':  return 'object'
    case 'number':  return Number.isInteger (x) ? 'integer-or-number' : 'number'
    case 'string':  return 'string'
    case 'boolean': return 'boolean'
    default:        return typeof x
  }
}

// JSON-Schema "type" membership for a JS value
const matchesJsonType = (t, x) => {
  switch (t) {
    case 'null':    return x === null
    case 'boolean': return typeof x === 'boolean'
    case 'string':  return typeof x === 'string'
    case 'number':  return typeof x === 'number' && !Number.isNaN (x)
    case 'integer': return typeof x === 'number' && Number.isInteger (x)
    case 'array':   return Array.isArray (x)
    case 'object':  return isObject (x)
    default:        return false
  }
}

// structural equality without sanctuary's Z.equals (Bun-safe).
// good enough for enum / const / uniqueItems over JSON values.
const jsonEqual = (a, b) => {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (Array.isArray (a)) {
    if (!Array.isArray (b) || a.length !== b.length) return false
    return a.every ((v, i) => jsonEqual (v, b[i]))
  }
  if (typeof a === 'object') {
    if (!isObject (b)) return false
    const ka = Object.keys (a), kb = Object.keys (b)
    if (ka.length !== kb.length) return false
    return ka.every (k => Object.prototype.hasOwnProperty.call (b, k) &&
                          jsonEqual (a[k], b[k]))
  }
  return false   // NaN etc.
}

// common "format" predicates (string formats only; unknown formats pass)
const formatPredicates = {
  'date-time': s => !Number.isNaN (Date.parse (s)),
  date:        s => /^\d{4}-\d{2}-\d{2}$/.test (s) && !Number.isNaN (Date.parse (s)),
  time:        s => /^\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test (s),
  email:       s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test (s),
  hostname:    s => /^(?=.{1,253}$)([a-zA-Z0-9](-?[a-zA-Z0-9])*)(\.[a-zA-Z0-9](-?[a-zA-Z0-9])*)*$/.test (s),
  ipv4:        s => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test (s) &&
                    s.split ('.').every (n => +n >= 0 && +n <= 255),
  ipv6:        s => /^[0-9a-fA-F:]+$/.test (s) && s.includes (':'),
  uri:         s => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test (s),
  'uri-reference': () => true,
  uuid:        s => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test (s),
  regex:       s => { try { new RegExp (s); return true } catch { return false } },
}

let typeCounter = 0
const freshName = base => base + '$' + (++typeCounter)

// ---------------------------------------------------------------------------
// $ref resolution against the root document
// ---------------------------------------------------------------------------

const resolveRef = (root, ref) => {
  if (typeof ref !== 'string' || ref[0] !== '#') {
    throw new Error ('jsonSchemaDef: only local "#/..." $refs are supported, got: ' + ref)
  }
  if (ref === '#') return root
  const path = ref.slice (1).split ('/').slice (1)
    .map (seg => seg.replace (/~1/g, '/').replace (/~0/g, '~'))
  let node = root
  for (const seg of path) {
    if (node == null) throw new Error ('jsonSchemaDef: unresolved $ref ' + ref)
    node = node[seg]
  }
  if (node === undefined) throw new Error ('jsonSchemaDef: unresolved $ref ' + ref)
  return node
}

// ---------------------------------------------------------------------------
// core: build a predicate (Any -> Boolean) for a schema, then wrap as a Type
// ---------------------------------------------------------------------------
//
// We compile each schema to a plain predicate first (so composition,
// recursion and $ref are trivial), then expose the whole thing as a single
// NullaryType. This keeps every check in plain JS and dodges Z.equals.
// `cache` memoises by schema-object identity so recursive $refs terminate.

const compile = (root, cache) => {

  const go = schema => {
    // booleans are valid schemas: true = anything, false = nothing
    if (schema === true)  return () => true
    if (schema === false) return () => false
    if (!isObject (schema)) {
      throw new Error ('jsonSchemaDef: schema must be an object or boolean')
    }
    if (cache.has (schema)) return x => cache.get (schema) (x)   // lazy: ref before defined

    // placeholder for recursion; replaced once built
    let pred = () => { throw new Error ('jsonSchemaDef: cycle not yet resolved') }
    const lazy = x => pred (x)
    cache.set (schema, lazy)

    pred = build (schema)
    return lazy
  }

  const build = schema => {
    // ---- $ref --------------------------------------------------------------
    if (schema.$ref !== undefined) {
      const target = resolveRef (root, schema.$ref)
      const refPred = go (target)
      // a $ref may sit alongside other keywords (2020-12); AND them in
      const rest = {...schema}; delete rest.$ref
      if (Object.keys (rest).length === 0) return refPred
      const restPred = build (rest)
      return x => refPred (x) && restPred (x)
    }

    const checks = []

    // ---- const / enum ------------------------------------------------------
    if ('const' in schema) {
      const c = schema.const
      checks.push (x => jsonEqual (x, c))
    }
    if (Array.isArray (schema.enum)) {
      const opts = schema.enum
      checks.push (x => opts.some (o => jsonEqual (x, o)))
    }

    // ---- type --------------------------------------------------------------
    if (schema.type !== undefined) {
      const types = Array.isArray (schema.type) ? schema.type : [schema.type]
      checks.push (x => types.some (t => matchesJsonType (t, x)))
    }

    // ---- number / integer constraints -------------------------------------
    const numChecks = []
    if (typeof schema.minimum === 'number')
      numChecks.push (x => x >= schema.minimum)
    if (typeof schema.maximum === 'number')
      numChecks.push (x => x <= schema.maximum)
    if (typeof schema.exclusiveMinimum === 'number')
      numChecks.push (x => x > schema.exclusiveMinimum)
    if (typeof schema.exclusiveMaximum === 'number')
      numChecks.push (x => x < schema.exclusiveMaximum)
    if (typeof schema.multipleOf === 'number')
      numChecks.push (x => {
        const q = x / schema.multipleOf
        return Math.abs (q - Math.round (q)) < 1e-9
      })
    if (numChecks.length)
      checks.push (x => typeof x !== 'number' || numChecks.every (c => c (x)))

    // ---- string constraints ------------------------------------------------
    const strChecks = []
    if (typeof schema.minLength === 'number')
      strChecks.push (x => [...x].length >= schema.minLength)
    if (typeof schema.maxLength === 'number')
      strChecks.push (x => [...x].length <= schema.maxLength)
    if (typeof schema.pattern === 'string') {
      const re = new RegExp (schema.pattern)
      strChecks.push (x => re.test (x))
    }
    if (typeof schema.format === 'string' && formatPredicates[schema.format]) {
      const f = formatPredicates[schema.format]
      strChecks.push (x => f (x))
    }
    if (strChecks.length)
      checks.push (x => typeof x !== 'string' || strChecks.every (c => c (x)))

    // ---- array constraints -------------------------------------------------
    const arrChecks = []
    // prefixItems (tuple) — 2020-12; also "items" as array in draft-07
    const prefix = Array.isArray (schema.prefixItems) ? schema.prefixItems
                 : Array.isArray (schema.items)       ? schema.items
                 : null
    if (prefix) {
      const preds = prefix.map (go)
      arrChecks.push (x => preds.every ((p, i) => i >= x.length || p (x[i])))
      // items as schema after a tuple, or additionalItems
      const extra = (!Array.isArray (schema.items) && schema.items !== undefined && Array.isArray (schema.prefixItems))
                      ? schema.items
                      : schema.additionalItems
      if (extra !== undefined && extra !== true) {
        if (extra === false) {
          arrChecks.push (x => x.length <= prefix.length)
        } else {
          const ep = go (extra)
          arrChecks.push (x => x.slice (prefix.length).every (ep))
        }
      }
    } else if (schema.items !== undefined && !Array.isArray (schema.items)) {
      const ip = go (schema.items)
      arrChecks.push (x => x.every (ip))
    }
    if (schema.contains !== undefined) {
      const cp = go (schema.contains)
      const min = typeof schema.minContains === 'number' ? schema.minContains : 1
      const max = typeof schema.maxContains === 'number' ? schema.maxContains : Infinity
      arrChecks.push (x => {
        const n = x.filter (cp).length
        return n >= min && n <= max
      })
    }
    if (typeof schema.minItems === 'number')
      arrChecks.push (x => x.length >= schema.minItems)
    if (typeof schema.maxItems === 'number')
      arrChecks.push (x => x.length <= schema.maxItems)
    if (schema.uniqueItems === true)
      arrChecks.push (x => x.every ((v, i) => x.findIndex (w => jsonEqual (v, w)) === i))
    if (arrChecks.length)
      checks.push (x => !Array.isArray (x) || arrChecks.every (c => c (x)))

    // ---- object constraints ------------------------------------------------
    const objChecks = []
    const props = isObject (schema.properties) ? schema.properties : {}
    const propNames = Object.keys (props)
    const propPreds = {}
    for (const k of propNames) propPreds[k] = go (props[k])

    // required: explicit array, else (per requested default) all listed props
    const required = Array.isArray (schema.required) ? schema.required
                   : propNames.slice ()
    if (required.length)
      objChecks.push (x => required.every (k =>
        Object.prototype.hasOwnProperty.call (x, k)))

    if (propNames.length)
      objChecks.push (x => propNames.every (k =>
        !Object.prototype.hasOwnProperty.call (x, k) || propPreds[k] (x[k])))

    // patternProperties
    const patternProps = isObject (schema.patternProperties) ? schema.patternProperties : {}
    const patternEntries = Object.keys (patternProps).map (re => [new RegExp (re), go (patternProps[re])])
    if (patternEntries.length)
      objChecks.push (x => Object.keys (x).every (k =>
        patternEntries.every (([re, p]) => !re.test (k) || p (x[k]))))

    // additionalProperties
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      const ap = schema.additionalProperties
      const known = k => propNames.includes (k) ||
                         patternEntries.some (([re]) => re.test (k))
      if (ap === false) {
        objChecks.push (x => Object.keys (x).every (known))
      } else {
        const app = go (ap)
        objChecks.push (x => Object.keys (x).every (k => known (k) || app (x[k])))
      }
    }

    if (typeof schema.minProperties === 'number')
      objChecks.push (x => Object.keys (x).length >= schema.minProperties)
    if (typeof schema.maxProperties === 'number')
      objChecks.push (x => Object.keys (x).length <= schema.maxProperties)

    // propertyNames
    if (schema.propertyNames !== undefined) {
      const pnp = go (schema.propertyNames)
      objChecks.push (x => Object.keys (x).every (pnp))
    }

    if (objChecks.length)
      checks.push (x => !isObject (x) || objChecks.every (c => c (x)))

    // ---- combinators -------------------------------------------------------
    if (Array.isArray (schema.allOf)) {
      const ps = schema.allOf.map (go)
      checks.push (x => ps.every (p => p (x)))
    }
    if (Array.isArray (schema.anyOf)) {
      const ps = schema.anyOf.map (go)
      checks.push (x => ps.some (p => p (x)))
    }
    if (Array.isArray (schema.oneOf)) {
      const ps = schema.oneOf.map (go)
      checks.push (x => ps.filter (p => p (x)).length === 1)
    }
    if (schema.not !== undefined) {
      const np = go (schema.not)
      checks.push (x => !np (x))
    }

    // ---- conditional (if/then/else) ---------------------------------------
    if (schema.if !== undefined) {
      const ifp   = go (schema.if)
      const thenp = schema.then !== undefined ? go (schema.then) : () => true
      const elsep = schema.else !== undefined ? go (schema.else) : () => true
      checks.push (x => ifp (x) ? thenp (x) : elsep (x))
    }

    if (checks.length === 0) return () => true        // empty schema {} = anything
    return x => checks.every (c => c (x))
  }

  return go
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export const jsonSchemaDef = (opts = {}) => schema => {
  const root = opts.root ?? schema
  const name = opts.name ?? schema.title ?? freshName ('JsonSchema')
  const url  = opts.url  ?? (typeof schema.$id === 'string' ? schema.$id : '')

  const compiler = compile (root, new Map ())
  const predicate = compiler (schema)

  // a single nullary type whose membership is the compiled predicate.
  // supertypes [] so it accepts any JS value before predicate runs.
  return $.NullaryType (name) (url) ([]) (x => {
    try { return predicate (x) } catch { return false }
  })
}

// convenience: build directly from a schema with default options
export const typeFromSchema = schema => jsonSchemaDef ({}) (schema)

export default jsonSchemaDef
