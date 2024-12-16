import sanctuary from 'sanctuary'
import $ from 'sanctuary-def'
import * as Ramda from 'ramda'
import {FutureType, ConcurrentFutureType, env as flutureEnv} from 'fluture-sanctuary-types'

export const R = Ramda
export const S = sanctuary.create(
  { checkTypes: /production/.test(process.env?.NODE_ENV ?? '')
  , env: sanctuary.env.concat(flutureEnv)
  })

export default {R,S}
