/**
 * Demo fixture for the first-batch handoff chain (plan §7.2).
 *
 * A bounded local defect with a DETERMINISTIC failure observation: the failing
 * assertion in `test/slugify.test.mjs` reproduces byte-for-byte on any machine,
 * needs no network and has no external effect. The file is copied verbatim into
 * the demo workspace and named as a fixed input by the dispatch, so editing it
 * changes the task's input identity instead of silently changing the task.
 *
 * The defect is exactly the missing `+` in the separator pattern below: every
 * non-alphanumeric character becomes its own dash, so a run of separators
 * survives as a run of dashes.
 */

/** Lowercase, then map separators to dashes. */
export function slugify(input) {
  // SEED-DEFECT: `/[^a-z0-9]/g` turns EACH separator character into a dash.
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-");
}

/** A title slug: no leading or trailing dashes. */
export function slugifyTitle(input) {
  return slugify(input).replace(/^-+/, "").replace(/-+$/, "");
}
