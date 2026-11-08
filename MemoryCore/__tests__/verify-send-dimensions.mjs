// Independent, dependency-free request-payload verification for #1343 / #1344.
// From the repository root, with Node >= 22.16:
// node --experimental-vm-modules --test MemoryCore/__tests__/verify-send-dimensions.mjs
// Real configuration, StorePool and remote embedding code; storage is stubbed.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const logger = { info() {}, warn() {}, error() {}, debug() {} };

for (const configured of [false, true, undefined]) {
  test(`StorePool HTTP payload: sendDimensions=${String(configured)}`, async () => {
    const requests = [];
    const dataDir = fs.mkdtempSync(path.join(tmpdir(), "tam-payload-"));
    const context = createContext({
      AbortController, Float32Array, setTimeout, clearTimeout,
      process: { env: {} },
      fetch: async (url, options) => {
        assert.equal(url, "https://embeddings.example.invalid/v1/embeddings");
        assert.equal(options.method, "POST");
        const body = JSON.parse(options.body);
        requests.push(body);
        // Simulate providers which reject an explicit dimensions parameter.
        if (configured === false && Object.hasOwn(body, "dimensions")) {
          return new Response(JSON.stringify({ error: "dimensions unsupported" }), {
            status: 422,
          });
        }
        return new Response(JSON.stringify({
          data: [{ index: 0, embedding: Array(1024).fill(0.03125) }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    const modules = new Map();
    function synthetic(id, exports) {
      const names = Object.keys(exports);
      const module = new SyntheticModule(names, function () {
        for (const name of names) this.setExport(name, exports[name]);
      }, { context, identifier: id });
      modules.set(id, module);
      return module;
    }
    const unsupported = () => { throw new Error("Unexpected non-SQLite backend"); };
    const stubs = {
      "./sqlite/memory-store.js": { VectorStore: class {
        async init() {}
        async close() {}
      } },
      "./tcvdb/memory-store.js": { TcvdbMemoryStore: unsupported },
      "./tcvdb/skill-store.js": { TcvdbSkillStore: unsupported },
      "./mongodb/memory-store.js": { MongoMemoryStore: unsupported },
      "./mongodb/skill-store.js": { MongoSkillStore: unsupported },
      "./mongodb/client-pool.js": { getSharedMongoClientPool: unsupported },
      "./bm25-local.js": { createBM25Encoder: () => undefined },
      "../report/kafka-metric-producer.js": { metricProducer: { initialize: unsupported } },
    };
    async function load(relativePath) {
      const filename = path.join(sourceRoot, relativePath);
      if (modules.has(filename)) return modules.get(filename);
      const module = new SourceTextModule(stripTypeScriptTypes(
        fs.readFileSync(filename, "utf8"), { mode: "transform" },
      ), { context, identifier: filename });
      modules.set(filename, module);
      await module.link(async (specifier) => {
        if (specifier === "node:path") {
          return modules.get(specifier) ?? synthetic(specifier, { default: path });
        }
        if (specifier === "node:fs") {
          return modules.get(specifier) ?? synthetic(specifier, {
            existsSync: fs.existsSync, mkdirSync: fs.mkdirSync,
          });
        }
        if (Object.hasOwn(stubs, specifier)) {
          return modules.get(specifier) ?? synthetic(specifier, stubs[specifier]);
        }
        if (specifier === "./embedding.js") return load("core/store/embedding.ts");
        throw new Error(`Unexpected import: ${specifier}`);
      });
      await module.evaluate();
      return module;
    }
    let pool;
    try {
      const { parseConfig } = (await load("config.ts")).namespace;
      const { StorePool } = (await load("core/store/store-pool.ts")).namespace;
      const embedding = {
        enabled: true, provider: "openai",
        baseUrl: "https://embeddings.example.invalid/v1",
        apiKey: "synthetic-not-a-real-key", model: "synthetic", dimensions: 1024,
      };
      if (configured !== undefined) embedding.sendDimensions = configured;
      const memoryCfg = parseConfig({ embedding, bm25: { enabled: false } });
      pool = new StorePool({ mode: "sqlite", memoryCfg, dataDir, logger,
        kafka: { enabled: false } });
      const { embedding: service } = await pool.getStore("synthetic", null);
      const result = await service.embed("Synthetic embedding request verification.");
      assert.equal(result.length, 1024);
      assert.ok([...result].every(Number.isFinite));
      assert.equal(requests.length, 1);
      assert.equal(requests[0].model, "synthetic");
      assert.equal(Object.hasOwn(requests[0], "dimensions"), configured !== false);
      if (configured !== false) assert.equal(requests[0].dimensions, 1024);
    } finally {
      if (pool) {
        pool.setGraceCloseDelay(0);
        await pool.closeAll();
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
}
