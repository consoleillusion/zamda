import {init as controlFns} from './src/control.js'
import {init as strFns, TextCasing} from './src/string.js'
import {init as mathFns} from './src/math.js'
import {init as listFns} from './src/list.js'
import * as generalTypes from './src/types.js'
import {init as cryptFns, Argon2Params, Argon2VerifyParams} from './src/crypto.js'
import $ from 'sanctuary-def'
import * as L from 'partial.lenses'
import sanctuary from 'sanctuary'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import {FutureType,env as flutureEnv} from 'fluture-sanctuary-types'
const ajv = addFormats (new Ajv ({allErrors: true, strict: false}))
/*
import {FutureType, ConcurrentFutureType, env as flutureEnv} from 'fluture-sanctuary-types'
*/

const PromiseType = $.UnaryType
  ('Promise')
  ('')
  ([])
  (x => x instanceof Promise)
  (_ => [])

const validateMeta = ajv.compile(
  { $schema: 'https://json-schema.org/draft/2020-12/schema'
  , allOf: [{ $ref: 'https://json-schema.org/draft/2020-12/schema' }]
  , required: ['title']
  })
const JsonSchemaWithTitleType = $.NullaryType
  ('JsonSchemaWithTitleType')
  ('')
  ([])
  (validateMeta)

const env = sanctuary.env.concat(
  [ PromiseType($.Unknown)
  , JsonSchemaWithTitleType
  ]).concat(flutureEnv)
const errorProp = err => err.params?.missingProperty ?? err.instancePath.split('/').filter(Boolean).pop()
const jsonSchemaSanctuary =
  ($.create({checkTypes: true, env}))
    ('jsonSchemaType')
    ({})
    ([JsonSchemaWithTitleType, $.Type])
    (schema => {
      const validate = ajv.compile(schema)
      const T = $.NullaryType
                (schema.title)
                (schema.$id || '')
                ([])
                (validate)
      T.schema = schema
      T.description = schema.description
      T.explain = x => {validate(x); return ajv.errorsText(validate.errors,{dataVar:schema.title})}
      T.explainDetailed = x => {
        validate(x)
        return (validate.errors || []).map(err => {
          const prop = errorProp(err)
          const desc = prop && schema.properties?.[prop]?.description
          return {prop: prop ?? '(root)', message: err.message, description: desc ?? null}
        })
      }
      return T
     })

const makeDefExplained =
  def => name => cs => types => impl => {
    const fn = def(name)(cs)(types)(impl)
    const argTypes = types.slice(0, -1)
    const arity = argTypes.length
    const enrich = (e, args) => {
      const blocks = []
      args.forEach((a, i) => {
        const T = argTypes[i]
        if (T && typeof T.explainDetailed === 'function' && $.test([])(T)(a) === false) {
          const lines = T.explainDetailed(a).map(d =>
            `    ${d.prop}: ${d.message}` + (d.description ? `\n      \u21b3 ${d.description}` : ''))
          blocks.push(`  arg ${i} (${T.name}):\n` + lines.join('\n'))
        }
      })
      if (blocks.length) e.message += '\n\nDetail:\n' + blocks.join('\n')
      return e
    }
    const step = (collected) => (arg) => {
      const args = [...collected, arg]
      let next
      try { next = args.reduce((f, a) => f(a), fn) }
      catch (e) { throw enrich(e, args) }
      return args.length >= arity ? next : step(args)
    }
    return step([])
  }
const init =
  opts => {
    opts = {jsonSchemas:[],checkTypes:true,...opts}
    const extraTypes =
      [ TextCasing,Argon2Params,Argon2VerifyParams,...opts.jsonSchemas].map(x=>jsonSchemaSanctuary(x))
      .concat(Object.values(generalTypes))
    const envUser = env.concat(extraTypes)
    const Z   = {...sanctuary.create({ checkTypes: opts.checkTypes, env: envUser }),jsonSchemaSanctuary}
    const defOriginal = $.create({ checkTypes: opts.checkTypes, env: envUser })
    const def = makeDefExplained(defOriginal)
    const types =
      { ...$
      , PromiseType
      , JsonSchemaWithTitleType
      , ...Object.fromEntries(extraTypes.map(t => [t.name, t]))
      , FutureType
      }
    return (
    { Z:
      { ...Z
      , ...L
      , ...strFns({Z,def,$:types})
      , ...cryptFns({Z,def,$:types})
      , ...controlFns({Z,def,$:types})
      , ...mathFns({Z,def,$:types})
      , ...listFns({Z,def,$:types})
      }
    , def
    , $: types
    })
  }
export default init
