// Fuzzing the decoder: it must never panic, and anything it accepts must encode
// back to exactly the same bytes (so a plan has one encoding, and the decoder
// cannot be fooled into reading the same plan two ways).

mod common;

use zamda_engine::{decode::decode, encode::encode, load_plan};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // Purpose: xorshift64*, deterministic
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        // Purpose: a number in 0..n
        (self.next() % n as u64) as usize
    }
}

fn check(bytes: &[u8]) -> bool {
    // Purpose: run the decoder and validator on some bytes; if they decode, require the exact round trip. Returns whether the plan was valid
    if let Ok(plan) = decode(bytes) {
        assert_eq!(encode(&plan), bytes, "decoded but does not re-encode to the same bytes");
    }
    load_plan(bytes).is_ok()
}

#[test]
fn mutated_plans_never_panic_and_stay_canonical() {
    let good: Vec<Vec<u8>> = common::corpus().into_iter().filter(|e| e.ok).map(|e| e.bytes).collect();
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut valid = 0;
    for round in 0..300_000 {
        let mut bytes = good[rng.below(good.len())].clone();
        for _ in 0..1 + rng.below(3) {
            match rng.below(6) {
                0 => {
                    let i = rng.below(bytes.len());
                    bytes[i] ^= 1 << rng.below(8);
                }
                1 => {
                    let i = rng.below(bytes.len());
                    bytes[i] = rng.next() as u8;
                }
                2 => bytes.truncate(rng.below(bytes.len() + 1)),
                3 => {
                    let i = rng.below(bytes.len() + 1);
                    bytes.insert(i, rng.next() as u8);
                }
                4 => {
                    if !bytes.is_empty() {
                        let i = rng.below(bytes.len());
                        bytes.remove(i);
                    }
                }
                _ => {
                    // splice a stretch of another valid plan over this one
                    let other = &good[rng.below(good.len())];
                    let from = rng.below(other.len());
                    let len = rng.below(other.len() - from + 1).min(16);
                    let at = rng.below(bytes.len() + 1);
                    bytes.splice(at..at.min(bytes.len()), other[from..from + len].iter().copied());
                }
            }
            if bytes.is_empty() {
                break;
            }
        }
        if check(&bytes) {
            valid += 1;
        }
        let _ = round;
    }
    // Some mutations keep a plan valid (a different literal, say); that is expected, so only require the fuzz reached both outcomes.
    assert!(valid > 0, "no mutation stayed valid: the fuzz is not reaching the validator");
}

#[test]
fn random_bytes_after_a_valid_header_never_panic() {
    let mut rng = Rng(12345);
    for _ in 0..300_000 {
        let n = rng.below(120);
        let mut bytes = vec![0x5a, 0x49, 0x52, 0x01, 2];
        for _ in 0..n {
            bytes.push(rng.next() as u8);
        }
        check(&bytes);
    }
}

#[test]
fn pure_noise_never_panics() {
    let mut rng = Rng(777);
    for _ in 0..100_000 {
        let n = rng.below(200);
        let bytes: Vec<u8> = (0..n).map(|_| rng.next() as u8).collect();
        check(&bytes);
    }
}
