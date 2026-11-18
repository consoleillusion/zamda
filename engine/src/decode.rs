// The binary IR decoder (docs/IR-BINARY.md), the Rust twin of src/ir-binary.ts.
// It never panics and never trusts a length: every read is bounds-checked, a list
// cannot be longer than the bytes left, nesting is limited, and every number and
// string has exactly one encoding, so decoding then encoding gives the input back.

use crate::error::{fail, Code, Error};
use crate::ir::*;
use crate::types::{Field, Type};

pub const IR_VERSION: u64 = 2;
const MAGIC: [u8; 4] = [0x5a, 0x49, 0x52, 0x01];
pub const MAX_DEPTH: usize = 200;
const MAX_SAFE: u64 = (1 << 53) - 1;
pub const MAX_ZIGZAG_INT: i64 = (1 << 52) - 1;
pub const STANDARD_NAN: u64 = 0x7ff8_0000_0000_0000;

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn left(&self) -> usize {
        // Purpose: bytes not read yet
        self.bytes.len() - self.at
    }

    fn byte(&mut self) -> Result<u8, Error> {
        // Purpose: the next byte
        match self.bytes.get(self.at) {
            Some(&b) => {
                self.at += 1;
                Ok(b)
            }
            None => fail(Code::Truncated, self.at),
        }
    }

    fn varint(&mut self) -> Result<u64, Error> {
        // Purpose: the next varint: at most 8 bytes, below 2^53, in its shortest form
        let start = self.at;
        let mut value: u64 = 0;
        for i in 0..8 {
            let b = self.byte()?;
            value |= ((b & 127) as u64) << (7 * i);
            if b < 128 {
                if i > 0 && b == 0 {
                    return fail(Code::VarintNotMinimal, start);
                }
                if value > MAX_SAFE {
                    return fail(Code::VarintTooLarge, start);
                }
                return Ok(value);
            }
        }
        fail(Code::VarintTooLong, start)
    }

    fn size(&mut self) -> Result<usize, Error> {
        // Purpose: a varint as a usize; on a 32-bit target (WASM) a value that does not fit is an error, never wrapped
        let at = self.at;
        let v = self.varint()?;
        match usize::try_from(v) {
            Ok(n) => Ok(n),
            Err(_) => fail(Code::VarintTooLarge, at),
        }
    }

    fn count(&mut self) -> Result<usize, Error> {
        // Purpose: a list length; every element takes at least one byte, so it cannot exceed the bytes left
        let at = self.at;
        let n = self.size()?;
        if n > self.left() {
            return fail(Code::CountTooLarge, at);
        }
        Ok(n)
    }

    fn zigzag(&mut self) -> Result<i64, Error> {
        // Purpose: the next signed varint
        let z = self.varint()?;
        Ok(if z % 2 == 0 { (z / 2) as i64 } else { -(((z + 1) / 2) as i64) })
    }

    fn u64(&mut self) -> Result<u64, Error> {
        // Purpose: the next 8 bytes, little-endian
        if self.left() < 8 {
            return fail(Code::Truncated, self.at);
        }
        let mut raw = [0u8; 8];
        raw.copy_from_slice(&self.bytes[self.at..self.at + 8]);
        self.at += 8;
        Ok(u64::from_le_bytes(raw))
    }

    fn string(&mut self) -> Result<String, Error> {
        // Purpose: the next length-prefixed UTF-8 string; invalid UTF-8 is an error and a leading U+FEFF is kept
        let at = self.at;
        let length = self.size()?;
        if length > self.left() {
            return fail(Code::Truncated, at);
        }
        let slice = &self.bytes[self.at..self.at + length];
        self.at += length;
        match std::str::from_utf8(slice) {
            Ok(s) => Ok(s.to_string()),
            Err(_) => fail(Code::InvalidUtf8, at),
        }
    }
}

fn read_type(r: &mut Reader) -> Result<Type, Error> {
    // Purpose: the next data type
    let at = r.at;
    let id = r.byte()?;
    match Type::from_id(id) {
        Some(t) => Ok(t),
        None => fail(Code::UnknownType, at),
    }
}

fn read_fields(r: &mut Reader) -> Result<Vec<Field>, Error> {
    // Purpose: the next list of fields
    let n = r.count()?;
    let mut out = Vec::with_capacity(n.min(1024));
    for _ in 0..n {
        let name = r.string()?;
        out.push(Field { name, ty: read_type(r)? });
    }
    Ok(out)
}

fn read_literal(r: &mut Reader) -> Result<Literal, Error> {
    // Purpose: the next literal
    let at = r.at;
    match r.byte()? {
        0 => Ok(Literal::Bool(false)),
        1 => Ok(Literal::Bool(true)),
        2 => {
            let n = r.zigzag()?;
            if n.abs() > MAX_ZIGZAG_INT {
                return fail(Code::IntegerTooLarge, at);
            }
            Ok(Literal::Int(n))
        }
        3 => {
            let bits = r.u64()?;
            let v = f64::from_bits(bits);
            if v.is_nan() && bits != STANDARD_NAN {
                return fail(Code::NonStandardNan, at);
            }
            if v.is_finite() && v.fract() == 0.0 && v.abs() <= MAX_ZIGZAG_INT as f64 && bits != (-0.0f64).to_bits() {
                return fail(Code::IntegerAsFloat, at);
            }
            Ok(Literal::Float(v))
        }
        4 => Ok(Literal::Big { negative: false, magnitude: r.u64()? }),
        5 => {
            let magnitude = r.u64()?;
            if magnitude == 0 {
                return fail(Code::NegativeZeroBigint, at);
            }
            Ok(Literal::Big { negative: true, magnitude })
        }
        6 => Ok(Literal::Str(r.string()?)),
        _ => fail(Code::UnknownLiteralKind, at),
    }
}

