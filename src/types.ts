import $ from 'sanctuary-def'

export const U8 = $.NullaryType('U8')('')([])(x => x instanceof Uint8Array)
