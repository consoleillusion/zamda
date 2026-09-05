import $ from 'sanctuary-def'
import * as changeCaseLib from 'change-case'
import sanctuary from 'sanctuary'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
const ajv = addFormats (new Ajv ({allErrors: true, strict: false}))

const validateMeta = ajv.compile(
  { $schema: 'https://json-schema.org/draft/2020-12/schema'
  , allOf: [{ $ref: 'https://json-schema.org/draft/2020-12/schema' }]
  , required: ['title']
  })
const JsonSchemaWithTitleType = $.NullaryType
  ('JsonSchemaWithTitleType')
  ('')
  ([$.Object])
  (validateMeta)

const PromiseType = $.UnaryType
  ('Promise')
  ('')
  ([])
  (x => x instanceof Promise)
  (_ => [])

const env = sanctuary.env.concat(
  [ PromiseType($.Unknown)
  , JsonSchemaWithTitleType
  ])


const jsonSchemaSanctuary =
  ($.create({checkTypes: true, env}))
    ('jsonSchemaType')
    ({})
    ([JsonSchemaWithTitleType, $.Type])
    (schema => {
      const validate = ajv.compile(schema)
      return $.NullaryType
                (schema.title)
                (schema.$id || '')
                ([$.Object])
                (x => validate(x) === true)
     })

export const Z =
  { ...sanctuary.create({checkTypes: true, env})
  , jsonSchemaSanctuary
  }
export const def = $.create({checkTypes: true, env})
export const types = {...$, PromiseType, JsonSchemaWithTitleType}



/*
export const changeCase =
  def('changeCase')
     ({})
     ([TextCasing,$.String,$.String])
     (textCasing => str => ['lowerCase','upperCase'].includes(textCasing) 
                         ? (textCasing === 'lowerCase' ? str.toLowerCase() : str.toUpperCase())
                         : changeCaseLib[textCasing](str))


console.log(changeCase('aobu')('eNEUH NUHu'))
const probe = def('probe')({})([TextCasing, $.String])(x => x)
probe('lowerCaseu')

export const init =
  (opts = {}) => (
    { ...sanctuary.create(
      { checkTypes: opts.checkTypes ?? true 
      , env
      })
    , def: $.create(
      { checkTypes: opts.checkTypes ?? true 
      , env
      })
    , types: $
    })

   */
