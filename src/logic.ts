import {R,S} from './init'

export const allPass = R["allPass"]
export const and = R["and"]
export const anyPass = R["anyPass"]
export const both = R["both"]
export const complement = R["complement"]
export const cond = R["cond"]
export const defaultTo = R["defaultTo"]
export const ifElse = R["ifElse"]
export const isEmpty = R["isEmpty"]
export const isNotEmpty = R["isNotEmpty"]
export const not = R["not"]
export const or = R["or"]
export const pathSatisfies = R["pathSatisfies"]
export const propSatisfies = R["propSatisfies"]
export const unless = R["unless"]
export const until = R["until"]
export const when = R["when"]
export const xor = R["xor"]

export const isEmptyOrNil = x => isEmpty(x) || isNil(x)

export const fromRight = S["fromRight"]
export const fromLeft = S["fromLeft"]
export const either = S["either"]
export const unwrapOr = d => e => either(_=>d)(e => fromRight(e))(e)
