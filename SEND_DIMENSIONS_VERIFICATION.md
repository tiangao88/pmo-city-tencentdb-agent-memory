# Independent verification of upstream #1343 / #1344

Date: 2026-11-08. Runtime: Node.js v22.22.3.

- Upstream issue: https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/1343
- Existing fix and regression-test PR, by L4XB: https://github.com/TencentCloud/TencentDB-Agent-Memory/pull/1344
- Verified upstream base: `2002196f2d7c22ea267cfcaf67c5a6fa861df681` (`feat/server_team`).
- Verified fix: exactly the `sendDimensions: embCfg.sendDimensions` handoff proposed in PR #1344.

This branch is supporting evidence, **not a competing fix or duplicate upstream PR**.
The existing upstream PR already includes two Vitest factory-handoff regression tests.
The separate dependency-free test here additionally exercises the real configuration
parser, SQLite StorePool path and remote embedding request serialization together.
Only storage, BM25 and unrelated backend dependencies are stubbed.

## Reproduce

From the repository root, using Node >= 22.16:

```sh
node --experimental-vm-modules --test MemoryCore/__tests__/verify-send-dimensions.mjs
```

The Node TypeScript stripping and VM APIs are experimental and emit warnings.
No package installation, Docker, credentials, database or paid inference is needed.
The fetch function is replaced in an isolated VM context; it validates a synthetic
`.invalid` URL and returns local responses. The context receives an empty environment,
and its temporary directories are removed after each case.

| Configured value | Expected request body | Unfixed base | With PR #1344's one-line fix |
| --- | --- | --- | --- |
| `false` | no `dimensions` field | FAIL: simulated HTTP 422 | PASS |
| `true` | `dimensions: 1024` | PASS | PASS |
| omitted | `dimensions: 1024` (default preserved) | PASS | PASS |

Red commit: `d79839d` (test only, before the fix). Green results: 3 passed, 0 failed.

This verification does **not** cover native SQLite writes, real provider availability,
other backends, full project builds, or the complete test suite. It does not repair
records whose embeddings previously failed; historical vector coverage remains a
separate operational concern. No application deployment was changed by this work.
