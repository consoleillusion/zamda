import $ from 'sanctuary-def'
import {typeFromSchema} from './jsonSchemaDef.js'

const duckSchema =
  { title: 'Duck'
  , type: 'object'
  , properties:
    { name:    {type: 'string', minLength: 1}
    , age:     {type: 'integer', minimum: 0}
    , breed:   {enum: ['mallard', 'pekin', 'runner', 'muscovy']}
    , email:   {type: 'string', format: 'email'}
    , friends: {type: 'array', items: {type: 'string'}, uniqueItems: true}
    }
  , required: ['name', 'breed']
  }

const Duck = typeFromSchema (duckSchema)
const isDuck = x => $.test ([]) (Duck) (x)

// --- try some values ---
const samples = [
  {name: 'Bun',  breed: 'mallard'},                                  // ok (only required)
  {name: 'Fish', age: 2, breed: 'pekin', email: 'fish@pond.nz',
   friends: ['Bun', 'Sky']},                                          // ok (full)
  {name: 'Nemo', breed: 'goldfish'},                                  // bad: breed not in enum
  {age: 3, breed: 'runner'},                                          // bad: name missing
  {name: 'Dup',  breed: 'pekin', friends: ['a', 'a']},               // bad: friends not unique
]

for (const s of samples) {
  console.log (isDuck (s) ? '✓' : '✗', JSON.stringify (s))
}

// --- use it in a def, which throws on bad input ---
const env = $.env.concat ([Duck])
const def = $.create ({checkTypes: true, env})
const greet = def ('greet') ({}) ([Duck, $.String]) (d => `quack, ${d.name}`)

console.log ('\n' + greet ({name: 'Bun', breed: 'mallard'}))   // works
try { greet ({name: 'Nemo', breed: 'goldfish'}) }              // throws
catch (e) { console.log ('rejected:', e.message.split ('\n')[0]) }
