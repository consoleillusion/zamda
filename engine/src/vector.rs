// Vectors: what an expression evaluates to over a batch of rows. A vector is a
// column of values (with optional validity bytes, 1 = present) or a constant:
// one value that is the same, and never null, in every row (a literal, a
// parameter, or a result that came out the same for every row). Values borrow
// from the table when an expression is just a column, so reading costs nothing.
//
// Values are held by storage class, not by data type: bool and uint8 are both
// bytes, int32, date32 and the codes of a dictionary column are all i32,
// float64 and timestamp are both f64. The vector's `ty` says what they mean.

use std::borrow::Cow;

use crate::types::Type;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Scalar {
    I8(i8),
    I16(i16),
    I32(i32),
    I64(i64),
    U8(u8),
    U16(u16),
    U32(u32),
    U64(u64),
    F32(f32),
    F64(f64),
}

#[derive(Clone, Debug)]
pub enum Values<'a> {
    I8(Cow<'a, [i8]>),
    I16(Cow<'a, [i16]>),
    I32(Cow<'a, [i32]>),
    I64(Cow<'a, [i64]>),
    U8(Cow<'a, [u8]>),
    U16(Cow<'a, [u16]>),
    U32(Cow<'a, [u32]>),
    U64(Cow<'a, [u64]>),
    F32(Cow<'a, [f32]>),
    F64(Cow<'a, [f64]>),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Storage {
    I8,
    I16,
    I32,
    I64,
    U8,
    U16,
    U32,
    U64,
    F32,
    F64,
}

pub fn storage(ty: Type) -> Storage {
    // Purpose: how values of this type are held
    match ty {
        Type::Bool | Type::Uint8 => Storage::U8,
        Type::Int8 => Storage::I8,
        Type::Int16 => Storage::I16,
        Type::Int32 | Type::Date32 | Type::Utf8 | Type::Dictionary => Storage::I32,
        Type::Int64 => Storage::I64,
        Type::Uint16 => Storage::U16,
        Type::Uint32 => Storage::U32,
        Type::Uint64 => Storage::U64,
        Type::Float32 => Storage::F32,
        Type::Float64 | Type::Timestamp => Storage::F64,
    }
}

// Runs `$body` once with `$T` bound to the Rust type that holds values of `$ty`.
#[macro_export]
macro_rules! with_storage {
    ($ty:expr, $T:ident => $body:expr) => {
        match $crate::vector::storage($ty) {
            $crate::vector::Storage::I8 => { type $T = i8; $body }
            $crate::vector::Storage::I16 => { type $T = i16; $body }
            $crate::vector::Storage::I32 => { type $T = i32; $body }
            $crate::vector::Storage::I64 => { type $T = i64; $body }
            $crate::vector::Storage::U8 => { type $T = u8; $body }
            $crate::vector::Storage::U16 => { type $T = u16; $body }
            $crate::vector::Storage::U32 => { type $T = u32; $body }
            $crate::vector::Storage::U64 => { type $T = u64; $body }
            $crate::vector::Storage::F32 => { type $T = f32; $body }
            $crate::vector::Storage::F64 => { type $T = f64; $body }
        }
    };
}

// A Rust type that holds column values.
pub trait Num: Copy + PartialOrd + Default + 'static {
    fn wrap(values: Cow<'_, [Self]>) -> Values<'_>;
    fn of<'v, 'a>(values: &'v Values<'a>) -> Option<&'v [Self]>;
    fn scalar(s: Scalar) -> Option<Self>;
    fn to_scalar(self) -> Scalar;
}

macro_rules! impl_num {
    ($t:ty, $variant:ident) => {
        impl Num for $t {
            fn wrap(values: Cow<'_, [$t]>) -> Values<'_> {
                // Purpose: tag a slice with its storage class
                Values::$variant(values)
            }
            fn of<'v, 'a>(values: &'v Values<'a>) -> Option<&'v [$t]> {
                // Purpose: the slice if the values have this storage class
                match values {
                    Values::$variant(v) => Some(v),
                    _ => None,
                }
            }
            fn scalar(s: Scalar) -> Option<$t> {
                // Purpose: the value if the scalar has this storage class
                match s {
                    Scalar::$variant(v) => Some(v),
                    _ => None,
                }
            }
            fn to_scalar(self) -> Scalar {
                // Purpose: tag a value with its storage class
                Scalar::$variant(self)
            }
        }
    };
}

impl_num!(i8, I8);
impl_num!(i16, I16);
impl_num!(i32, I32);
impl_num!(i64, I64);
impl_num!(u8, U8);
impl_num!(u16, U16);
impl_num!(u32, U32);
impl_num!(u64, U64);
impl_num!(f32, F32);
impl_num!(f64, F64);

impl Values<'_> {
    pub fn len(&self) -> usize {
        // Purpose: number of values
        match self {
            Values::I8(v) => v.len(),
            Values::I16(v) => v.len(),
            Values::I32(v) => v.len(),
            Values::I64(v) => v.len(),
            Values::U8(v) => v.len(),
            Values::U16(v) => v.len(),
            Values::U32(v) => v.len(),
            Values::U64(v) => v.len(),
            Values::F32(v) => v.len(),
            Values::F64(v) => v.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        // Purpose: whether there are no values
        self.len() == 0
    }

    pub fn bytes(&self) -> &[u8] {
        // Purpose: the values as raw little-endian bytes, for the host to read
        fn raw<T>(v: &[T]) -> &[u8] {
            unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, std::mem::size_of_val(v)) }
        }
        match self {
            Values::I8(v) => raw(v),
            Values::I16(v) => raw(v),
            Values::I32(v) => raw(v),
            Values::I64(v) => raw(v),
            Values::U8(v) => raw(v),
            Values::U16(v) => raw(v),
            Values::U32(v) => raw(v),
            Values::U64(v) => raw(v),
            Values::F32(v) => raw(v),
            Values::F64(v) => raw(v),
        }
    }

    pub fn empty(ty: Type) -> Values<'static> {
        // Purpose: no values of this type's storage class
        with_storage!(ty, T => <T as Num>::wrap(Cow::Owned(Vec::<T>::new())))
    }

    pub fn broadcast(s: Scalar, n: usize) -> Values<'static> {
        // Purpose: `n` copies of a value
        match s {
            Scalar::I8(v) => Values::I8(Cow::Owned(vec![v; n])),
            Scalar::I16(v) => Values::I16(Cow::Owned(vec![v; n])),
            Scalar::I32(v) => Values::I32(Cow::Owned(vec![v; n])),
            Scalar::I64(v) => Values::I64(Cow::Owned(vec![v; n])),
            Scalar::U8(v) => Values::U8(Cow::Owned(vec![v; n])),
            Scalar::U16(v) => Values::U16(Cow::Owned(vec![v; n])),
            Scalar::U32(v) => Values::U32(Cow::Owned(vec![v; n])),
            Scalar::U64(v) => Values::U64(Cow::Owned(vec![v; n])),
            Scalar::F32(v) => Values::F32(Cow::Owned(vec![v; n])),
            Scalar::F64(v) => Values::F64(Cow::Owned(vec![v; n])),
        }
    }

    pub fn into_owned(self) -> Values<'static> {
        // Purpose: the same values, owned
        match self {
            Values::I8(v) => Values::I8(Cow::Owned(v.into_owned())),
            Values::I16(v) => Values::I16(Cow::Owned(v.into_owned())),
            Values::I32(v) => Values::I32(Cow::Owned(v.into_owned())),
            Values::I64(v) => Values::I64(Cow::Owned(v.into_owned())),
            Values::U8(v) => Values::U8(Cow::Owned(v.into_owned())),
            Values::U16(v) => Values::U16(Cow::Owned(v.into_owned())),
            Values::U32(v) => Values::U32(Cow::Owned(v.into_owned())),
            Values::U64(v) => Values::U64(Cow::Owned(v.into_owned())),
            Values::F32(v) => Values::F32(Cow::Owned(v.into_owned())),
            Values::F64(v) => Values::F64(Cow::Owned(v.into_owned())),
        }
    }
}

#[derive(Clone, Debug)]
pub enum Data<'a> {
    // The same value in every row, never null.
    Const(Scalar),
    Col { values: Values<'a>, valid: Option<Cow<'a, [u8]>> },
}

#[derive(Clone, Debug)]
pub struct Vector<'a> {
    pub ty: Type,
    pub data: Data<'a>,
}

impl<'a> Vector<'a> {
    pub fn constant(ty: Type, value: Scalar) -> Vector<'a> {
        // Purpose: a vector holding one value for every row
        Vector { ty, data: Data::Const(value) }
    }

    pub fn column(ty: Type, values: Values<'a>, valid: Option<Cow<'a, [u8]>>) -> Vector<'a> {
        // Purpose: a vector of per-row values, dropping validity bytes that are all 1
        let valid = valid.filter(|v| v.contains(&0));
        Vector { ty, data: Data::Col { values, valid } }
    }

    pub fn valid(&self) -> Option<&[u8]> {
        // Purpose: validity bytes, None when no row is null
        match &self.data {
            Data::Const(_) => None,
            Data::Col { valid, .. } => valid.as_deref(),
        }
    }

    pub fn into_columns(self, n: usize) -> (Values<'a>, Option<Cow<'a, [u8]>>) {
        // Purpose: the vector as plain values and validity for `n` rows, expanding a constant
        match self.data {
            Data::Const(s) => (Values::broadcast(s, n), None),
            Data::Col { values, valid } => (values, valid),
        }
    }
}

// One side of a binary kernel: a slice, or a value that is the same in every row.
#[derive(Clone, Copy)]
pub enum Opd<'v, T> {
    Col(&'v [T]),
    Const(T),
}

pub fn operand<'v, 'a, T: Num>(v: &'v Vector<'a>) -> Opd<'v, T> {
    // Purpose: view a vector as a kernel operand of the right storage class
    match &v.data {
        Data::Const(s) => Opd::Const(T::scalar(*s).expect("vector storage matches its type")),
        Data::Col { values, .. } => Opd::Col(T::of(values).expect("vector storage matches its type")),
    }
}

impl<T: Copy> Opd<'_, T> {
    #[inline(always)]
    pub fn at(&self, i: usize) -> T {
        // Purpose: the value in row i
        match self {
            Opd::Col(s) => s[i],
            Opd::Const(c) => *c,
        }
    }
}
