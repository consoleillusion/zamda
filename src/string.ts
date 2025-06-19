import {R,S} from './init'
import * as changeCase from 'change-case'

export const match = R["match"]
export const replace = R["replace"]
export const split = R["split"]
export const test = R["test"]
export const toLower = R["toLower"]
export const toString = R["toString"]
export const toUpper = R["toUpper"]
export const trim = R["trim"]
export const camelCase = changeCase["camelCase"]
export const capitalCase = changeCase["capitalCase"]
export const constantCase = changeCase["constantCase"]
export const dotCase = changeCase["dotCase"]
export const kebabCase = changeCase["kebabCase"]
export const noCase = changeCase["noCase"]
export const pascalCase = changeCase["pascalCase"]
export const pascalSnakeCase = changeCase["pascalSnakeCase"]
export const pathCase = changeCase["pathCase"]
export const sentenceCase = changeCase["sentenceCase"]
export const snakeCase = changeCase["snakeCase"]
export const trainCase = changeCase["trainCase"]

/*
 * Useful for searches and canonical forms.
 */
export const stripDiacritics = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
