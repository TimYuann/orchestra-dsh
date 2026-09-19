/**
 * Tool-schema coverage guard.
 *
 * DSH validates a tool's RETURNED value against its DECLARED output schema, and
 * every object schema here is `additionalProperties: false`. So a value that
 * carries one key the schema does not declare does not merely lose that key —
 * it fails the whole call, and the model sees an error instead of data.
 *
 * That is exactly what happened to `orchestra_topologies` when the node backend
 * arrived: `TopologyRoleSummary` gained `execution`/`persona`/`toolFilter`,
 * `roleSummary` began emitting them, and the tool's role schema was not widened
 * — so ANY topology catalog containing one such role made the tool unusable.
 * Typecheck cannot see it (the schema is a plain object literal) and the domain
 * tests cannot either (they never cross the tool boundary), which is why the
 * rule is asserted here instead of being left to review.
 *
 * The guard is structural rather than value-based: a schema that describes a
 * role SUMMARY must declare every key a summary can carry. Narrow projections
 * (`id`/`sessionId`/`phase`) are legitimate and are not flagged, because they
 * never declare the marker key.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, parseInlineTopologyArgument } from "../lib/orchestra.js";

/** Every key `roleSummary` can place on a `TopologyRoleSummary`. */
const ROLE_SUMMARY_KEYS = [
  "id",
  "name",
  "execution",
  "persona",
  "toolFilter",
  "preset",
  "sandbox",
  "maxRounds",
  "runtime",
  "compositionTools",
  "orchestraTools",
  "optionalCapabilities",
];

/** `preset` marks a schema as describing a full role summary rather than a projection. */
const SUMMARY_MARKER = "preset";

function captureTools() {
  const registered = [];
  const effects = [];
  // A black hole for every cordis member this test does not care about: reading
  // any of them yields a callable that yields another black hole, so `ctx.on(...)`
  // and `ctx.commands.register(...)` both resolve without the fake having to
  // enumerate the whole service surface. Only the three members apply actually
  // depends on are real.
  const anything = new Proxy(function () {}, {
    get: (_target, prop) => (prop === "then" ? undefined : anything),
    apply: () => anything,
  });
  const explicit = {
    // Constructed by the stores but never called at registration time.
    fs: {},
    effect(fn) {
      effects.push(fn);
      return () => {};
    },
    get() {
      return undefined;
    },
    tools: {
      register(definition) {
        registered.push(definition);
      },
    },
  };
  const ctx = new Proxy(explicit, {
    get: (target, prop) => (prop in target ? target[prop] : anything),
  });
  apply(ctx);
  return { registered, effects };
}

/** Every object schema reachable from one tool definition's declared output. */
function objectSchemas(node, out = []) {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const entry of node) objectSchemas(entry, out);
    return out;
  }
  if (node.type === "object" && node.properties !== undefined) out.push(node);
  for (const value of Object.values(node)) objectSchemas(value, out);
  return out;
}

test("every registered tool declares the keys its own values can carry", () => {
  const { registered } = captureTools();
  assert.ok(registered.length >= 8, `expected the v0.5 slimmed tool surface, captured ${registered.length}`);
  for (const tool of registered) assert.equal(typeof tool.name, "string");

  const violations = [];
  for (const tool of registered) {
    const schema = tool.output?.schema;
    if (schema === undefined) continue;
    for (const object of objectSchemas(schema)) {
      const declared = Object.keys(object.properties);
      // Only a schema that already describes a role summary is held to the rule;
      // a narrow projection is a different, legitimate shape.
      if (!declared.includes(SUMMARY_MARKER)) continue;
      const missing = ROLE_SUMMARY_KEYS.filter((key) => !declared.includes(key));
      if (missing.length > 0) violations.push(`${tool.name}: role schema is missing ${missing.join(", ")}`);
    }
  }
  assert.deepEqual(violations, [], "a value carrying an undeclared key makes the whole tool call invalid");
});

test("orchestra_topologies declares the full role summary, including the node backend", () => {
  const { registered } = captureTools();
  const tool = registered.find((entry) => entry.name === "orchestra_topologies");
  assert.ok(tool !== undefined, "orchestra_topologies must be registered");
  const schemas = objectSchemas(tool.output.schema);
  const roleSchema = schemas.find((object) => Object.keys(object.properties).includes(SUMMARY_MARKER));
  assert.ok(roleSchema !== undefined, "the templates[].roles[] item schema must exist");
  for (const key of ROLE_SUMMARY_KEYS) {
    assert.ok(Object.keys(roleSchema.properties).includes(key), `templates[].roles[] must declare "${key}"`);
  }
  // The two native knobs are the ones a hybrid topology actually uses, so their
  // nested shape is asserted rather than just their presence.
  assert.equal(roleSchema.properties.toolFilter.type, "object");
  assert.equal(roleSchema.properties.toolFilter.additionalProperties, false);
  assert.deepEqual(Object.keys(roleSchema.properties.toolFilter.properties).sort(), ["allow", "deny"]);
});

test("inlineTopology accepts the config as an object OR as a JSON string of it", () => {
  const config = { schemaVersion: 1, id: "topo", roles: [{ id: "a", name: "A", preset: "p" }] };
  // A model can hand the same value over either way; the tool knows what it
  // asked for, so it must not make the caller guess the spelling.
  assert.deepEqual(parseInlineTopologyArgument(config, "orchestra_draft"), config);
  assert.deepEqual(parseInlineTopologyArgument(JSON.stringify(config), "orchestra_draft"), config);
  assert.throws(() => parseInlineTopologyArgument("{not json", "orchestra_draft"), /not valid JSON/);
  assert.throws(() => parseInlineTopologyArgument([1, 2], "orchestra_draft"), /must be a topology config object/);
  assert.throws(() => parseInlineTopologyArgument(null, "orchestra_draft"), /must be a topology config object/);
  assert.throws(() => parseInlineTopologyArgument(42, "orchestra_draft"), /must be a topology config object/);
});