fn read_expr(r: &mut Reader, depth: usize) -> Result<Expr, Error> {
    // Purpose: the next expression
    if depth > MAX_DEPTH {
        return fail(Code::TooDeep, r.at);
    }
    let at = r.at;
    let kind = r.byte()?;
    let ty = read_type(r)?;
    let kind = match kind {
        0 => ExprKind::Field(r.size()?),
        1 => ExprKind::Literal(read_literal(r)?),
        2 => ExprKind::Param(r.string()?),
        3 => {
            let func = r.string()?;
            let n = r.count()?;
            let mut args = Vec::with_capacity(n.min(16));
            for _ in 0..n {
                args.push(read_expr(r, depth + 1)?);
            }
            ExprKind::Call { func, args }
        }
        4 => ExprKind::Cast(Box::new(read_expr(r, depth + 1)?)),
        5 => {
            let arg = Box::new(read_expr(r, depth + 1)?);
            let form_at = r.at;
            let list = match r.byte()? {
                0 => {
                    let n = r.count()?;
                    let mut values = Vec::with_capacity(n.min(1024));
                    for _ in 0..n {
                        values.push(read_literal(r)?);
                    }
                    InList::Values(values)
                }
                1 => InList::Param(r.string()?),
                _ => return fail(Code::BadFlag, form_at),
            };
            ExprKind::In { arg, list }
        }
        _ => return fail(Code::UnknownExprKind, at),
    };
    Ok(Expr { ty, kind })
}

fn read_exprs(r: &mut Reader) -> Result<Vec<Expr>, Error> {
    // Purpose: the next list of expressions
    let n = r.count()?;
    let mut out = Vec::with_capacity(n.min(64));
    for _ in 0..n {
        out.push(read_expr(r, 0)?);
    }
    Ok(out)
}

fn read_node(r: &mut Reader) -> Result<Node, Error> {
    // Purpose: the next node
    let at = r.at;
    let op = r.byte()?;
    let schema = read_fields(r)?;
    let op = match op {
        0 => Op::Scan,
        1 => {
            let input = r.size()?;
            Op::Filter { input, predicate: read_expr(r, 0)? }
        }
        2 => {
            let input = r.size()?;
            Op::Project { input, exprs: read_exprs(r)? }
        }
        3 => {
            let input = r.size()?;
            let keys = read_exprs(r)?;
            let n = r.count()?;
            let mut aggs = Vec::with_capacity(n.min(64));
            for _ in 0..n {
                let func = r.string()?;
                let ty = read_type(r)?;
                let flag_at = r.at;
                let arg = match r.byte()? {
                    0 => None,
                    1 => Some(read_expr(r, 0)?),
                    _ => return fail(Code::BadFlag, flag_at),
                };
                aggs.push(Aggregate { func, ty, arg });
            }
            Op::Aggregate { input, keys, aggs }
        }
        4 => {
            let input = r.size()?;
            let n = r.count()?;
            let mut keys = Vec::with_capacity(n.min(64));
            for _ in 0..n {
                let flag_at = r.at;
                let flags = r.byte()?;
                if flags > 3 {
                    return fail(Code::BadFlag, flag_at);
                }
                keys.push(SortKey { descending: flags & 1 != 0, nulls_first: flags & 2 != 0, expr: read_expr(r, 0)? });
            }
            Op::Sort { input, keys }
        }
        5 => {
            let input = r.size()?;
            Op::Limit { input, count: r.varint()? }
        }
        _ => return fail(Code::UnknownOp, at),
    };
    Ok(Node { schema, op })
}

pub fn decode(bytes: &[u8]) -> Result<Plan, Error> {
    // Purpose: the plan in `bytes`, or the first thing wrong with them
    let mut r = Reader { bytes, at: 0 };
    for &m in MAGIC.iter() {
        if r.byte().map_err(|_| Error { code: Code::BadMagic, at: 0 })? != m {
            return fail(Code::BadMagic, 0);
        }
    }
    let version_at = r.at;
    let version = r.varint()?;
    if version != IR_VERSION {
        return fail(Code::UnsupportedVersion, version_at);
    }
    let input = read_fields(&mut r)?;
    let n = r.count()?;
    let mut nodes = Vec::with_capacity(n.min(64));
    for _ in 0..n {
        nodes.push(read_node(&mut r)?);
    }
    let root = r.size()?;
    let output = read_fields(&mut r)?;
    let p = r.count()?;
    let mut params = Vec::with_capacity(p.min(64));
    for _ in 0..p {
        let name = r.string()?;
        let ty = read_type(&mut r)?;
        let flag_at = r.at;
        let list = match r.byte()? {
            0 => false,
            1 => true,
            _ => return fail(Code::BadFlag, flag_at),
        };
        params.push(Param { name, ty, list });
    }
    if r.left() != 0 {
        return fail(Code::TrailingBytes, r.at);
    }
    Ok(Plan { version, input, nodes, root, output, params })
}
