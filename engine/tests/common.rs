// Shared by the integration tests: reading the plan corpus.

pub struct Entry {
    pub name: String,
    pub ok: bool,
    pub bytes: Vec<u8>,
}

pub fn from_hex(hex: &str) -> Vec<u8> {
    // Purpose: hex text to bytes
    (0..hex.len() / 2).map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap()).collect()
}

pub fn corpus() -> Vec<Entry> {
    // Purpose: every entry of tests/data/plan-corpus.txt (written by `bun run gen:engine`)
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/plan-corpus.txt")).unwrap();
    text.lines()
        .filter(|l| !l.starts_with('#') && !l.is_empty())
        .map(|l| {
            let parts: Vec<&str> = l.split('\t').collect();
            assert_eq!(parts.len(), 3, "bad corpus line");
            Entry { name: parts[0].to_string(), ok: parts[1] == "ok", bytes: from_hex(parts[2]) }
        })
        .collect()
}
