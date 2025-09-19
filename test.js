import Z from './index'
import S from 'sanctuary'

Z.log(S.encase(x=>JSON.parse(x))('\'1\''))
