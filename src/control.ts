import {R,S} from './init'

export const forEach = R["forEach"]

export const forSeries =
  fn => async(xs) => {
    for(const x of xs){
      await fn(x)
    }
    return undefined
  }

export const forParallel =
  fn => xs => Promise.all(R.map(fn)(xs))
