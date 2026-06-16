import Z from './index'

/*
Z.forParallelP(x => Z.argon2id(String(x),{memorySize: 32000,iterations:10}).then(Z.log))([1, 3, 5])
Z.forSeriesP(x => Z.argon2id(String(x),{memorySize: 32000, iterations:10}).then(Z.log))([1, 3, 5])
*/

const password = 'password'
const hash = await Z.argon2id({password})
console.log(await Z.argon2Verify({hash,password}))
