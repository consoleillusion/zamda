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

const DEFAULTS =
  { parallelism: 1
  , iterations: 10
  , memorySize: 32768
  , hashLength: 32
  , saltLength: 16
  }

async function hash (password, options = {}) {
  const opts = {...DEFAULTS, ...options}
  const salt = opts.salt ?? await randomBytes(opts.saltLength)
  return argon2id({
    password,
    salt,
    parallelism: opts.parallelism,
    iterations: opts.iterations,
    memorySize: opts.memorySize,
    hashLength: opts.hashLength,
    outputType: 'encoded', // self-describing PHC string; params travel with the hash
  })
}
export { hash as argon2id}

export async function verify(password, encoded) {
  return argon2Verify({password, hash: encoded})
}
