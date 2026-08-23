import { test } from "node:test";
import assert from "node:assert/strict";
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
    assert.deepEqual(list.ready.map((entry) => entry.config.id), ["duo", "four-role-dev", "oracle", "trio"]);
    await catalog.ensureBundledArtifacts();
    assert.deepEqual((await readdir(join(globalRoot, "topologies"))).sort(), ["duo.json", "four-role-dev.json", "oracle.json", "trio.json"]);
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
    const catalog = createTopologyCatalog(fs, { globalRoot });
    const output = topologyListForTool(await catalog.list(projectRoot));
    const ready = output.find((entry) => entry.id === "trio");
    const blocked = output.find((entry) => entry.id === "duo");
    assert.equal(ready.status, "ready");
    assert.equal(ready.source, "bundled");
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.filename, "duo.json");
    assert.equal(blocked.diagnostic.code, "invalid_json");
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
