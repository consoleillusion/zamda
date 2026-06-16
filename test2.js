import $ from 'sanctuary-def'
import {FutureType} from 'fluture-sanctuary-types'
import {resolve, chain, parallel, map, reject, fork} from 'fluture'

const def = $.create({checkTypes: true, env: $.env})
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

export const forSeries =
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

export const forParallel =
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


forParallelP(console.log)([1,3,54])
// --- tests ---


/*
fork(_=>_)
    (_=>_)
    (forParallel( x => resolve(console.log(x)))(([1,2,3])))

forEach(console.log)([5,6,7])
*/
