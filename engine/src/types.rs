// Data types and fields. The variant order is the type id in the binary IR
// (docs/IR-BINARY.md): never reorder, only append.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Type {
    Bool,
    Int8,
    Int16,
    Int32,
    Int64,
    Uint8,
    Uint16,
    Uint32,
    Uint64,
    Float32,
    Float64,
    Utf8,
    Dictionary,
    Date32,
    Timestamp,
}

pub const TYPES: [Type; 15] = [
    Type::Bool,
    Type::Int8,
    Type::Int16,
    Type::Int32,
    Type::Int64,
    Type::Uint8,
    Type::Uint16,
    Type::Uint32,
    Type::Uint64,
    Type::Float32,
    Type::Float64,
    Type::Utf8,
    Type::Dictionary,
    Type::Date32,
    Type::Timestamp,
];

impl Type {
    pub fn from_id(id: u8) -> Option<Type> {
        // Purpose: the type with this id in the binary format, if there is one
        TYPES.get(id as usize).copied()
    }

    pub fn id(self) -> u8 {
        // Purpose: the type's id in the binary format
        self as u8
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Field {
    pub name: String,
    pub ty: Type,
}
