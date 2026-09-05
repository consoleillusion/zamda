// crypto.ts
import {argon2id, argon2Verify} from 'hash-wasm'
let getRandomValues
const getRNG =
  async _ => {
    if(!getRandomValues) {
      getRandomValues = globalThis.crypto?.getRandomValues
                      ? buf => globalThis.crypto.getRandomValues(buf)
                      : async buf => (await import('node:crypto')).webcrypto.getRandomValues(buf)
    }
    return getRandomValues
  }
const argon2Defaults =
  { parallelism: 1
  , iterations: 10
  , memorySize: 32768
  , hashLength: 32
  , saltLength: 16
  , outputType: 'encoded'
  }

export const Argon2Params =
  { $schema: 'https://json-schema.org/draft/2020-12/schema'
  , $id: 'https://example.com/schemas/argon2Params.json'
  , title: 'Argon2Params'
  , description: 'Parameters for an argon2id password hashing operation.'
  , type: 'object'
  , properties:
    { parallelism: {type: 'integer', description: "Number of parallel lanes/threads (argon2 'p').", minimum: 1, maximum: 16777215, default: 1}
    , iterations:  {type: 'integer', description: "Number of passes over memory (argon2 't' / time cost).", minimum: 1, maximum: 4294967295, default: 10}
    , memorySize:  {type: 'integer', description: "Memory cost in kibibytes (argon2 'm'). Must be at least 8*parallelism.", minimum: 8, maximum: 4294967295, default: 32768}
    , hashLength:  {type: 'integer', description: 'Length of the derived key/tag in bytes.', minimum: 4, maximum: 4294967295, default: 32}
    , saltLength:  {type: 'integer', description: 'Length of the generated salt in bytes.', minimum: 8, maximum: 4294967295, default: 16}
    , outputType:  {type: 'string', description: "Output encoding: 'encoded' returns the PHC string; 'raw' returns raw hash bytes.", enum: ['encoded', 'raw'], default: 'encoded'}
    , password:    {type: 'string', description: "The plaintext password to hash (or verify against 'hash')."}
    , hash:        {type: 'string', description: 'An existing argon2 hash (PHC-format string) for verification.'}
    }
  , required: ['password']
  , additionalProperties: false
  }
export const init =
  ({Z,def,$}) => {
    const randomBytes =
      def('randomBytes')
         ({})
         ([$.NonNegativeInteger, $.PromiseType($.U8)])
         (async n => {
           const bytes = (await getRNG())(new Uint8Array(n))
           return $.test([])($.U8)(bytes) ? bytes : (() => { throw new TypeError('randomBytes: RNG did not return Uint8Array') })()
         })
    return (
      { randomBytes: randomBytes
      , argon2id:
          def('argon2id')
            ({})
            ([$.Argon2Params, $.String])
            (async opts => argon2id(
              { ...argon2Defaults
              , ...opts
              , salt: opts.salt ?? await randomBytes(opts.saltLength ?? argon2Defaults.saltLength)
              }))
      , argon2Verify: async opts => argon2Verify(opts)
      })
  }

//index.ts
import {init as strFns, TextCasing} from './src/string'
import * as generalTypes from './src/types'
import {init as cryptFns, Argon2Params} from './src/crypto'
import $ from 'sanctuary-def'
import sanctuary from 'sanctuary'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
const ajv = addFormats (new Ajv ({allErrors: true, strict: false}))
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
  ])
const jsonSchemaSanctuary =
  ($.create({checkTypes: true, env}))
    ('jsonSchemaType')
    ({})
    ([JsonSchemaWithTitleType, $.Type])
    (schema => {
      const validate = ajv.compile(schema)
      return $.NullaryType
                (schema.title)
                (schema.$id || '')
                ([])
                (validate)
     })
const init =
  opts => {
    opts = {jsonSchemas:[],checkTypes:true,...opts}
    const extraTypes = [TextCasing,Argon2Params,...opts.jsonSchemas].map(x=>jsonSchemaSanctuary(x)).concat(Object.values(generalTypes))
    const envUser = env.concat(extraTypes)
    const Z   = {...sanctuary.create({ checkTypes: opts.checkTypes, env: envUser }),jsonSchemaSanctuary}
    const def = $.create({ checkTypes: opts.checkTypes, env: envUser })
    const types =
      { ...$
      , PromiseType
      , JsonSchemaWithTitleType
      , ...Object.fromEntries(extraTypes.map(t => [t.name, t]))
      }
    return (
    { Z:
      { ...strFns({Z,def,$:types})
      , ...cryptFns({Z,def,$:types})
      }
    , def
    , $: types
    })
  }
export default init
// string.ts
import * as changeCaseLib from 'change-case'

export const TextCasing =
  { title: 'TextCasing'
  , type: 'string'
  , enum: ['camelCase','capitalCase','constantCase','dotCase','kebabCase','noCase','pascalCase','pascalSnakeCase','pathCase','sentenceCase','snakeCase','trainCase','lowerCase','upperCase']
  }

export const init =
  ({Z,def,$}) => {

    return (
      { changeCase:
          def('changeCase')
            ({})
            ([$.TextCasing,$.String,$.String])
            (textCasing => str => ['lowerCase','upperCase'].includes(textCasing)
                                  ? (textCasing === 'lowerCase' ? str.toLowerCase() : str.toUpperCase())
                                  : changeCaseLib[textCasing](str))

      , trim:
          def('trim')
            ({})
            ([$.String,$.String])
            (str => str.trim())

      , replace:
          def('replace')
            ({})
            ([$.RegExp, $.Fn($.String)($.String), $.String, $.String])
            (regex => fn => str => str.replace(regex, fn))
      })
  }
// types.ts
import $ from 'sanctuary-def'

export const U8 = $.NullaryType('Uint8Array')('')([])(x => x instanceof Uint8Array)
