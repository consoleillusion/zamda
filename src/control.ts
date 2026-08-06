import $ from 'sanctuary-def'
import {FutureType} from 'fluture-sanctuary-types'
import {resolve, chain, parallel, map, reject, fork} from 'fluture'

const PromiseType = $.UnaryType
  ('Promise')
  ('')
  ([])
  (x => x instanceof Promise)
  (_ => [])

const env = $.env.concat([PromiseType($.Unknown)])
const def = $.create({checkTypes: true, env: env})

const a = $.TypeVariable('a')
const b = $.TypeVariable('b')
const e = $.TypeVariable('e')

export const forEach =
  def('forEach')
     ({})
     ([$.Fn(a)($.Undefined), $.Array(a), $.Undefined])
     (fn => arr => {
       arr.forEach(x => { fn(x) })
       return undefined
     })

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

export const forSeriesP =
  def('forSeriesP')
     ({})
     ([ $.Fn(a)(b)
      , $.Array(a)
      , PromiseType($.Undefined)
      ])
     (fn => arr =>
       arr.reduce( (acc, x) => acc.then(() => fn(x))
                 , Promise.resolve(undefined)
                 ).then(() => undefined)
     )

export const forParallelP =
  def('forParallelP')
     ({})
     ([ $.Fn(a)(b)
      , $.Array(a)
      , PromiseType($.Undefined)
      ])
     ( fn => arr => Promise.all(arr.map(x => Promise.resolve(fn(x)))).then(() => undefined) )
