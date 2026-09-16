/**
 * Durable home for A2A delivery receipts.
 *
 * A receipt used to be an `orchestra/a2a-accepted` Session event appended to the
 * TARGET session's log. That was the worst possible place for it: DSH refuses to
 * interpret a persisted log containing an event type it does not know
 * (`dsh-session-persistence` → `validateStoredEvents`), and an out-of-repo plugin
 * cannot mark its own events ignorable — so recording a receipt made the target
 * session unreadable after a restart, *including sessions this plugin does not
 * own*. See `docs/adr/0002-record-home-and-authority.md`.
 *
 * Identity: a receipt is keyed by (target session, message id). With an
 * idempotency key the message id IS that key
 * (`freezeMessage({ id: MessageId(idempotencyKey) })` in the transport), so the
 * dedup lookup and the stored record share one identity rather than needing a
 * side table.
 *
 * Filenames are a hash of the key pair, never the key itself: idempotency keys
 * are caller-supplied strings up to 256 characters, and interpolating one into a
 * path would let `../` escape the directory (and blow the 255-byte filename
 * limit). The original pair is stored INSIDE the file and re-checked on read, so
 * a hash collision is a loud error instead of a silently wrong receipt.
 *
 * @module orchestra-dsh/receipt-store
 */

import { createHash } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { FsInfo, FsTarget, FsWriteIntent, FsWriteOutcome } from "@deepseek-ai/dsh-fs";
import type { DeliverResult } from "./a2a-transport.js";

/** Directory (relative to the caller's cwd) holding one file per receipt. */
export const RECEIPT_DIRECTORY = "orchestra/receipts";

export type ReceiptStoreErrorCode = "read_failed" | "write_failed" | "corrupt_receipt";

export class ReceiptStoreError extends Error {
  readonly code: ReceiptStoreErrorCode;

  constructor(code: ReceiptStoreErrorCode, message: string) {
    super(message);
    this.name = "ReceiptStoreError";
    this.code = code;
  }
}

/**
 * The port the transport consumes. It is deliberately a narrow two-method
 * interface: the transport must stay free of filesystem and cwd policy (see the
 * module comment in `a2a-transport.ts`), so durability is injected rather than
 * imported.
 */
export interface ReceiptWriteOptions {
  policy?: unknown;
  signal?: AbortSignal;
}

export interface ReceiptStore {
  read(targetSessionId: string, messageId: string): Promise<DeliverResult | undefined>;
  record(receipt: DeliverResult, options?: ReceiptWriteOptions): Promise<void>;
}

/** The subset of the host `fs` service a receipt store needs. */
export interface ReceiptFileSystem {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>;
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>;
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>;
  writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    policy?: unknown,
  ): Promise<FsWriteOutcome>;
}

function fsCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Content-addressed filename for one (target, message) pair.
 *
 * The target is LENGTH-PREFIXED before the separator. A bare separator is not
 * enough to make the key pair injective: idempotency keys are caller-supplied
 * strings that may themselves contain the separator, so `("a", "b\0c")` and
 * `("a\0b", "c")` would hash to the same file. The length prefix makes the
 * encoding unambiguous for every input.
 */
export function receiptFilename(targetSessionId: string, messageId: string): string {
  return `${createHash("sha256").update(`${targetSessionId.length}:${targetSessionId}\0${messageId}`, "utf8").digest("hex")}.json`;
}

