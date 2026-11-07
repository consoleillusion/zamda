export const init =
  ({Z, def, $}) => {
    const a = $.TypeVariable('a')
    const b = $.TypeVariable('b')
    return (
      { mapParallel:
          def('mapParallel')
            ({})
            ([$.Fn(a)($.PromiseType(b)), $.Array(a), $.PromiseType($.Array(b))])
            ( f => xs => Promise.all(xs.map(x => f(x))) )

      , mapSeries:
          def('mapSeries')
            ({})
            ([$.Fn(a)($.PromiseType(b)), $.Array(a), $.PromiseType($.Array(b))])
            ( f => async xs => {
                const out = []
                for (const x of xs) out.push(await f(x))
                return out
              })
      })
  }

        /*
            */

/*
export const sortQuick = xs => R["sort"]
export const sortMerge = xs => R["sort"]

export const pipeWith = R["pipeWith"]
export const pipe = S["pipe"]
export const pipeSync =
      ( fns => input => fns.reduce
                  ( (promise, fn) => R.andThen(fn, promise)
                  , Promise.resolve(input)
                  )
      )
     */

/*

export const map = R["map"]
export const mapAccum = R["mapAccum"]
export const mapAccumRight = R["mapAccumRight"]
export const mapSeries =
  fn => async arr => {
    for (let i = 0; i < arr.length; i++) {
      arr[i] = await fn(arr[i], i, arr);
    }
    return arr
  }
 */


/*

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
