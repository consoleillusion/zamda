import init from './index.ts'

// Shared library instance for all test files.
export const { Z } = init()

console.log(Z.shuffle([1,2,3,4,5,6]))
