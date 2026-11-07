import init from './index.js'
const { Z } = init()

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const square =
  async x => {
    console.log(x)
    await sleep(2000 * Math.random())
    return x * x 
  }

const arr = [1,5,66,7]

console.log(await Z.mapParallel(square)(arr))
console.log(await Z.mapSeries(square)(arr))
