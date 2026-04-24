import {R,S} from './init'

export const adjust = R["adjust"]
export const all = R["all"]
export const any = R["any"]
export const aperture = R["aperture"]
export const append = R["append"]
export const chain = R["chain"]
export const collectBy = R["collectBy"]
export const concat = R["concat"]
export const count = R["count"]
export const drop = R["drop"]
export const dropLast = R["dropLast"]
export const dropLastWhile = R["dropLastWhile"]
export const dropRepeats = R["dropRepeats"]
export const dropRepeatsBy = R["dropRepeatsBy"]
export const dropRepeatsWith = R["dropRepeatsWith"]
export const dropWhile = R["dropWhile"]
export const endsWith = R["endsWith"]
export const filter = R["filter"]
export const find = R["find"]
export const findIndex = R["findIndex"]
export const findLast = R["findLast"]
export const findLastIndex = R["findLastIndex"]
export const flatten = R["flatten"]
export const fromPairs = R["fromPairs"]
export const groupBy = R["groupBy"]
export const groupWith = R["groupWith"]
export const head = R["head"]
export const includes = R["includes"]
export const indexBy = R["indexBy"]
export const indexOf = R["indexOf"]
export const init = R["init"]
export const insert = R["insert"]
export const insertAll = R["insertAll"]
export const intersperse = R["intersperse"]
export const into = R["into"]
export const join = R["join"]
export const last = R["last"]
export const lastIndexOf = R["lastIndexOf"]
export const length = R["length"]
export const map = R["map"]
export const mapAccum = R["mapAccum"]
export const mapAccumRight = R["mapAccumRight"]
export const mergeAll = R["mergeAll"]
export const move = R["move"]
export const none = R["none"]
export const nth = R["nth"]
export const pair = R["pair"]
export const partition = R["partition"]
export const pluck = R["pluck"]
export const prepend = R["prepend"]
export const range = R["range"]
export const rebuild = R["rebuild"]
export const reduce = R["reduce"]
export const reduceBy = R["reduceBy"]
export const reduced = R["reduced"]
export const reduceRight = R["reduceRight"]
export const reduceWhile = R["reduceWhile"]
export const reject = R["reject"]
export const remove = R["remove"]
export const repeat = R["repeat"]
export const reverse = R["reverse"]
export const scan = R["scan"]
export const sequence = R["sequence"]
export const slice = R["slice"]
export const sort = R["sort"]
export const splitAt = R["splitAt"]
export const splitEvery = R["splitEvery"]
export const splitWhen = R["splitWhen"]
export const splitWhenever = R["splitWhenever"]
export const startsWith = R["startsWith"]
export const swap = R["swap"]
export const tail = R["tail"]
export const take = R["take"]
export const takeLast = R["takeLast"]
export const takeLastWhile = R["takeLastWhile"]
export const takeWhile = R["takeWhile"]
export const times = R["times"]
export const transduce = R["transduce"]
export const transpose = R["transpose"]
export const traverse = R["traverse"]
export const unfold = R["unfold"]
export const uniq = R["uniq"]
export const uniqBy = R["uniqBy"]
export const uniqWith = R["uniqWith"]
export const unnest = R["unnest"]
export const update = R["update"]
export const without = R["without"]
export const xprod = R["xprod"]
export const zip = R["zip"]
export const zipObj = R["zipObj"]
export const zipWith = R["zipWith"]
export const mapRaw = R["map"]

export const pipeWith = R["pipeWith"]
export const pipe = S["pipe"]
export const pipeSync =
      ( fns => input => fns.reduce
                  ( (promise, fn) => R.andThen(fn, promise)
                  , Promise.resolve(input)
                  )
      )

/*
 * Fisher-Yates / Knuth Shuffle
 */
export const shuffle =
  array => {
    const length = array.length
    for (let i = length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      [array[i], array[j]] = [array[j], array[i]]
    }
    return array
  }


/*
export const sortQuick = xs => R["sort"]
export const sortMerge = xs => R["sort"]

export const mapValues =
  fun ('mapValues')
      ([G.Fun([G.Any,G.Str,G.Obj,G.Any]), G.Obj, G.Obj])
      ( f => o =>
        S.pipe(
          [ R.toPairs
          , R.map(([k, v]) => [k,f(v,k,o)])
          , R.fromPairs
          ])(o)
      )

export const mapKeys =
  fun ('mapKeys')
      ([G.Fun([G.Any,G.Str,G.Obj,G.Str]), G.Obj, G.Obj])
      ( f => o => S.pipe(
        [ R.toPairs
        , R.map(([k, v]) => [f(v,k,o), v])
        , R.fromPairs
        ])(o)
      )

G["forSeries"] =
  fun ("forSeries")
      ([G.Fun([G.Any,G.Any]), G.Arr(G.Any), G.Any])
      ( fn => async(xs) => {
        const results = []
        for(const x of xs){
          results.push(await fn(x))
        }
        return results
      })

G["forParallel"] =
  fun ("forParallel")
      ([G.Fun([G.Any,G.Any]),G.Arr(G.Any),G.Any])
      ( fn => xs => Promise.all(R.map(fn)(xs)))


G["pipeAsync"] =
  fun ('pipeAsync')
      ( [G.Arr(G.Fun([G.Any,G.Any])),G.Fun([G.Any,G.Any])])
      ( fns => input => fns.reduce
                  ( (promise, fn) => R.andThen(fn, promise)
                  , Promise.resolve(input)
                  )
      )

     */
