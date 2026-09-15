import test from "node:test";
import assert from "node:assert/strict";
import { fromNodeTestTap } from "../../scripts/quality/release-acceptance/nodeReporter.mjs";

const TAP = `TAP version 13
# Subtest: tests/unit/a.test.ts
ok 1 - tests/unit/a.test.ts
# Subtest: tests/unit/b.test.ts
ok 2 - tests/unit/b.test.ts
# Subtest: tests/unit/c.test.ts
not ok 3 - tests/unit/c.test.ts
`;

test("argv file without TAP completion is missing", () => {
  const out = fromNodeTestTap(TAP, [
    "tests/unit/a.test.ts",
    "tests/unit/b.test.ts",
    "tests/unit/c.test.ts",
    "tests/unit/d.test.ts",
  ]);
  assert.equal(out.completed.length, 3);
  assert.equal(out.missing.length, 1);
  assert.equal(out.missing[0], "tests/unit/d.test.ts");
});

test("zero completed files is not PASS", () => {
  const out = fromNodeTestTap("TAP version 13\n", ["tests/unit/a.test.ts"]);
  assert.equal(out.completed.length, 0);
  assert.equal(out.pass, false);
});
