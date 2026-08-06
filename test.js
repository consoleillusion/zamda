/*
import S from 'sanctuary'
import { attemptP, encaseP,fork } from 'fluture'

let y = (Z.encase(x => Promise.resolve(x))('"1"'))
Z.log(y)
        .pipe(fork
          (x => ("u"))
          (x => ('l'))
        )

let y = await Z.try(async x=>JSON.parse(x))('\'1\'')

Z.log(y)
const x = Z.encase(async x => x)(1)
.pipe (fork
  (err => console.error('❌ Left', err))
  (attemptP(val => console.log('✅ Right', val)))
);
import Z from './index'
//console.log(await Z.argon2.hash('aoeu'))
//Z.log(Z.parseInt(1)('1'))
*/
import Z from './index'

Z.forParallelP(x => Z.argon2id(String(x),{memorySize: 64000,iterations:100}).then(Z.log))([1, 3, 5])
Z.forSeriesP(x => Z.argon2id(String(x),{memorySize: 64000, iterations:100}).then(Z.log))([1, 3, 5])
