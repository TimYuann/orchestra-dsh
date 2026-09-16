import { test } from "node:test";
import assert from "node:assert/strict";
import { createFsReceiptStore, createMemoryReceiptStore, receiptFilename, ReceiptStoreError } from "../lib/receipt-store.js";

/**
 * In-memory `fs` double shaped like the host service: resolve returns an opaque
 * target carrying its path, stat returns undefined when absent, writeText honours
 * `createIfAbsent` with the platform's FS_NOT_OBSERVED conflict code.
 */
function fakeFs(options = {}) {
  const files = new Map();
  const calls = { writes: [], reads: [], stats: [] };
  return {
    files,
    calls,
    target(path) {
      return { path };
    },
    async resolve(path) {
      return { path };
    },
    async stat(target) {
      calls.stats.push(target.path);
      if (options.statThrows !== undefined) throw Object.assign(new Error("boom"), { code: options.statThrows });
      if (!files.has(target.path)) return undefined;
      return { type: "file" };
    },
    async readText(target) {
      calls.reads.push(target.path);
      if (options.readThrows !== undefined) throw Object.assign(new Error("read exploded"), { code: options.readThrows });
      const value = files.get(target.path);
      if (value === undefined) throw Object.assign(new Error("not found"), { code: "FS_NOT_FOUND" });
      return value;
    },
    async writeText(target, content, expected) {
      calls.writes.push({ path: target.path, expected });
      if (expected?.kind === "createIfAbsent" && files.has(target.path)) {
        throw Object.assign(new Error("exists"), { code: "FS_NOT_OBSERVED" });
      }
      files.set(target.path, content);
      return { version: "v1" };
    },
  };
}

function receipt(overrides = {}) {
  return {
    message_id: "key-1",
    target_session_id: "session-1",
    accepted_at_ms: 1700000000000,
    delivery_mode: "live_inbox",
    state: "accepted",
    ...overrides,
  };
}

test("receiptFilename is injective in the key pair and never interpolates the key", () => {
  // A caller-supplied idempotency key must not be able to steer the path.
  const hostile = receiptFilename("session-1", "../../../../etc/passwd");
  assert.match(hostile, /^[0-9a-f]{64}\.json$/);
  assert.ok(!hostile.includes(".."), "no traversal segments survive hashing");
  assert.ok(!hostile.includes("/"), "the name is a single path segment");
  // Length-prefixed pair: without it, ("a","b\0c") and ("a\0b","c") would collide.
  assert.notEqual(receiptFilename("a", "b\u0000c"), receiptFilename("a\u0000b", "c"));
  assert.equal(receiptFilename("s", "k"), receiptFilename("s", "k"), "deterministic");
});

test("fs store round-trips a receipt and answers undefined for an unrecorded message", async () => {
  const fs = fakeFs();
  const store = createFsReceiptStore(fs, "/work");
  assert.equal(await store.read("session-1", "key-1"), undefined);
  await store.record(receipt());
  const read = await store.read("session-1", "key-1");
  assert.deepEqual(read, receipt());
  // Scoped by BOTH halves of the pair: the same key to another target is a different record.
  assert.equal(await store.read("session-2", "key-1"), undefined);
  const written = fs.calls.writes[0];
  assert.equal(written.path, `/work/orchestra/receipts/${receiptFilename("session-1", "key-1")}`);
  assert.deepEqual(written.expected, { kind: "createIfAbsent" }, "first write wins, by construction");
});

test("fs store treats an existing record as success (idempotent record) and keeps the first facts", async () => {
  const fs = fakeFs();
  const store = createFsReceiptStore(fs, "/work");
  await store.record(receipt({ accepted_at_ms: 111 }));
  await store.record(receipt({ accepted_at_ms: 222 }));
  assert.equal((await store.read("session-1", "key-1")).accepted_at_ms, 111);
});

test("fs store fails loudly instead of reporting a missing receipt", async () => {
  const statFailure = createFsReceiptStore(fakeFs({ statThrows: "FS_PERMISSION_DENIED" }), "/work");
  await assert.rejects(() => statFailure.read("session-1", "key-1"), (error) => {
    assert.ok(error instanceof ReceiptStoreError);
    assert.equal(error.code, "read_failed");
    return true;
  });
  const readFailureFs = fakeFs({ readThrows: "FS_IO" });
  readFailureFs.files.set(`/work/orchestra/receipts/${receiptFilename("session-1", "key-1")}`, JSON.stringify(receipt()));
  const readFailure = createFsReceiptStore(readFailureFs, "/work");
  await assert.rejects(() => readFailure.read("session-1", "key-1"), /receipt could not be read/);
  // A genuinely absent file is still a normal "not delivered yet".
  assert.equal(await createFsReceiptStore(fakeFs(), "/work").read("session-1", "key-1"), undefined);
});

test("a corrupt or misidentified receipt is refused, never returned", async () => {
  const cases = [
    ["not json", /not valid JSON/],
    ["[]", /identifies undefined→undefined/],
    [JSON.stringify(receipt({ message_id: "somebody-else" })), /identifies somebody-else→session-1/],
    [JSON.stringify(receipt({ target_session_id: "other-session" })), /identifies key-1→other-session/],
    [JSON.stringify(receipt({ delivery_mode: "telepathy" })), /unusable delivery_mode/],
    [JSON.stringify(receipt({ accepted_at_ms: "soon" })), /unusable delivery_mode or accepted_at_ms/],
  ];
  for (const [body, expected] of cases) {
    const fs = fakeFs();
    const store = createFsReceiptStore(fs, "/work");
    fs.files.set(`/work/orchestra/receipts/${receiptFilename("session-1", "key-1")}`, body);
    await assert.rejects(() => store.read("session-1", "key-1"), (error) => {
      assert.ok(error instanceof ReceiptStoreError, `${body} → ReceiptStoreError`);
      assert.equal(error.code, "corrupt_receipt");
      assert.match(error.message, expected);
      return true;
    });
  }
});

test("memory store mirrors the fs store's first-write-wins and pair scoping", async () => {
  const store = createMemoryReceiptStore();
  assert.equal(await store.read("session-1", "key-1"), undefined);
  await store.record(receipt({ accepted_at_ms: 111 }));
  await store.record(receipt({ accepted_at_ms: 222 }));
  assert.equal((await store.read("session-1", "key-1")).accepted_at_ms, 111);
  assert.equal(await store.read("session-2", "key-1"), undefined);
});
