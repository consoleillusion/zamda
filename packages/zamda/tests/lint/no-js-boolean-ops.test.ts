// The zamda accessor-callback rule, exercised end to end: the fixture file under
// tests/lint/ holds deliberate violations (and valid cases); the test lints it with
// the repository's own configuration and pins the reported lines and the rule id.
// The rule is type-aware, so the fixture is a real project file and this suite uses the
// ESLint Node API rather than RuleTester (which runs sources without a project).

import { describe, expect, test } from 'bun:test';
import { ESLint } from 'eslint';
import { join } from 'node:path';

// The workspace root holds the ESLint configuration; the fixture lives in this package.
const ROOT = new URL('../../../..', import.meta.url).pathname;
const FIXTURE = join(ROOT, 'packages/zamda/tests/lint/accessor-callbacks.fixture.ts');

describe('zamda/no-js-boolean-ops-in-accessor-callbacks', () => {
  test('flags the JS operators in the accessor callbacks, and nothing else', async () => {
    const eslint = new ESLint({ cwd: ROOT, ignore: false });
    const [result] = await eslint.lintFiles([FIXTURE]);
    const ours = result!.messages
      .filter(m => m.ruleId === 'zamda/no-js-boolean-ops-in-accessor-callbacks')
      .map(m => ({ line: m.line, column: m.column }))
      .sort((a, b) => a.line - b.line);
    expect(ours).toEqual([
      { line: 13, column: 26 },
      { line: 15, column: 26 },
      { line: 18, column: 26 },
      { line: 21, column: 26 },
      { line: 25, column: 26 },
      { line: 32, column: 24 },
    ]);
    // No other rule fires in the fixture besides the ones the repository config reports nowhere else as well; assert specifically that there is at least one of ours, already covered, and that the file has no internal errors.
    const fatal = result!.messages.filter(m => m.fatal);
    expect(fatal).toEqual([]);
  });
});
