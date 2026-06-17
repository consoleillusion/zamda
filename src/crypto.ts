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
    , outputType:  {type: 'string',  description: "Output encoding: 'encoded' returns the PHC string; 'raw' returns raw hash bytes.", enum: ['encoded', 'raw'], default: 'encoded'}
    , password:    {type: 'string',  description: "The plaintext password to hash (or verify against 'hash')."}
    , hash:        {type: 'string',  description: 'An existing argon2 hash (PHC-format string) for verification.'}
    , salt:        {type: 'string',  description: 'Optional pre-generated salt (raw bytes or string).'}
    }
  , required: ['password']
  , additionalProperties: false
  }

export const Argon2VerifyParams =
  { title: 'Argon2VerifyParams'
  , type: 'object'
  , properties:
    { password: {type: 'string', description: 'The plaintext password to verify.'}
    , hash:     {type: 'string', description: 'The argon2 PHC-format hash to verify against.',pattern: '^\\$argon2(id|i|d)\\$v=\\d+\\$m=\\d+,t=\\d+,p=\\d+(?:,keyid=[A-Za-z0-9+/]+)?(?:,data=[A-Za-z0-9+/]+)?\\$[A-Za-z0-9+/]+\\$[A-Za-z0-9+/]+$'}
    }
  , required: ['password', 'hash']
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
            ([$.Argon2Params, $.PromiseType($.String)])
            (async opts => argon2id(
              { ...argon2Defaults
              , ...opts
              , salt: opts.salt ?? await randomBytes(opts.saltLength ?? argon2Defaults.saltLength)
              }))
     , argon2Verify:
          def('argon2Verify')
            ({})
            ([$.Argon2VerifyParams, $.PromiseType($.Boolean)])
            (async opts => argon2Verify(opts))
      })
  }
