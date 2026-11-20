// Data types. Names follow Apache Arrow so the WASM engine and Substrait map
// to them directly. See docs/CONTRACT.md, "Supported types".

export type IntName = 'int8' | 'int16' | 'int32' | 'uint8' | 'uint16' | 'uint32';
export type BigIntName = 'int64' | 'uint64';
export type FloatName = 'float32' | 'float64';
export type NumericName = IntName | BigIntName | FloatName;
export type UnsignedName = 'uint8' | 'uint16' | 'uint32' | 'uint64';
export type IntegerName = IntName | BigIntName;
export type StringName = 'utf8' | 'dictionary';
export type TemporalName = 'date32' | 'timestamp';
export type TypeName = 'bool' | NumericName | StringName | 'date32' | 'timestamp';

export interface DataType<N extends TypeName = TypeName> {
  readonly name: N;
}

// The JavaScript value a user sees for each data type.
export interface JsByName {
  bool: boolean;
  int8: number;
  int16: number;
  int32: number;
  uint8: number;
  uint16: number;
  uint32: number;
  int64: bigint;
  uint64: bigint;
  float32: number;
  float64: number;
  utf8: string;
  dictionary: string;
  date32: Date;
  timestamp: Date;
}

export type JsOf<D extends DataType> = JsByName[D['name']];

function dt<N extends TypeName>(name: N): DataType<N> {
  // Purpose: build one frozen data type descriptor
  return Object.freeze({ name });
}

export const t = {
  bool: dt('bool'),
  int8: dt('int8'),
  int16: dt('int16'),
  int32: dt('int32'),
  int64: dt('int64'),
  uint8: dt('uint8'),
  uint16: dt('uint16'),
  uint32: dt('uint32'),
  uint64: dt('uint64'),
  float32: dt('float32'),
  float64: dt('float64'),
  utf8: dt('utf8'),
  dictionary: dt('dictionary'),
  date32: dt('date32'),
  timestamp: dt('timestamp'),
} as const;

export const INT_RANGES: Readonly<Record<IntName, readonly [number, number]>> = {
  int8: [-128, 127],
  int16: [-32768, 32767],
  int32: [-2147483648, 2147483647],
  uint8: [0, 255],
  uint16: [0, 65535],
  uint32: [0, 4294967295],
};

export const BIGINT_RANGES: Readonly<Record<BigIntName, readonly [bigint, bigint]>> = {
  int64: [-(2n ** 63n), 2n ** 63n - 1n],
  uint64: [0n, 2n ** 64n - 1n],
};

export function isInt(type: DataType): type is DataType<IntName> {
  // Purpose: true for integer types that fit a JS number
  return type.name in INT_RANGES;
}

export function isBigInt(type: DataType): type is DataType<BigIntName> {
  // Purpose: true for 64-bit integer types, held as bigint
  return type.name === 'int64' || type.name === 'uint64';
}

export function isFloat(type: DataType): type is DataType<FloatName> {
  // Purpose: true for floating-point types
  return type.name === 'float32' || type.name === 'float64';
}

export function isNumeric(type: DataType): type is DataType<NumericName> {
  // Purpose: true for any integer or floating-point type
  return isInt(type) || isBigInt(type) || isFloat(type);
}

export function isUnsigned(type: DataType): type is DataType<UnsignedName> {
  // Purpose: true for unsigned integer types
  return type.name.startsWith('uint');
}

export function isString(type: DataType): type is DataType<StringName> {
  // Purpose: true for string types, plain or dictionary-encoded
  return type.name === 'utf8' || type.name === 'dictionary';
}

export function sameType(a: DataType, b: DataType): boolean {
  // Purpose: compare two data types for equality
  return a.name === b.name;
}

export function compatibleTypes(a: DataType, b: DataType): boolean {
  // Purpose: true for equal types and for the two string storage types, which share their values (T-211)
  return sameType(a, b) || (isString(a) && isString(b));
}

export function isInteger(type: DataType): type is DataType<IntegerName> {
  // Purpose: true for any integer type, of any width
  return isInt(type) || isBigInt(type);
}

export function isTemporal(type: DataType): type is DataType<TemporalName> {
  // Purpose: true for dates and timestamps
  return type.name === 'date32' || type.name === 'timestamp';
}

export const MS_PER_DAY = 86_400_000;
