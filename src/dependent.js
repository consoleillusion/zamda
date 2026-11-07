/*
 * Fisher-Yates / Knuth Shuffle
 */

export const init =
  ({Z,def,$}) => {
    const a = $.TypeVariable('a')
    return (
      { shuffle:
        def('shuffle')
            ({})
            ([$.Array(a), $.Array(a)])
            ( array => {
              const length = array.length
              for (let i = length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1))
                const temp = array[i]
                array[i] = array[j]
                array[j] = temp
                //[array[i], array[j]] = [array[j], array[i]]
              }
              return array
            })
      })
  }
