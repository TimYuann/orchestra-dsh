import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createTopologyCatalog } from "../lib/orchestra-topology.js";
import { topologyListForTool, topologyResolutionError } from "../lib/orchestra.js";

class FsTestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class TemporaryTopologyFs {
  constructor() {
    this.failProjectSource = false;
    this.failFile = undefined;
    this.failReadFile = undefined;
  }

  async resolve(path, options = {}) {
    const displayPath = isAbsolute(path) ? path : join(options.cwd ?? process.cwd(), path);
    return { targetKey: displayPath, displayPath };
  }

  processPath(target) {
    return target.displayPath;
  }

  async stat(target) {
    if (this.failProjectSource && target.displayPath.endsWith("/.orchestra/topologies")) {
      throw new FsTestError("FS_IO_ERROR", "project topology source unavailable");
    }
    if (this.failFile !== undefined && target.displayPath.endsWith(this.failFile)) {
      throw new FsTestError("FS_IO_ERROR", "topology entry unavailable");
    }
    try {
      const info = await stat(target.displayPath);
      return { type: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other", size: info.size, version: `${info.size}:${info.mtimeMs}` };
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async listDir(target) {
    const entries = await readdir(target.displayPath, { withFileTypes: true });
    return entries.sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
      const displayPath = join(target.displayPath, entry.name);
      return {
        name: entry.name,
        type: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
        target: { targetKey: displayPath, displayPath },
      };
    });
  }

  async readText(target) {
    if (this.failReadFile !== undefined && target.displayPath.endsWith(this.failReadFile.filename)) {
      throw this.failReadFile.error;
    }
    if (this.failFile !== undefined && target.displayPath.endsWith(this.failFile)) {
      throw new FsTestError("FS_IO_ERROR", "topology entry unreadable");
    }
    return readFile(target.displayPath, "utf8");
  }

  async seed(projectRoot, relative, value) {
    const path = join(projectRoot, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), "utf8");
  }
}

function topology(id, overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    name: `${id} topology`,
    description: `${id} description`,
    controller: { id: "driver", source: "caller" },
    roles: [{ id: "reviewer", name: "Reviewer", preset: "orchestra-reviewer", sandbox: "read-only" }],
    protocol: {
      ownership: { scope: "driver", closure: "driver" },
      routes: [{ kind: "work", from: "driver", to: ["reviewer"] }],
      completion: { owner: "driver", rule: "done" },
    },
    ...overrides,
  };
}

