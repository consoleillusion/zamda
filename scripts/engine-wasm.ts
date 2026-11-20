// Build the engine as a WebAssembly module (T-412): `bun run wasm:build`.
//
// Runs `cargo build --release --target wasm32-unknown-unknown`, runs `wasm-opt -O3`
// when it is installed, writes dist/zamda-engine.wasm, and prints the size raw and
// gzipped. It fails when the module is over the budget of 400 KB gzipped
// (docs/ROADMAP.md). Needs the target once: `rustup target add wasm32-unknown-unknown`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const BUDGET = 400 * 1024;
const built = 'engine/target/wasm32-unknown-unknown/release/zamda_engine.wasm';
const out = 'dist/zamda-engine.wasm';

// One SIMD128 build (spec v4 decision "SIMD"): every current browser runs it. Set here rather than in a
// .cargo/config.toml because cargo reads that from the working directory, not from --manifest-path.
const SIMD = { CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: '-C target-feature=+simd128' };

function run(command: string[], env: Record<string, string> = {}): number {
  // Purpose: run a command with its output shown; its exit code
  return Bun.spawnSync(command, { stdout: 'inherit', stderr: 'inherit', env: { ...process.env, ...env } }).exitCode;
}

if (run(['cargo', 'build', '--release', '--manifest-path', 'engine/Cargo.toml', '--target', 'wasm32-unknown-unknown'], SIMD) !== 0) {
  console.error('\nThe build failed. If the target is missing: rustup target add wasm32-unknown-unknown');
  process.exit(1);
}
mkdirSync('dist', { recursive: true });
const optimiser = Bun.which('wasm-opt');
if (optimiser !== null) {
  if (run([optimiser, '-O3', '-all', built, '-o', out]) !== 0) {
    console.error('wasm-opt failed; using the unoptimised module');
    writeFileSync(out, readFileSync(built));
  }
} else {
  console.log('wasm-opt is not installed (optional: it makes the module smaller); using the compiler output');
  writeFileSync(out, readFileSync(built));
}
const bytes = readFileSync(out);
const gzipped = gzipSync(bytes, { level: 9 }).length;
console.log(`${out}: ${bytes.length.toLocaleString()} bytes, ${gzipped.toLocaleString()} bytes gzipped (budget ${BUDGET.toLocaleString()})`);
if (gzipped > BUDGET) {
  console.error('Over the size budget.');
  process.exit(1);
}
