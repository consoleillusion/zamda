export const init =
  ({Z,def,$}) => {
    return (
      { add:
        def('add')
          ({})
          ([$.Number, $.Number, $.Number])
          (x => y => x + y)
    
      , dec:
        def('dec')
          ({})
          ([$.Number, $.Number])
          (x => x - 1)
    
      , div:
        def('div')
          ({})
          ([$.Number, $.Number, $.Number])
          (x => y => x / y)
    
      , inc:
        def('inc')
          ({})
          ([$.Number, $.Number])
          (x => x + 1)
    
      , mathMod:
        def('mathMod')
          ({})
          ([$.Integer, $.NonZeroInteger, $.Integer])
          (x => y => x % y)
    
      , mean:
        def('mean')
          ({})
          ([$.Array($.Number), $.Number])
          (xs => xs.reduce((a, b) => a + b, 0) / xs.length)
    
      , median:
        def('median')
          ({})
          ([$.Array($.Number), $.Number])
          (xs => {
            const sorted = xs.slice().sort((a, b) => a - b)
            const mid = Math.floor(sorted.length / 2)
            return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
          })
    
      , modulo:
        def('modulo')
          ({})
          ([$.Integer, $.NonZeroInteger, $.Integer])
          (x => y => ((x % y) + y) % y)
    
      , multiply:
        def('multiply')
          ({})
          ([$.Number, $.Number, $.Number])
          (x => y => x * y)
    
      , negate:
        def('negate')
          ({})
          ([$.Number, $.Number])
          (x => -x)
    
      , product:
        def('product')
          ({})
          ([$.Array($.Number), $.Number])
          (xs => xs.reduce((a, b) => a * b, 1))
    
      , subtract:
        def('subtract')
          ({})
          ([$.Number, $.Number, $.Number])
          (x => y => x - y)
    
      , sum:
        def('sum')
          ({})
          ([$.Array($.Number), $.Number])
          (xs => xs.reduce((a, b) => a + b, 0))
          })
      }
