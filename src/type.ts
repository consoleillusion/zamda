import {R,S} from './init'

export const is = R["is"]
export const isNil = R["isNil"]
export const isNotNil = R["isNotNil"]
export const propIs = R["propIs"]
export const type = S["type"]

export const Right = S["Right"]
export const Left = S["Left"]
export const either = S["either"]
export const isRight = S["isRight"]
export const isLeft= S["isLeft"]

/*
const t =
  { String: $.String
  , Object: $.Object
  , Function: $.Function
  , Any: $.Any
  , Undefined: $.Undefined 
  , Array: $.Array
  , Future: FutureType
  , FutureConcurrent: ConcurrentFutureType

  , create: $.create
  , env: $.env

  , is = R["is"]
  , isNil = R["isNil"]
  , isNotNil = R["isNotNil"]
  , propIs = R["propIs"]
  , type = R["type"]

  }

Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i)).forEach( letter => {
  t[letter] = $.TypeVariable(letter)
})


export default t
const schemaSanctuary = G.cond(
      [ [ G.propEq('string')('type')
        , (schema) => $.String
        ]
      , [ G.propEq('number')('type')
        , (schema) => $.Number
        ]
      , [ G.propEq('integer')('type')
        , (schema) => $.Integer
        ]
      , [ G.propEq('boolean')('type')
        , (schema) => $.Boolean
        ]
      , [ G.propEq('array')('type')
        , (schema) => $.Array(schemaSanctuary(schema.items ?? {}))
        ]
      , [ G.propEq('object')('type')
        , (schema) => {
            const ps = schema.properties ?? {};
            const required = new Set(schema.required ?? []);
            const fields = Object.entries(ps).reduce((acc, [key, value]) => {
              const isRequired = required.has(key)
              const hasDefault = value.default
              const valueType = schemaSanctuary(value);
              acc[key] = isRequired ? (valueType) : $.Nullable(valueType);
              return acc;
            }, {});
            return $.RecordType(fields);
            }
        ]
      , [ G.T
        , (schema) => $.Unknown
        ]
      ])

const normalizeSchema = G.cond(
    [ [ s => (G.isNil(s) || typeof s !== 'object')
      , G.identity
      ]
    , [ G.propSatisfies(G.isNotNil)('default')
      , G.identity
      ]
    , [ G.propEq('array')('type')
      , G.pipe(
        [ G.over(G.lensProp('default') , x => x ?? [])
        , G.over(G.lensProp('items')   , x => x ?? [])
        , G.ifElse
          ( s => G.isNotNil(s.items) )
          ( s => G.assoc('items')(normalizeSchema(s))(s) )
          ( G.omit(['items']) )
        ])
      ]
    , [ G.propEq('object')('type')
      , s => {
        s.properties = G.mapValues(v => normalizeSchema(v))(s.properties ?? {})
        s.additionalProperties = false
        return s
        }
      ]
    , [ G.T
      , G.assoc('default',null)
      ]
    ])

const createType =
  (schema) => G.pipe(
     [ normalizeSchema
     , schemaSanctuary
     ]) (schema)


    */
