import { test } from "node:test";
import assert from "node:assert/strict";
import { createFsCharterRecordStore, charterRecordStoreFor } from "../lib/charter-store.js";
import { parseRecordJson, readRecordText, safeSegment, writeRecordJson, RecordError } from "../lib/orchestra-records.js";

/**
 * `fs` double modelling the parts that actually decide behaviour here: the
 * createIfAbsent conflict code, the version guard, and honest "absent" answers.
 */
function fakeFs(options = {}) {
  const files = new Map();
  const calls = { writes: [] };
  return {
    files,
    calls,
    async resolve(path) {
      return { path };
    },
    async stat(target) {
      const held = files.get(target.path);
      if (held === undefined) return undefined;
      return { type: "file", version: held.version };
    },
    async readText(target) {
      const held = files.get(target.path);
      if (held === undefined) throw Object.assign(new Error("missing"), { code: "FS_NOT_FOUND" });
      return held.text;
    },
    async writeText(target, content, expected) {
      calls.writes.push({ path: target.path, expected });
      const held = files.get(target.path);
      if (options.beforeWrite !== undefined) options.beforeWrite({ files, path: target.path });
      const current = files.get(target.path);
      if (expected?.kind === "createIfAbsent" && current !== undefined) {
        throw Object.assign(new Error("already there"), { code: "FS_NOT_OBSERVED" });
      }
      if (expected?.kind === "replaceIfVersion" && (current === undefined || current.version !== expected.version)) {
        throw Object.assign(new Error("changed under us"), { code: "FS_STALE_VERSION" });
      }
      void held;
      const next = `v${current === undefined ? 1 : Number(current.version.slice(1)) + 1}`;
      files.set(target.path, { text: content, version: next });
      return { version: next };
    },
  };
}

function draftRecord(id) {
  return { type: "orchestra/charter-draft", data: { draft: { draftId: id, revision: 1 } } };
}

test("safeSegment refuses anything that is not one plain path segment", () => {
  assert.equal(safeSegment("session-abc_1.2", "session id"), "session-abc_1.2");
  for (const bad of ["../../etc/passwd", "a/b", ".", "..", "", "a\\b", "x".repeat(201)]) {
    assert.throws(() => safeSegment(bad, "session id"), (error) => error instanceof RecordError && error.code === "unsafe_name", bad);
  }
});

test("readRecordText answers undefined for an absent file and returns the version when present", async () => {
  const fs = fakeFs();
  assert.equal(await readRecordText(fs, "orchestra/x.json", "/cwd"), undefined);
  await writeRecordJson(fs, "orchestra/x.json", "/cwd", { a: 1 }, { kind: "createIfAbsent" });
  const found = await readRecordText(fs, "orchestra/x.json", "/cwd");
  assert.equal(found.text.includes('"a": 1'), true);
  assert.equal(typeof found.version, "string");
});

test("writeRecordJson reports a create conflict and a stale guard instead of throwing", async () => {
  const fs = fakeFs();
  assert.equal(await writeRecordJson(fs, "p.json", "/cwd", { v: 1 }, { kind: "createIfAbsent" }), "created");
  assert.equal(await writeRecordJson(fs, "p.json", "/cwd", { v: 2 }, { kind: "createIfAbsent" }), "exists");
  assert.equal(await writeRecordJson(fs, "p.json", "/cwd", { v: 3 }, { kind: "replaceIfVersion", version: "wrong" }), "stale");
  assert.equal(await writeRecordJson(fs, "p.json", "/cwd", { v: 4 }, { kind: "replaceIfVersion", version: "v1" }), "replaced");
});

test("a corrupt record is refused, not reported as absent", () => {
  assert.throws(() => parseRecordJson("{not json", "orchestra/x.json"), (error) => error instanceof RecordError && error.code === "corrupt_record");
});

test("charter store appends through the version guard and re-reads after a lost race", async () => {
  const fs = fakeFs();
  const store = createFsCharterRecordStore(fs, "/cwd");
  assert.deepEqual(await store.read(), []);
  await store.append(draftRecord("d1"));
  await store.append({ type: "orchestra/charter-approved", data: { approval: { draftId: "d1" } } });
  const records = await store.read();
  assert.deepEqual(records.map((r) => r.type), ["orchestra/charter-draft", "orchestra/charter-approved"]);
  // The append after the first must be GUARDED: without replaceIfVersion a
  // concurrent writer's record would be silently dropped.
  assert.deepEqual(fs.calls.writes[0].expected, { kind: "createIfAbsent" });
  assert.equal(fs.calls.writes[1].expected.kind, "replaceIfVersion");
});

test("charter store retries once somebody else writes first, and keeps both records", async () => {
  // Simulate a lost update: another writer replaces the file between our read and
  // our write. A plain `replace` would clobber it; the guard makes us re-read.
  let interfered = false;
  const fs = fakeFs({
    beforeWrite({ files, path }) {
      if (interfered) return;
      interfered = true;
      files.set(path, { text: JSON.stringify({ schemaVersion: 1, records: [draftRecord("theirs")] }), version: "v9" });
    },
  });
  const store = createFsCharterRecordStore(fs, "/cwd");
  await store.append(draftRecord("mine"));
  const records = await store.read();
  assert.deepEqual(records.map((r) => r.data.draft.draftId), ["theirs", "mine"], "the other writer's record must survive");
});

test("charter store gives up loudly rather than looping when the file keeps changing", async () => {
  const fs = fakeFs({
    // Bump the version on every attempt so the guard can never succeed.
    beforeWrite({ files, path }) {
      const held = files.get(path);
      files.set(path, { text: held?.text ?? JSON.stringify({ schemaVersion: 1, records: [] }), version: `v${Math.random()}` });
    },
  });
  const store = createFsCharterRecordStore(fs, "/cwd");
  await assert.rejects(() => store.append(draftRecord("d1")), /could not be appended to after 3 attempts/);
});

test("charter store refuses a corrupt file instead of starting from empty", async () => {
  const fs = fakeFs();
  fs.files.set("/cwd/orchestra/charter/records.json", { text: "{broken", version: "v1" });
  const store = createFsCharterRecordStore(fs, "/cwd");
  await assert.rejects(() => store.read(), (error) => error instanceof RecordError && error.code === "corrupt_record");
});

test("a schema mismatch in the record file is loud, not treated as no records", async () => {
  const fs = fakeFs();
  fs.files.set("/cwd/orchestra/charter/records.json", { text: JSON.stringify({ schemaVersion: 99, records: [] }), version: "v1" });
  const store = createFsCharterRecordStore(fs, "/cwd");
  await assert.rejects(() => store.read(), /schemaVersion 99/);
});

test("without an fs service the charter store falls back to memory and says so once", async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const ctx = { get: () => undefined };
    const store = charterRecordStoreFor(ctx, "/cwd");
    await store.append(draftRecord("d1"));
    assert.equal((await store.read()).length, 1, "the fallback still works within the process");
    assert.equal(warnings.filter((w) => w.includes("IN MEMORY ONLY")).length <= 1, true, "at most one warning per process");
  } finally {
    console.warn = original;
  }
});
