/*
import {forEach} from './src/control.ts'

Z.forParallelP(x => Z.argon2id(String(x),{memorySize: 32000,iterations:10}).then(Z.log))([1, 3, 5])
Z.forSeriesP(x => Z.argon2id(String(x),{memorySize: 32000, iterations:10}).then(Z.log))([1, 3, 5])

const password = 'password'
const hash = await Z.argon2id({password})
console.log(await Z.argon2Verify({hash,password}))

forEach(console.log)([9,6,7,9])
*/

import init from './index.ts'

const {Z} = init()

//console.log(Z)
console.log(Z.changeCase('pascalCase')('u ntheo uheno hnoe uh'))
const password = "password123"
const hash = (await Z.argon2id({password,salt:'eenuhenuhaenouhaenuhnaoeuhaneouh naehuna euh'}))
console.log(hash)
console.log(await Z.argon2Verify({password,hash:'3'}))
console.log(Z.replace(/a/)(x=>""+x.offset)('abc'))
console.log(Z.split(' ')('a beo teu nth unte hc'))
console.log(Z.join(' BLACK ')(Z.split(' ')('a beo teu nth unte hc')))
console.log(Z.map(x=>x*2)([1,5,8,8]))

//Z.forEach(x=>{console.log(x*2)})([1,2,3])
Z.forSeries(async x => {console.log(x*2)})([1,2,3])
