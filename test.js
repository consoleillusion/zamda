/*
import Z from './index'
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
*/
import crypto from "crypto";

const sha256 =
  input => crypto.createHash("sha256").update(input).digest("base64URL");

console.log(sha256("hello node"));
