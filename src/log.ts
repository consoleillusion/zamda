import {R,S} from './init'

export const log = x => console.log(x)
export const logPipe = x => {console.log(x); return x}
/*
export const performance =
  name => fn => arg => {
    const t0 = performance.now()
    const result = fn(arg)
    const t1 = performance.now()
    return {time: t1 - t0, result}
  }

export const log =
  F.fun ('log')
      ([T.Any,T.Undefined])
      (x => console.log(x))

export const logPipe =
  fun ('log')
      ([G.Any,G.Any])
      (x => { console.log(x); return x })
     */