/** Narrow an unknown JSON document to a stored receipt, or fail loudly. */
function parseReceipt(raw: string, targetSessionId: string, messageId: string, path: string): DeliverResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ReceiptStoreError(
      "corrupt_receipt",
      `receipt ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const value = parsed as Partial<DeliverResult> | null;
  if (typeof value !== "object" || value === null) {
    throw new ReceiptStoreError("corrupt_receipt", `receipt ${path} is not a JSON object`);
  }
  if (value.message_id !== messageId || value.target_session_id !== targetSessionId) {
    // Either a sha256 collision or a hand-edited file. Both mean the record we
    // are about to trust is not the record we asked for: refuse instead of
    // returning a receipt for somebody else's message.
    throw new ReceiptStoreError(
      "corrupt_receipt",
      `receipt ${path} identifies ${String(value.message_id)}→${String(value.target_session_id)}, expected ${messageId}→${targetSessionId}`,
    );
  }
  if (
    typeof value.accepted_at_ms !== "number" ||
    (value.delivery_mode !== "live_inbox" && value.delivery_mode !== "durable_inbox" && value.delivery_mode !== "resumed_inbox")
  ) {
    throw new ReceiptStoreError("corrupt_receipt", `receipt ${path} has an unusable delivery_mode or accepted_at_ms`);
  }
  return {
    message_id: value.message_id,
    target_session_id: value.target_session_id,
    accepted_at_ms: value.accepted_at_ms,
    delivery_mode: value.delivery_mode,
    state: "accepted",
    ...(value.interrupt === undefined ? {} : { interrupt: value.interrupt }),
    ...(value.reply_to_message_id === undefined ? {} : { reply_to_message_id: value.reply_to_message_id }),
  };
}

/** Process-local receipts: the fallback when no `fs` service is composed. */
export function createMemoryReceiptStore(): ReceiptStore {
  const records = new Map<string, DeliverResult>();
  const keyOf = (targetSessionId: string, messageId: string): string => `${targetSessionId}\0${messageId}`;
  return {
    async read(targetSessionId, messageId) {
      return records.get(keyOf(targetSessionId, messageId));
    },
    async record(receipt) {
      const key = keyOf(receipt.target_session_id, receipt.message_id);
      // First write wins, mirroring the createIfAbsent semantics of the fs store.
      if (!records.has(key)) records.set(key, receipt);
    },
  };
}

/** File-backed receipts under `<cwd>/orchestra/receipts/`. */
export function createFsReceiptStore(fs: ReceiptFileSystem, cwd: string): ReceiptStore {
  const targetFor = (targetSessionId: string, messageId: string) =>
    fs.resolve(`${cwd}/${RECEIPT_DIRECTORY}/${receiptFilename(targetSessionId, messageId)}`, { cwd });

  return {
    async read(targetSessionId, messageId) {
      let target: FsTarget;
      try {
        target = await targetFor(targetSessionId, messageId);
      } catch (error) {
        throw new ReceiptStoreError("read_failed", `receipt path could not be resolved: ${error instanceof Error ? error.message : String(error)}`);
      }
      let info: FsInfo | undefined;
      try {
        info = await fs.stat(target);
      } catch (error) {
        // A missing receipt is a normal answer ("not delivered yet"); anything
        // else is a real failure and must not be reported as "no receipt".
        if (fsCodeOf(error) === "FS_NOT_FOUND") return undefined;
        throw new ReceiptStoreError("read_failed", `receipt could not be observed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (info === undefined) return undefined;
      let raw: string;
      try {
        raw = await fs.readText(target);
      } catch (error) {
        throw new ReceiptStoreError("read_failed", `receipt could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
      return parseReceipt(raw, targetSessionId, messageId, `${cwd}/${RECEIPT_DIRECTORY}/${receiptFilename(targetSessionId, messageId)}`);
    },

    async record(receipt, options) {
      let target: FsTarget;
      try {
        target = await targetFor(receipt.target_session_id, receipt.message_id);
      } catch (error) {
        throw new ReceiptStoreError("write_failed", `receipt path could not be resolved: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await fs.writeText(target, JSON.stringify(receipt, null, 2), { kind: "createIfAbsent" }, options?.signal, options?.policy as any);
      } catch (error) {
        // The file already exists: the receipt for this (target, message) is
        // already durable, which is exactly what idempotent delivery means.
        // First write wins — a retry must not rewrite the accepted-at fact.
        if (fsCodeOf(error) === "FS_NOT_OBSERVED") return;
        throw new ReceiptStoreError("write_failed", `receipt could not be written: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

const storesByContext = new WeakMap<object, Map<string, ReceiptStore>>();

/**
 * Resolve the receipt store for one caller.
 *
 * Scoped to the CALLER's cwd, because both the write (a delivery the caller
 * initiated) and every read (its own retry, `a2a_status`, a handoff replay) run
 * in that same caller's context — a cross-cwd delivery still records the receipt
 * where the sender can find it again.
 *
 * Without an `fs` service there is nothing durable to write to, so this returns
 * a process-local store. That is a real reduction in scope (dedup no longer
 * survives a restart) and is stated here rather than hidden: the alternative —
 * writing the record back into the session log — is what made sessions
 * unreadable in the first place.
 */
export function receiptStoreFor(ctx: Context, cwd: string | undefined): ReceiptStore {
  let fs: ReceiptFileSystem | undefined;
  try {
    fs = ctx.get("fs") as ReceiptFileSystem | undefined;
  } catch {
    fs = undefined;
  }
  if (fs === undefined || cwd === undefined || cwd === "") {
    const existing = storesByContext.get(ctx);
    const memory = existing?.get("\0memory");
    if (memory !== undefined) return memory;
    const created = createMemoryReceiptStore();
    const table = existing ?? new Map<string, ReceiptStore>();
    table.set("\0memory", created);
    storesByContext.set(ctx, table);
    return created;
  }
  const existing = storesByContext.get(ctx)?.get(cwd);
  if (existing !== undefined) return existing;
  const created = createFsReceiptStore(fs, cwd);
  const table = storesByContext.get(ctx) ?? new Map<string, ReceiptStore>();
  table.set(cwd, created);
  storesByContext.set(ctx, table);
  return created;
}
