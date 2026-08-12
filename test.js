import Z from './index'

Z.forParallelP(x => Z.argon2id(String(x),{memorySize: 64000,iterations:100}).then(Z.log))([1, 3, 5])
Z.forSeriesP(x => Z.argon2id(String(x),{memorySize: 64000, iterations:100}).then(Z.log))([1, 3, 5])
