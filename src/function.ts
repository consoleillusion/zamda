import {R,S} from './init'
/*
import * as R from 'ramda'
import * as Type from './type'
console.log(Type)
export const def = Type.create({checkTypes: process.env.NODE_ENV !== 'production', env: Type.env})
export const fun =
  name => signature => fn => def (name)
                                 ({})
                                 (signature)
                                 (fn)
                              */
export const __ = R["__"]
export const addIndex = R["addIndex"]
export const addIndexRight = R["addIndexRight"]
export const always = R["always"]
export const andThen = R["andThen"]
export const ap = R["ap"]
export const apply = R["apply"]
export const applySpec = R["applySpec"]
export const applyTo = R["applyTo"]
export const ascend = R["ascend"]
export const ascendNatural = R["ascendNatural"]
export const binary = R["binary"]
export const bind = R["bind"]
export const call = R["call"]
export const comparator = R["comparator"]
export const compose = R["compose"]
export const composeWith = R["composeWith"]
export const construct = R["construct"]
export const constructN = R["constructN"]
export const converge = R["converge"]
export const curry = R["curry"]
export const curryN = R["curryN"]
export const descend = R["descend"]
export const descendNatural = R["descendNatural"]
export const empty = R["empty"]
export const flip = R["flip"]
export const flow = R["flow"]
export const identity = R["identity"]
export const invoker = R["invoker"]
export const juxt = R["juxt"]
export const lift = R["lift"]
export const liftN = R["liftN"]
export const memoizeWith = R["memoizeWith"]
export const nAry = R["nAry"]
export const nthArg = R["nthArg"]
export const o = R["o"]
export const of = R["of"]
export const on = R["on"]
export const once = R["once"]
export const otherwise = R["otherwise"]
export const partial = R["partial"]
export const partialObject = R["partialObject"]
export const partialRight = R["partialRight"]
export const promap = R["promap"]
export const tap = R["tap"]
export const thunkify = R["thunkify"]
export const unapply = R["unapply"]
export const unary = R["unary"]
export const uncurryN = R["uncurryN"]
export const useWith = R["useWith"]
export const thrush  = S["T"]


export const F = R["F"]
export const T = R["T"]

export const encase = S["encase"]
export const encaseP = S["encaseP"]
/*

export const tryFn = 
  fnSuccess => async arg => {
    try {
      return S.Right(await fnSuccess(arg))
    } catch(e) {
      return S.Left(await e)
    }
  }
*/

export const tryCatch = 
  fnSuccess => fnFail => async arg => {
    try {
      return S.Right(await fnSuccess(arg))
    } catch(e) {
      return S.Left(await fnFail(e))
    }
  }

const try_ = 
  fnSuccess => async arg => {
    try {
      return S.Right(await fnSuccess(arg))
    } catch(e) {
      return S.Left(await (e))
    }
  }
export { try_ as try };