async function withRoots(callback) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-topology-"));
  const projectRoot = join(root, "project");
  const globalRoot = join(root, "global");
  await mkdir(projectRoot, { recursive: true });
  try {
    return await callback({ fs: new TemporaryTopologyFs(), projectRoot, globalRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("catalog resolves all bundled topologies and installs the same builtin truth", async () => {
  await withRoots(async ({ fs, projectRoot, globalRoot }) => {
    const catalog = createTopologyCatalog(fs, { globalRoot });
    const duo = await catalog.resolve(projectRoot, "duo");
    assert.equal(duo.kind, "ready");
    assert.equal(duo.source, "bundled");
    const list = await catalog.list(projectRoot);
    assert.deepEqual(list.ready.map((entry) => entry.config.id), ["architecture-decision", "bug-diagnosis-and-fix", "duo", "feature-development", "four-role-dev", "oracle", "refactor-and-migration", "trio"]);
    await catalog.ensureBundledArtifacts();
    assert.deepEqual((await readdir(join(globalRoot, "topologies"))).sort(), ["architecture-decision.json", "bug-diagnosis-and-fix.json", "duo.json", "feature-development.json", "four-role-dev.json", "oracle.json", "refactor-and-migration.json", "trio.json"]);
  });
});

test("project and global precedence are fail-loud and block lower sources", async () => {
  await withRoots(async ({ fs, projectRoot, globalRoot }) => {
    await fs.seed(projectRoot, ".orchestra/topologies/duo.json", topology("duo", { name: "project duo" }));
    await fs.seed(globalRoot, "topologies/duo.json", topology("duo", { name: "global duo" }));
    const catalog = createTopologyCatalog(fs, { globalRoot });
    let result = await catalog.resolve(projectRoot, "duo");
    assert.equal(result.kind, "ready");
    assert.equal(result.source, "project");
    assert.equal(result.config.name, "project duo");

    await fs.seed(projectRoot, ".orchestra/topologies/duo.json", "{");
    result = await catalog.resolve(projectRoot, "duo");
    assert.equal(result.kind, "blocked");
    assert.equal(result.source, "project");
    assert.equal(result.diagnostic.code, "invalid_json");
    const listed = await catalog.list(projectRoot);
    assert.equal(listed.ready.some((entry) => entry.config.id === "duo"), false);
    assert.equal(listed.blocked.some((entry) => entry.id === "duo" && entry.source === "project"), true);

    await fs.seed(projectRoot, ".orchestra/topologies/oracle.json", "");
    await fs.seed(globalRoot, "topologies/oracle.json", "{");
    result = await catalog.resolve(projectRoot, "oracle");
    assert.equal(result.kind, "blocked");
    assert.equal(result.source, "project");
    assert.equal(result.diagnostic.code, "invalid_json");
  });
});

test("project and global per-entry read failures are filesystem blocked with fsCode", async () => {
  await withRoots(async ({ fs, projectRoot, globalRoot }) => {
    await fs.seed(projectRoot, ".orchestra/topologies/project-read-error.json", topology("project-read-error"));
    fs.failReadFile = { filename: "project-read-error.json", error: new FsTestError("FS_IO_ERROR", "project entry read failed") };
    const catalog = createTopologyCatalog(fs, { globalRoot });
    let result = await catalog.resolve(projectRoot, "project-read-error");
    assert.equal(result.kind, "blocked");
    assert.equal(result.diagnostic.code, "filesystem");
    assert.equal(result.diagnostic.fsCode, "FS_IO_ERROR");

    const globalPath = join(globalRoot, "topologies/global-read-error.json");
    await mkdir(dirname(globalPath), { recursive: true });
    await writeFile(globalPath, JSON.stringify(topology("global-read-error")), "utf8");
    const globalCatalog = createTopologyCatalog(fs, {
      globalRoot,
      globalReadFile: async (path) => {
        if (path.endsWith("global-read-error.json")) throw new FsTestError("FS_PERMISSION_DENIED", "global entry read denied");
        return readFile(path, "utf8");
      },
    });
    result = await globalCatalog.resolve(projectRoot, "global-read-error");
    assert.equal(result.kind, "blocked");
    assert.equal(result.diagnostic.code, "filesystem");
    assert.equal(result.diagnostic.fsCode, "FS_PERMISSION_DENIED");
  });
});

test("global broken source blocks bundled fallback and source failures are visible", async () => {
  await withRoots(async ({ fs, projectRoot, globalRoot }) => {
    await fs.seed(globalRoot, "topologies/trio.json", "{");
    const catalog = createTopologyCatalog(fs, { globalRoot });
    const result = await catalog.resolve(projectRoot, "trio");
    assert.equal(result.kind, "blocked");
    assert.equal(result.source, "global");
    assert.equal(result.diagnostic.code, "invalid_json");

    fs.failProjectSource = true;
    const failed = await catalog.resolve(projectRoot, "duo");
    assert.equal(failed.kind, "blocked");
    assert.equal(failed.source, "project");
    assert.equal(failed.diagnostic.code, "filesystem");
    const listed = await catalog.list(projectRoot);
    assert.equal(listed.blocked.some((entry) => entry.source === "project" && entry.diagnostic.code === "filesystem"), true);
  });
});

test("catalog classifies unsafe ids, filename mismatch, legacy, unsupported, and semantic errors", async () => {
  await withRoots(async ({ fs, projectRoot, globalRoot }) => {
    const catalog = createTopologyCatalog(fs, { globalRoot });
    assert.equal((await catalog.resolve(projectRoot, "../escape")).kind, "blocked");

    await fs.seed(projectRoot, ".orchestra/topologies/duo.json", topology("trio"));
    let result = await catalog.resolve(projectRoot, "duo");
    assert.equal(result.kind, "blocked");
    assert.equal(result.diagnostic.code, "id_mismatch");

    await fs.seed(projectRoot, ".orchestra/topologies/legacy.json", { id: "legacy", roles: [{ id: "reviewer", name: "Reviewer" }] });
    result = await catalog.resolve(projectRoot, "legacy");
    assert.equal(result.kind, "ready");
    assert.equal(result.warnings.length, 1);

    await fs.seed(projectRoot, ".orchestra/topologies/oracle.json", { ...topology("oracle"), schemaVersion: 2 });
    result = await catalog.resolve(projectRoot, "oracle");
    assert.equal(result.kind, "blocked");
    assert.equal(result.diagnostic.code, "unsupported_schema");

    await fs.seed(projectRoot, ".orchestra/topologies/trio.json", topology("trio", { roles: [{ id: "reviewer" }, { id: "Reviewer" }] }));
    result = await catalog.resolve(projectRoot, "trio");
    assert.equal(result.kind, "blocked");
    assert.equal(result.diagnostic.code, "invalid_topology");
  });
});

test("catalog total validation blocks malformed nested topology values", async () => {
  await withRoots(async ({ fs, projectRoot, globalRoot }) => {
    const malformed = [
      { name: "routes string", config: { protocol: { routes: "bad" } } },
      { name: "null route", config: { protocol: { routes: [null] } } },
      { name: "completion null", config: { protocol: { completion: null } } },
      { name: "ownership null", config: { protocol: { ownership: null } } },
      { name: "runtime null", config: { roles: [{ id: "reviewer", runtime: null }] } },
      { name: "controller scalar", config: { controller: "driver" } },
      { name: "role null", config: { roles: [null] } },
      { name: "route missing fields", config: { protocol: { routes: [{}] } } },
    ];
    const catalog = createTopologyCatalog(fs, { globalRoot });
    for (const [index, entry] of malformed.entries()) {
      const id = `malformed-${index}`;
      await fs.seed(projectRoot, `.orchestra/topologies/${id}.json`, topology(id, entry.config));
      const result = await catalog.resolve(projectRoot, id);
      assert.equal(result.kind, "blocked", entry.name);
      assert.equal(result.diagnostic.code, "invalid_shape", entry.name);
    }
  });
});

test("list dedupes by precedence and bare role lookup follows effective ready templates", async () => {
  await withRoots(async ({ fs, projectRoot, globalRoot }) => {
    await fs.seed(projectRoot, ".orchestra/topologies/trio.json", topology("trio", { name: "project trio" }));
    await fs.seed(globalRoot, "topologies/custom-global.json", topology("custom-global", {
      roles: [{ id: "global-role", name: "Global Role" }],
      protocol: { ownership: { scope: "driver", closure: "driver" }, routes: [{ kind: "work", from: "driver", to: ["global-role"] }], completion: { owner: "driver", rule: "done" } },
    }));
    const catalog = createTopologyCatalog(fs, { globalRoot });
    const list = await catalog.list(projectRoot);
    assert.equal(new Set(list.ready.map((entry) => entry.config.id)).size, list.ready.length);
    assert.equal(list.ready.find((entry) => entry.config.id === "trio").source, "project");
    assert.equal(list.ready.find((entry) => entry.config.id === "custom-global").source, "global");

    let match = await catalog.findRole(projectRoot, "global-role");
    assert.equal(match.topology.source, "global");
    await fs.seed(projectRoot, ".orchestra/topologies/custom-global.json", topology("custom-global", {
      roles: [{ id: "global-role", name: "Project Role" }],
      protocol: { ownership: { scope: "driver", closure: "driver" }, routes: [{ kind: "work", from: "driver", to: ["global-role"] }], completion: { owner: "driver", rule: "done" } },
    }));
    match = await catalog.findRole(projectRoot, "global-role");
    assert.equal(match.topology.source, "project");
    assert.equal(match.role.name, "Project Role");
    match = await catalog.findRole(projectRoot, "reviewer-2");
    assert.equal(match.topology.config.id, "trio");

    await fs.seed(projectRoot, ".orchestra/topologies/custom-global.json", "{");
    match = await catalog.findRole(projectRoot, "global-role");
    assert.equal(match, undefined);
  });
});

test("orchestra_topologies projection has ready and blocked entries with declared keys", async () => {
  await withRoots(async ({ fs, projectRoot, globalRoot }) => {
    await fs.seed(projectRoot, ".orchestra/topologies/duo.json", "{");
    await fs.seed(projectRoot, ".orchestra/topologies/capability.json", topology("capability", {
      roles: [{
        id: "reviewer",
        name: "Reviewer",
        preset: "orchestra-v04-reviewer-v1",
        sandbox: "read-only",
        compositionTools: ["tool-fs", "tool-fs-search"],
        orchestraTools: ["orchestra_report", "orchestra_verdict"],
        optionalCapabilities: ["web"],
      }],
    }));
    const catalog = createTopologyCatalog(fs, { globalRoot });
    const output = topologyListForTool(await catalog.list(projectRoot));
    const ready = output.find((entry) => entry.id === "trio");
    const capability = output.find((entry) => entry.id === "capability");
    const blocked = output.find((entry) => entry.id === "duo");
    assert.equal(ready.status, "ready");
    assert.equal(ready.source, "bundled");
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.filename, "duo.json");
    assert.equal(blocked.diagnostic.code, "invalid_json");
    assert.deepEqual(capability.roles[0].compositionTools, ["tool-fs", "tool-fs-search"]);
    assert.deepEqual(capability.roles[0].orchestraTools, ["orchestra_report", "orchestra_verdict"]);
    assert.deepEqual(capability.roles[0].optionalCapabilities, ["web"]);
    assert.deepEqual(Object.keys(blocked).sort(), ["diagnostic", "filename", "id", "name", "roles", "source", "status"].sort());
  });
});

test("topology tool actions fail loudly for blocked resolution", async () => {
  const error = topologyResolutionError("create a team", {
    kind: "blocked",
    status: "blocked",
    id: "duo",
    filename: "duo.json",
    source: "project",
    warnings: [],
    diagnostic: { code: "invalid_json", message: "broken project topology" },
  }, ["trio"]);
  assert.match(error.message, /blocked/);
  assert.match(error.message, /broken project topology/);
});

test("catalog D.4 role table keeps all role rows contiguous", () => {
  const source = readFileSync("TOPOLOGY-CATALOG.md", "utf8");
  const start = source.indexOf("### D.4 refactor-and-migration");
  const end = source.indexOf("**Graph / routes / ownership**", start);
  assert.ok(start >= 0 && end > start);
  const lines = source.slice(start, end).split("\n");
  const first = lines.findIndex((line) => line.startsWith("| roleId |"));
  assert.ok(first >= 0);
  const rows = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith("| ") && !line.startsWith("| ---"));
  assert.deepEqual(rows.slice(0, 5).map(({ line }) => line.split("|")[1].trim()), ["roleId", "driver", "architect", "implementer", "verifier"]);
  assert.equal(rows[5]?.line.split("|")[1].trim(), "reviewer");
  const roleRows = rows.slice(1, 6);
  for (let index = 1; index < roleRows.length; index += 1) {
    assert.equal(roleRows[index].index, roleRows[index - 1].index + 1);
  }
});
