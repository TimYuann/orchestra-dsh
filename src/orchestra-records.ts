/**
 * Shared plumbing for the plugin's own record files.
 *
 * Before `docs/adr/0002`, records like delivery receipts, composition markers and
 * charter revisions were Session events. That made every session the plugin
 * touched unreadable after a restart: DSH refuses a persisted log containing an
 * event type it does not know, and an out-of-repo plugin cannot mark its own
 * events ignorable.
 *
 * Records now live in files under `<cwd>/orchestra/`, which makes this the third
 * place in the plugin that talks to the host `fs` service (after
 * `orchestra-state` and `orchestra-archive`). It exists so the glue — resolve,
 * observe, read, write, and the platform's error codes — has one definition
 * instead of three drifting copies.
 *
 * Every reader here distinguishes "absent" from "broken" and never conflates
 * them: an absent record is a normal answer, a broken one is thrown. That is the
 * whole point of the module, because "we could not read the record" turning into
 * "there is no record" is how a CAS-guarded store silently loses data.
 *
 * @module orchestra-dsh/orchestra-records
 */

import type { Context } from "@deepseek-ai/cordis";
import type { FsInfo, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from "@deepseek-ai/dsh-fs";

/** The subset of the host `fs` service these record stores need. */
export interface RecordFileSystem {
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

/** Platform error code on an unknown error, or undefined. */
export function fsCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export type RecordErrorCode = "read_failed" | "write_failed" | "corrupt_record" | "unsafe_name";

export class RecordError extends Error {
  readonly code: RecordErrorCode;

  constructor(code: RecordErrorCode, message: string) {
    super(message);
    this.name = "RecordError";
    this.code = code;
  }
}

/** Resolve the host `fs` service, or undefined when the composition has none. */
export function resolveRecordFileSystem(ctx: Context): RecordFileSystem | undefined {
  try {
    return ctx.get("fs") as RecordFileSystem | undefined;
  } catch {
    return undefined;
  }
}

/**
 * A filename-safe single path segment.
 *
 * Record identity sometimes comes from the platform (session ids) rather than
 * from us. Those are trusted by construction today, but a store that
 * interpolates an identifier into a path must not rely on that: reject anything
 * that is not a plain segment instead of escaping the directory.
 */
export function safeSegment(value: string, what: string): string {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(value) || value === "." || value === "..") {
    throw new RecordError("unsafe_name", `${what} "${value}" is not a safe single path segment`);
  }
  return value;
}

/**
 * Read a record's text, or undefined when the file is genuinely absent.
 *
 * Returns the file version alongside the text because a read-modify-write
 * (append to a record list) is only safe if the write can be guarded against
 * that exact version — otherwise two writers silently lose one another's record.
 */
export async function readRecordText(
  fs: RecordFileSystem,
  relativePath: string,
  cwd: string,
): Promise<{ text: string; version: FsVersion } | undefined> {
  let target: FsTarget;
  try {
    target = await fs.resolve(`${cwd}/${relativePath}`, { cwd });
  } catch (error) {
    throw new RecordError("read_failed", `${relativePath} could not be resolved: ${error instanceof Error ? error.message : String(error)}`);
  }
  let info: FsInfo | undefined;
  try {
    info = await fs.stat(target);
  } catch (error) {
    if (fsCodeOf(error) === "FS_NOT_FOUND") return undefined;
    throw new RecordError("read_failed", `${relativePath} could not be observed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (info === undefined || info.version === undefined) return undefined;
  try {
    return { text: await fs.readText(target), version: info.version };
  } catch (error) {
    if (fsCodeOf(error) === "FS_NOT_FOUND") return undefined;
    throw new RecordError("read_failed", `${relativePath} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Parse a record, converting a syntax error into a loud, named failure. */
export function parseRecordJson(raw: string, relativePath: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new RecordError("corrupt_record", `${relativePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type WriteOutcome = "created" | "replaced" | "exists" | "stale";

/** How a record write should guard itself. */
export type RecordWriteIntent =
  | { kind: "createIfAbsent" }
  | { kind: "replace" }
  /** Only write if the file still carries this exact version. */
  | { kind: "replaceIfVersion"; version: FsVersion };

function toFsIntent(intent: RecordWriteIntent): FsWriteIntent | undefined {
  if (intent.kind === "createIfAbsent") return { kind: "createIfAbsent" };
  if (intent.kind === "replaceIfVersion") return { kind: "replaceIfVersion", version: intent.version };
  return undefined;
}

/**
 * Write a record as JSON.
 *
 * Two "the write did not happen, and that is information" cases are returned
 * rather than thrown, because only the caller knows what they mean:
 * `"exists"` (createIfAbsent found the file — the idempotent success case for a
 * record whose identity is its key) and `"stale"` (the file changed under us —
 * a read-modify-write must re-read rather than clobber).
 */
export interface RecordWriteOptions {
  policy?: unknown;
  signal?: AbortSignal;
}

export async function writeRecordJson(
  fs: RecordFileSystem,
  relativePath: string,
  cwd: string,
  value: unknown,
  intent: RecordWriteIntent,
  options?: RecordWriteOptions,
): Promise<WriteOutcome> {
  let target: FsTarget;
  try {
    target = await fs.resolve(`${cwd}/${relativePath}`, { cwd, signal: options?.signal });
  } catch (error) {
    throw new RecordError("write_failed", `${relativePath} could not be resolved: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await fs.writeText(target, JSON.stringify(value, null, 2), toFsIntent(intent), options?.signal, options?.policy as any);
  } catch (error) {
    const code = fsCodeOf(error);
    if (intent.kind === "createIfAbsent" && code === "FS_NOT_OBSERVED") return "exists";
    if (intent.kind === "replaceIfVersion" && code === "FS_STALE_VERSION") return "stale";
    throw new RecordError("write_failed", `${relativePath} could not be written: ${error instanceof Error ? error.message : String(error)}`);
  }
  return intent.kind === "createIfAbsent" ? "created" : "replaced";
}
