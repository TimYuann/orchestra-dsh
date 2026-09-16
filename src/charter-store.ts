/**
 * Where the charter records live.
 *
 * A charter used to be a set of Session events on the driver's log
 * (`orchestra/charter-draft`, `-approved`, `-frozen`, plus `orchestra/gate-decision`).
 * That made the driver session unreadable after a restart — DSH refuses a
 * persisted log containing an event type it does not know, and an out-of-repo
 * plugin cannot mark its own events ignorable (`docs/adr/0002`).
 *
 * Moving them to a file is also the change of authority the user approved: the
 * record stops being "the driver's session, replayed" and becomes "a document,
 * which the session merely operates". A driver session that dies no longer takes
 * the charter with it.
 *
 * The module is deliberately separate from `orchestration-charter.ts`, whose
 * whole value is being a PURE fold over a record list: that purity is why the
 * charter rules are cheap to test, and adding filesystem access to it would
 * spend it.
 *
 * @module orchestra-dsh/charter-store
 */

import type { Context } from "@deepseek-ai/cordis";
import type { CharterEvent } from "./orchestration-charter.js";
import {
  RecordError,
  parseRecordJson,
  readRecordText,
  resolveRecordFileSystem,
  writeRecordJson,
  type RecordFileSystem,
} from "./orchestra-records.js";

/** Directory (relative to the driver's cwd) holding the charter records. */
export const CHARTER_RECORD_DIRECTORY = "orchestra/charter";
export const CHARTER_RECORD_FILE = "records.json";
export const CHARTER_RECORD_SCHEMA_VERSION = 1;

interface CharterRecordFile {
  schemaVersion: number;
  records: CharterEvent[];
}

const EMPTY: CharterRecordFile = { schemaVersion: CHARTER_RECORD_SCHEMA_VERSION, records: [] };

/** How many times an append re-reads before it gives up. */
const APPEND_ATTEMPTS = 3;

function parseRecordFile(raw: string, relativePath: string): CharterRecordFile {
  const value = parseRecordJson(raw, relativePath) as Partial<CharterRecordFile> | null;
  if (typeof value !== "object" || value === null) {
    throw new RecordError("corrupt_record", `${relativePath} is not a JSON object`);
  }
  if (value.schemaVersion !== CHARTER_RECORD_SCHEMA_VERSION) {
    throw new RecordError("corrupt_record", `${relativePath} has schemaVersion ${String(value.schemaVersion)}, expected ${CHARTER_RECORD_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(value.records)) {
    throw new RecordError("corrupt_record", `${relativePath} has no records array`);
  }
  for (const [index, entry] of value.records.entries()) {
    const record = entry as { type?: unknown; data?: unknown } | null;
    if (typeof record !== "object" || record === null || typeof record.type !== "string" || typeof record.data !== "object" || record.data === null) {
      throw new RecordError("corrupt_record", `${relativePath} record ${index} is not a {type, data} pair`);
    }
  }
  return { schemaVersion: CHARTER_RECORD_SCHEMA_VERSION, records: value.records as CharterEvent[] };
}

/**
 * The charter record list for one working directory.
 *
 * Append-only: a draft revision, an approval and a freeze are each facts that
 * may not be edited after the event, and the fold in `orchestration-charter.ts`
 * re-derives the whole state from them.
 */
export interface CharterWriteOptions {
  policy?: unknown;
  signal?: AbortSignal;
}

export interface CharterRecordStore {
  read(): Promise<readonly unknown[]>;
  append(event: CharterEvent, options?: CharterWriteOptions): Promise<void>;
}

/** Process-local records: the fallback when no `fs` service is composed. */
export function createMemoryCharterRecordStore(): CharterRecordStore {
  let records: CharterEvent[] = [];
  return {
    async read() {
      return records;
    },
    async append(event) {
      records = [...records, event];
    },
  };
}

/** File-backed records under `<cwd>/orchestra/charter/records.json`. */
export function createFsCharterRecordStore(fs: RecordFileSystem, cwd: string): CharterRecordStore {
  const relativePath = `${CHARTER_RECORD_DIRECTORY}/${CHARTER_RECORD_FILE}`;

  async function load(): Promise<{ file: CharterRecordFile; version: Awaited<ReturnType<typeof readRecordText>> }> {
    const found = await readRecordText(fs, relativePath, cwd);
    if (found === undefined) return { file: EMPTY, version: undefined };
    return { file: parseRecordFile(found.text, relativePath), version: found };
  }

  return {
    async read() {
      return (await load()).file.records;
    },
    async append(event, options) {
      for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
        const { file, version } = await load();
        const next: CharterRecordFile = { schemaVersion: CHARTER_RECORD_SCHEMA_VERSION, records: [...file.records, event] };
        const outcome = await writeRecordJson(
          fs,
          relativePath,
          cwd,
          next,
          version === undefined ? { kind: "createIfAbsent" } : { kind: "replaceIfVersion", version: version.version },
          options,
        );
        // "stale" means another writer got there first, "exists" means the file
        // appeared between our read and our create. Both are answered by
        // re-reading and appending to what is actually there — never by
        // clobbering, which would drop somebody else's record.
        if (outcome === "stale" || outcome === "exists") continue;
        return;
      }
      throw new RecordError(
        "write_failed",
        `${relativePath} could not be appended to after ${APPEND_ATTEMPTS} attempts: it keeps changing under this writer`,
      );
    },
  };
}

const charterStores = new WeakMap<object, Map<string, CharterRecordStore>>();

/** Set once, so the in-memory-charter warning is a signal rather than a chorus. */
let warnedAboutMemoryCharter = false;

/**
 * Resolve the charter record store for one cwd.
 *
 * Without an `fs` service the records are process-local, which means they do not
 * outlive the run — stated here rather than hidden, because the alternative
 * (writing them back into the session log) is what made sessions unreadable.
 */
export function charterRecordStoreFor(ctx: Context, cwd: string | undefined): CharterRecordStore {
  const fs = resolveRecordFileSystem(ctx);
  if (fs === undefined || cwd === undefined || cwd === "") {
    const existing = charterStores.get(ctx)?.get("\0memory");
    if (existing !== undefined) return existing;
    // The other two stores fall back quietly, because their loss is recoverable:
    // a receipt can be re-delivered and a missing composition marker falls back
    // to the header's own preset. THIS one is not. The charter holds the user's
    // approval, so losing it silently means the user believes they approved
    // something that will not survive the next restart. It is announced once per
    // PROCESS rather than per context: every test context takes this path, and a
    // warning that fires on each of them is a warning nobody reads.
    if (!warnedAboutMemoryCharter) {
      warnedAboutMemoryCharter = true;
      console.warn(
        "orchestra: no fs service is composed, so charter records (drafts, approvals, freezes) are being kept IN MEMORY ONLY and will be lost when this process exits",
      );
    }
    const created = createMemoryCharterRecordStore();
    const table = charterStores.get(ctx) ?? new Map<string, CharterRecordStore>();
    table.set("\0memory", created);
    charterStores.set(ctx, table);
    return created;
  }
  const existing = charterStores.get(ctx)?.get(cwd);
  if (existing !== undefined) return existing;
  const created = createFsCharterRecordStore(fs, cwd);
  const table = charterStores.get(ctx) ?? new Map<string, CharterRecordStore>();
  table.set(cwd, created);
  charterStores.set(ctx, table);
  return created;
}
