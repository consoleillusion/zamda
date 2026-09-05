import * as changeCaseLib from 'change-case'

export const TextCasing =
  { title: 'TextCasing'
  , type: 'string'
  , enum: ['camelCase','capitalCase','constantCase','dotCase','kebabCase','noCase','pascalCase','pascalSnakeCase','pathCase','sentenceCase','snakeCase','trainCase','lowerCase','upperCase']
  }

const unpackReplacerArgs = (...args) => {
  let groups = null
  if (typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null) {
    groups = args.pop()
  }
  const string = args.pop()
  const offset = args.pop()
  const [match, ...ps] = args
  return {match, ps: ps.map(p => p ?? null), offset, string, groups}
}

export const init =
  ({Z,def,$}) => {
    const ReplaceArg = $.RecordType
      ({ match:  $.String
       , ps:     $.Array($.Nullable($.String))
       , offset: $.Integer
       , string: $.String
       , groups: $.Nullable($.Object)
       })

    return (
      { changeCase:
          def('changeCase')
            ({})
            ([$.TextCasing,$.String,$.String])
            (textCasing => str => ['lowerCase','upperCase'].includes(textCasing) 
                                  ? (textCasing === 'lowerCase' ? str.toLowerCase() : str.toUpperCase())
                                  : changeCaseLib[textCasing](str))

      , trim:
          def('trim')
            ({})
            ([$.String,$.String])
            (str => str.trim())

      , replace:
          def('replace')
            ({})
            ([$.RegExp, $.Fn(ReplaceArg)($.String), $.String, $.String])
            (regex => fn => str => str.replace(regex, (...args) => fn(unpackReplacerArgs(...args))))

      , split:
          def('split')
            ({})
            ([$.String, $.String, $.Array($.String)])
            (sep => str => str.split(sep))

      , join:
          def('join')
            ({})
            ([$.String,$.Array($.String), $.String])
            (sep => arr => arr.join(sep))

      })
  }





/*
import {R,S} from './init'
import c from 'ansi-colors'

export const match = R["match"]
export const split = R["split"]
export const test = R["test"]
//export const toLower = R["toLower"]
//export const toUpper = R["toUpper"]
export const toString = R["toString"]
//export const trim = R["trim"]

/*
 * Useful for searches and canonical forms.
 */
//export const stripDiacritics = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "")

//export const color = R.mapObjIndexed(x=>x.wrap)(c.styles)

