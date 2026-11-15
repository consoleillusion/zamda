// Size gate: the core (DSL + compiler + JS executor) must stay within budget.
// Run with `bun run size`. Fails the process when the budget is exceeded.

export {};

const BUDGET_BYTES = 40 * 1024;

const build = await Bun.build({
  entrypoints: ['src/index.ts'],
  minify: true,
  target: 'browser',
});

if (!build.success) {
  for (const log of build.logs) console.error(log);
  process.exit(1);
}

const code = await build.outputs[0]!.text();
const gzipped = Bun.gzipSync(Buffer.from(code)).length;
const percent = ((gzipped / BUDGET_BYTES) * 100).toFixed(1);

console.log(`core: ${code.length} bytes minified, ${gzipped} bytes gzipped (${percent}% of ${BUDGET_BYTES})`);

if (gzipped > BUDGET_BYTES) {
  console.error('Size budget exceeded.');
  process.exit(1);
}
