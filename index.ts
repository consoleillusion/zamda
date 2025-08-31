import * as list from './src/list'
import * as func from './src/function'
import * as logic from './src/logic'
import * as num from './src/number'
import * as obj from './src/object'
import * as relation from './src/relation'
import * as str from './src/string'
import * as typ from './src/type'
import * as log from './src/log'
import * as crypt from './src/crypto'
import * as control from './src/control'

export const Z = {...list,...func,...logic,...num,...obj,...relation,...str,...typ,...log,...crypt, ...control}
export default Z

//Z.log(Z.fromRight)
