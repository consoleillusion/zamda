export const init =
  ({Z,def,$}) => {
    const a = $.TypeVariable('a')
    const b = $.TypeVariable('b')
    return (
      { forEach:
          def('forEach')
             ({})
             ([$.Fn(a)(b), $.Array(a), $.Undefined])
             (fn => arr => {
               arr.forEach(x => { fn(x) })
               return undefined
             })

      , forSeries:
          def('forSeries')
             ({})
             ([ $.Fn(a)(b), $.Array(a), $.PromiseType($.Undefined)])
             (fn => arr =>
                arr.reduce( (acc, x) => acc.then(() => fn(x))
                          , Promise.resolve(undefined)
                          ).then(() => undefined))

      , forParallel:
          def('forParallel')
            ({})
            ([ $.Fn(a)(b), $.Array(a), $.PromiseType($.Undefined)])
            ( fn => arr => Promise.all(arr.map(x => Promise.resolve(fn(x)))).then(() => undefined) )
      })
  }

  /*
export const forSeriesF =
  def('forSeries')
     ({})
     ([ $.Fn(a)(FutureType(e)(b))
      , $.Array(a)
      , FutureType(e)($.Undefined)
      ])
     (fn => arr =>
       arr.reduce( (acc, x) => chain(() => fn(x))(acc)
                 , resolve(undefined)
                 )
     )

export const forParallelF =
  def('forParallel')
     ({})
     ([ $.Fn(a)(FutureType(e)(b))
      , $.Array(a)
      , FutureType(e)($.Undefined)
      ])
     (fn => arr =>
       map(() => undefined)(
         parallel(Infinity)(arr.map(x => fn(x)))
       )
     )
    */
