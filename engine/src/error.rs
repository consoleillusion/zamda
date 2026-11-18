// Error codes. The numbers are part of the contract with the JS side, which maps
// each to a PlanError message: never renumber, only append. Decoding errors are
// below 100, validation errors from 100.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u16)]
pub enum Code {
    // decoding: the bytes are not a plan
    Truncated = 1,
    BadMagic = 2,
    UnsupportedVersion = 3,
    VarintTooLong = 4,
    VarintNotMinimal = 5,
    VarintTooLarge = 6,
    CountTooLarge = 7,
    InvalidUtf8 = 8,
    UnknownType = 9,
    UnknownOp = 10,
    UnknownExprKind = 11,
    UnknownLiteralKind = 12,
    BadFlag = 13,
    TooDeep = 14,
    TrailingBytes = 15,
    NegativeZeroBigint = 16,
    IntegerTooLarge = 17,
    IntegerAsFloat = 18,
    NonStandardNan = 19,
    // validation: the plan does not make sense
    NodeCount = 101,
    FirstNodeNotScan = 102,
    LaterScan = 103,
    DuplicateParam = 104,
    BadInput = 105,
    FieldOutOfRange = 106,
    FieldTypeMismatch = 107,
    UnknownFunction = 108,
    WrongFunctionKind = 109,
    NoSignature = 110,
    ResultTypeMismatch = 111,
    BadCast = 112,
    InNotBool = 113,
    InListTooLong = 114,
    ParamUndeclared = 115,
    ParamMismatch = 116,
    PredicateNotBool = 117,
    ProjectSchemaMismatch = 118,
    SortKeyBool = 119,
    AggregateSchemaMismatch = 120,
    RootOutOfRange = 121,
    ExprTooDeep = 122,
}

// `at` is the byte offset for a decoding error and the node index for a validation error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Error {
    pub code: Code,
    pub at: u32,
}

pub fn fail<T>(code: Code, at: usize) -> Result<T, Error> {
    // Purpose: an Err with a code and a position (clamped to u32)
    Err(Error { code, at: at.min(u32::MAX as usize) as u32 })
}
