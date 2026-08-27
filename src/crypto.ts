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

export const randomBytes = 
  async n => (await getRNG())(new Uint8Array(n))

const argon2Defaults =
  { parallelism: 1
  , iterations: 10
  , memorySize: 32768
  , hashLength: 32
  , saltLength: 16
  , outputType: 'encoded'
  }

const argon2idDigest =
  async opts => argon2id(
    { ...argon2Defaults
    , ...opts
    , salt: opts.salt ?? await randomBytes(opts.saltLength ?? argon2Defaults.saltLength)
    })
const verify = async opts => argon2Verify(opts)

export {argon2idDigest as argon2id}
export {verify as argon2Verify}
