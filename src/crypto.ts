import {argon2id, argon2Verify} from 'hash-wasm'

let getRandomValues

const randomBytes = 
  async n => {
    if (!getRandomValues) {
      if (globalThis.crypto?.getRandomValues) {
        getRandomValues = (buf) => globalThis.crypto.getRandomValues(buf)
      } else {
        const {webcrypto} = await import('node:crypto')
        getRandomValues = (buf) => webcrypto.getRandomValues(buf)
      }
    }
    return getRandomValues(new Uint8Array(n))
  }

const defaults =
  { parallelism: 1
  , iterations: 10
  , memorySize: 32768
  , hashLength: 32
  , saltLength: 16
  , outputType: 'encoded'
  }

const hash =
  async opts => argon2id(
    { ...defaults
    , ...opts
    , salt: opts.salt ?? await randomBytes(opts.saltLength ?? defaults.saltLength)
    })

export { hash as argon2id}

const verify = async opts => argon2Verify(opts)
export {verify as argon2Verify}
