// The Rust decoder and validator reach the same verdict as the JS ones on every plan
// in the corpus (valid plans, one-change breakages of them, truncations and bit flips),
// and whatever decodes encodes back to the same bytes.

mod common;

use zamda_engine::{decode::decode, encode::encode, load_plan};

#[test]
fn rust_and_js_agree_on_every_plan() {
    let entries = common::corpus();
    assert!(entries.len() > 500, "the corpus is missing or empty: run `bun run gen:engine`");
    let mut disagreements = Vec::new();
    for e in &entries {
        let verdict = load_plan(&e.bytes).is_ok();
        if verdict != e.ok {
            disagreements.push(format!("{}: JS says {}, Rust says {}", e.name, if e.ok { "ok" } else { "invalid" }, if verdict { "ok" } else { "invalid" }));
        }
    }
    assert!(disagreements.is_empty(), "{} disagreements, first ones:\n{}", disagreements.len(), disagreements.iter().take(15).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn what_decodes_encodes_back_to_the_same_bytes() {
    let mut decoded = 0;
    for e in common::corpus() {
        if let Ok(plan) = decode(&e.bytes) {
            decoded += 1;
            assert_eq!(encode(&plan), e.bytes, "{} does not round-trip", e.name);
        }
    }
    assert!(decoded > 500);
}

#[test]
fn the_corpus_has_both_verdicts_in_number() {
    let entries = common::corpus();
    let ok = entries.iter().filter(|e| e.ok).count();
    assert!(ok > 50 && entries.len() - ok > 300, "{ok} ok of {}", entries.len());
}
