import $ from 'sanctuary-def'
import Ajv from 'ajv/dist/2020.js'   // 2020-12 dialect (supports prefixItems);
import addFormats from 'ajv-formats' // swap to 'ajv' for draft-07 semantics

const ajv = addFormats (new Ajv ({allErrors: true, strict: false}))

const validateMeta = ajv.getSchema('https://json-schema.org/draft/2020-12/schema')
const def = $.create({checkTypes:true, env:$.env})
const JsonSchemaWithTitle = $.NullaryType
  ('JsonSchemaWithTitle')
  ('')
  ([$.Object])
  (s => typeof s.title === 'string' && s.title.length > 0 && validateMeta(s) === true)

export const jsonSchemaType =
  def('jsonSchemaType')
     ({})
     ([JsonSchemaWithTitle, $.Type])
     (schema => $.NullaryType
                  (schema.title)
                  (schema.$id || '')
                  ([])
                  (x => ajv.compile(schema)(x) === true))
/*
export const jsonSchemaDef = (opts = {}) => schema => {
  const validate = ajv.compile (schema)
  const name = opts.name ?? schema.title ?? 'JsonSchema$' + (++counter)
  const url  = opts.url ?? (typeof schema.$id === 'string' ? schema.$id : '')
  return $.NullaryType (name) (url) ([]) (x => validate (x) === true)
}

export const typeFromSchema = schema => jsonSchemaDef ({}) (schema)
export default jsonSchemaDef
*/
const duckSchema =
  {  title: 'duck'
  , type: 'object'
  , properties:
    { 
     name:    {type: 'string', minLength: 1}
    , age:     {type: 'integer', minimum: 0}
    , breed:   {enum: ['mallard', 'pekin', 'runner', 'muscovy']}
    , email:   {type: 'string', format: 'email'}
    , friends: {type: 'array', items: {type: 'string'}, uniqueItems: true}
    }
  , required: ['name', 'breed']
  }
const Duck = jsonSchemaType(duckSchema)

const isDuck = x => $.test ([]) (Duck)(x)
const d1 = {bhreed: 'mallard'}

console.log(isDuck(d1))
console.log(Duck)
