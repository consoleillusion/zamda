export const renameKeys = R["renameKeys"]
export const mapKeys = R["mapKeys"]
export const renameKey =
  a => b => o => S.pipe(
    [ R.assoc(b)(o[a])
    , R.dissoc(a)
    ])(o)
/* 
*/

export const log = x => console.log(x)
export const logPipe = x => {console.log(x); return x}

/*
export const log0 = x => log(x)
export const log1 = x => { if (process.env.DEBUG > 0){log(x)}}
export const log2 = x => { if (process.env.DEBUG > 1){log(x)}}
export const log3 = x => { if (process.env.DEBUG > 2){log(x)}}
export const log4 = x => { if (process.env.DEBUG > 3){log(x)}}
export const log5 = x => { if (process.env.DEBUG > 4){log(x)}}

export const performance =
  name => fn => arg => {
    const t0 = performance.now()
    const result = fn(arg)
    const t1 = performance.now()
    return {time: t1 - t0, result}
  }

export const log =
  F.fun ('log')
      ([T.Any,T.Undefined])
      (x => console.log(x))

export const logPipe =
  fun ('log')
      ([G.Any,G.Any])
      (x => { console.log(x); return x })
     */
