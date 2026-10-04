/**
 * The deterministic failure observation of the §7.2 demo task.
 *
 * `node --test test/slugify.test.mjs` MUST fail before the fix and pass after
 * it, with no other input than this file and `src/slugify.mjs`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { slugifyTitle } from "../src/slugify.mjs";

test("a run of separators collapses to ONE dash", () => {
  // The defect makes this "hello---world-----again".
  assert.equal(slugifyTitle("Hello   World -- Again"), "hello-world-again");
});

test("edges are trimmed (and this case also needs the same collapse)", () => {
  assert.equal(slugifyTitle("  Release  Notes  "), "release-notes");
  assert.equal(slugifyTitle("v0.6.1"), "v0-6-1");
});
