# Cell Dependencies & Self-Healing Discovery

Status: **DRAFT** — protocol addition for cell-mesh-protocol-1. Not yet implemented in `core.ts`.

## What this adds

A cell declares the other cells it needs, by **source repo**. The mesh resolves each declaration at startup:

1. Ask gossip whether a matching live instance already exists.
2. If yes, use it.
3. If no, ask a spawner cell to clone the repo and bring one up.
4. New instance announces itself via gossip; original cell finishes resolving.

Both the **repo registry** (which cells exist in the world) and the **instance registry** (which cells are alive right now) become emergent properties of gossip — no central authoritative service is required for either.

## Scope: one mesh = one workspace

This draft assumes a single-tenant mesh: every running cell belongs to the same operator, and *sharing is the default*. If two cells declare the same dep, they get the same live instance. This matches today's deployment model where a mesh is the backend for one developer, one team, or one company.

Multi-tenant scoping (workspaces, auth, per-customer isolation) is deliberately out of scope here. The protocol is designed so that scope can be added later without breaking existing cells — see [Future work](#future-work).

## Why source repos, not capabilities

The mesh already has capability-level discovery (`askMesh("db.query", ...)` finds *anyone* who exposes `db.query`). That's the right primitive for *talking* to a cell. It is the **wrong** primitive for *ensuring one exists*, because:

- Capabilities are anonymous — two cells exporting `db.query` may have wildly different schemas, versions, or guarantees.
- A capability ask only succeeds if a producer is already running. There is no place to say "if nobody is running this, *start* one."
- "Start one" requires knowing *what code to run*. The source repo is the only canonical identifier for that.

So: capabilities answer "who can do X right now?"; repo dependencies answer "what should be running for me to work?".

## Manifest schema (`Cell.toml`)

```toml
id          = "my-cell"
command     = "bun install && bun run index.ts"
critical    = false
scalable    = false

[meta]
repo        = "github:Leif-Rydenfalk/cell-mesh-protocol-1-my-cell"
version     = "1.0.0"           # semver of THIS cell's release
description = "Does the thing"  # optional, surfaced in catalog UIs

[[dependencies]]
ref      = "github:Leif-Rydenfalk/cell-mesh-protocol-1-supabase-cell"
version  = "^1.0.0"   # optional; defaults to "*" (any)
alias    = "db"       # optional; how this dep is referenced internally
optional = false      # default false; if true, cell starts even if unresolved

[[dependencies]]
ref = "github:Leif-Rydenfalk/cell-mesh-protocol-1-log-cell"
```

### Field rules

| Field | Required | Notes |
|-------|----------|-------|
| `meta.repo` | yes if other cells will depend on this one | Without it the cell is treated as a leaf — it can still depend on others, but no one can depend on it. |
| `meta.version` | yes if `meta.repo` is set | Semver. Defaults to `0.0.0` if absent. |
| `dependencies[].ref` | yes | One of: `github:OWNER/REPO`, `github:OWNER/REPO#REF` (branch/tag/sha), or `local:/abs/path` (dev-only, never gossiped). |
| `dependencies[].version` | no | Semver range. Default `*`. |
| `dependencies[].alias` | no | Default is the last path segment of `ref`, slugified. Must be unique within the manifest. |
| `dependencies[].optional` | no | Default `false`. Optional deps never block startup. |

### Why GitHub-only refs

`openjaws` is local-dev only (see project `CLAUDE.md`). Servers must clone from a cell's standalone repo. A `local:` ref is permitted for active development but **must not** be advertised through gossip — it cannot be resolved by any node that isn't on that filesystem. The resolver enforces this: a `local:` dep on a non-dev node fails fast with a clear message.

## Gossip extensions

The existing `AtlasEntry` (see `core.ts`) gains two optional fields:

```typescript
export interface AtlasEntry {
  // ...existing fields unchanged...
  repo?: string;          // canonical "github:OWNER/REPO" from Cell.toml meta.repo
  repoVersion?: string;   // from Cell.toml meta.version
}
```

> The field is named `repoVersion` (not `version`) because the underlying
> `GossipRecord` already uses `version` for its internal monotonic-timestamp
> clock. The dependency spec's `meta.version` is a semver string about the
> cell's source release; the gossip `version` is an integer about message
> freshness. They are unrelated.

These are populated when a cell calls `gossip.announce(record)` at startup and on every heartbeat. They are propagated by anti-entropy and SWIM gossip with no new endpoints required — existing gossip mechanisms already replicate arbitrary `AtlasEntry` fields.

> **Reserved for future use:** a `tenant?: string` field on `AtlasEntry` is the planned hook for workspace scoping (see [Future work](#future-work)). Do not add it yet — landing it early invites half-implemented uses to leak in. Add when the workspace system is actually being built.

## Sharing policy

**Default behavior:** if any live instance whose `repo` matches the dep's ref (and whose `version` satisfies the range) exists in gossip, dependents use it. Otherwise a new one is spawned.

That's it. No flags. Two consumers of `cell-mesh-protocol-1-log-cell` get the same log cell. If you don't want that today, fork into two distinct repos. (Workspace-level isolation is the long-term fix and is tracked in [Future work](#future-work).)

### Note on stateful cells

A cell that holds private state (a database, a per-user cache) is still safe under share-by-default *within a single mesh* because, by definition, the mesh has one operator. There is no other "user" to leak to. When workspaces land, stateful cells will gain isolation automatically because gossip will be partitioned by workspace.

### Version splits

If cell A depends on `^1.0.0` of B and cell C depends on `^2.0.0` of B, the mesh ends up running two B instances side by side (one per matching gossip record). This is correct: the version constraint *is* the isolation. Operators who want a single-version mesh should align their consumers' constraints.

## Resolution algorithm

Runs once at cell startup, after gossip has had at least one successful `join()` round (or after a 2s grace if joining in isolation).

```
For each dep in manifest.dependencies:
    1. If ref starts with "local:":
         require RHEO_DEV_MODE=1; load from path; skip mesh resolution.

    2. Search gossip.liveAtlas() for entries where:
         entry.repo === dep.ref.repoPart
         AND satisfies(entry.repoVersion, dep.version)

       If one or more found: pick lowest-id (deterministic), record as resolved.

    3. Otherwise (no match):
         emit SpawnRequest { ref, version, requestedBy: self.id }
         await resolution with maxWaitMs (default 60s):
             - subscribe to gossip 'joined' events
             - any new entry matching the spec resolves the await
             - on timeout, fail unless dep.optional === true

    4. Resolved deps are exposed at cell.deps[alias] = { id, addr, version }
       and may be used via cell.askMesh / cell.mesh proxies as normal.
```

The algorithm is idempotent: re-running it (e.g. after a dep dies and is rescheduled) yields the same answer. Cells observe gossip `dead` events for their resolved deps and re-resolve transparently — this is the self-healing property.

## SpawnRequest protocol

A new signal kind, propagated by the existing gossip layer (no new endpoints).

```typescript
export interface SpawnRequest {
  kind: "spawn-request";
  ref: string;             // "github:OWNER/REPO[#REF]"
  version?: string;        // semver range; default "*"
  requestedBy: string;     // cell id of requester
  cid: string;             // correlation id; matched in spawn-fulfilled
  expiresAt: number;       // unix ms; spawners ignore expired requests
}

export interface SpawnFulfilled {
  kind: "spawn-fulfilled";
  cid: string;             // matches SpawnRequest.cid
  spawnerId: string;
  spawnedId: string;       // id of the newly started cell
  spawnedAddr: string;
}

export interface SpawnRejected {
  kind: "spawn-rejected";
  cid: string;
  spawnerId: string;
  reason: "no-capacity" | "ref-unreachable" | "policy-denied" | string;
}
```

### Spawner cells

A cell that wishes to fulfill spawn requests advertises a special capability `mesh.spawn` (versioned). Multiple spawners can coexist; they coordinate via a **claim** step to avoid duplicate work:

```
Spawner receives SpawnRequest:
  1. Check own policy (allowlist of orgs, free disk, concurrent-spawn limit, etc).
  2. Emit SpawnClaim { cid, spawnerId, at: now } via gossip.
  3. Wait 200ms ± jitter.
  4. Read all SpawnClaims with same cid. Lowest spawnerId wins.
  5. If we won: clone ref, run, watch for child registration, emit SpawnFulfilled.
     If we lost: drop.
```

The 200ms claim window is tunable via `SPAWN_CLAIM_WINDOW_MS`. It trades a small startup latency for at-most-one-spawner semantics without requiring distributed locking.

### Spawner implementation notes (informative)

A spawner cell is *not* part of the protocol — it's any cell that exposes `mesh.spawn`. The reference implementation (recommended layout, optional):

- Clones to `~/.rheo/spawns/{owner}-{repo}-{ref}/`.
- Runs `bun install && bun run index.ts` (or `command` from Cell.toml in the cloned repo).
- Sets `RHEO_BOOTSTRAP_PEERS` so the child joins gossip immediately.
- Considers the spawn fulfilled when gossip receives a `joined` event for a cell whose `repo` matches the request.
- Garbage-collects spawn directories after the spawned cell has been gone from gossip for >24h.

This logic likely belongs in a new `cell-spawner` cell (sibling to `cell-starter`, `genesis-igniter-cell`), not in `core.ts`.

## Derived: the repo registry is gossip

The set of "all cells that exist" is just:

```typescript
const knownRepos = new Set<string>();
for (const entry of Object.values(cell.gossip.liveAtlas())) {
  if (entry.repo) knownRepos.add(entry.repo);
}
```

This makes the existing **`registry-cell`** redundant for live state — `gossip.liveAtlas()` is authoritative. `registry-cell` should be considered deprecated once dependency resolution is wired in.

The **`github-registry` cell** retains a distinct purpose: it discovers cells that exist as source code in a GitHub org but are not currently running anywhere — i.e., the *cold* catalog. Dependency resolution does not need it (it operates only on refs the consumer named explicitly), but UIs and spawners may use it.

## Failure modes

| Scenario | Behavior |
|----------|----------|
| Dep gossip-matched, then dep dies | Cell receives gossip `dead` event for the resolved id. Death hooks fire. Unless the cell sets `autoReresolveDeps = false` (or `RHEO_AUTO_RERESOLVE=false`), the resolver automatically re-resolves the single dep — atlas first, then a fresh `mesh.spawn` request. The cell's `cell.deps[alias]` is temporarily absent during this window; consumers should re-check before each use rather than caching the addr. |
| SpawnRequest times out (no spawner alive) | `optional` dep: cell starts without it. Required dep: cell logs fatal and exits. |
| Two spawners both clone | Claim window deduplicates; loser drops. Worst case: one wasted clone, no duplicate live cell. |
| `local:` ref reached a remote node | Resolver fails fast with an error directing the operator to publish a real repo. |
| Cyclic dependency (A depends on B, B depends on A) | Both cells wait for each other; both time out. Recommend documenting that cycles are unsupported. A future addition could detect cycles via gossip and either break the wait or start both speculatively. |
| Version range matches nothing in gossip but a spawnable repo exists | SpawnRequest is emitted with the version constraint; spawner clones the appropriate tag/ref. |

## Configuration

New environment variables:

| Var | Default | Purpose |
|-----|---------|---------|
| `RHEO_DEV_MODE` | unset | Required to use `local:` refs. |
| `RHEO_DEP_RESOLVE_MS` | `60000` | Max wait for dependency resolution before failing. |
| `RHEO_AUTO_RERESOLVE` | `true` | Set to `false` (or `0`) to disable auto re-resolution when a dep dies. The death hook still fires; recovery is then the cell's responsibility. |
| `SPAWN_CLAIM_WINDOW_MS` | `200` | Claim coordination window for spawners. |

## What changes in `core.ts`

(Outline — implementation is a separate task.)

1. Extend `AtlasEntry` with `repo`, `version`.
2. Add `CellSourceManifest` interface for parsed `Cell.toml` (distinct from runtime `CellManifest`).
3. Add `cell.deps: Record<string, ResolvedDependency>` populated at startup.
4. Add `cell.resolveDependencies()` private method, invoked from `listen()` after gossip join.
5. Add `cell.onDependencyDeath(alias, callback)` hook for cells that want explicit notification.
6. Re-export new types and the `cell.deps` accessor.

No existing public API breaks. Cells that do not declare `[[dependencies]]` see no behavior change.

## What changes outside `core.ts`

- `dependencies.ts` (new) — types and the (pure) resolution function. Tested in isolation.
- `cell-spawner-cell` (new sibling cell, separate repo) — exposes `mesh.spawn`, listens for `SpawnRequest`.
- `registry-cell` — marked deprecated in its README; left running for back-compat for one release cycle.

## Future work

Tracked here so future agents understand the deferred-by-design pieces:

- **Workspace / multi-tenant scoping.** Add a `tenant?` (or `workspace?`) field to `AtlasEntry`, populated from a cell's auth context. Resolution then filters by tenant match. The single-tenant share-by-default model continues to work — it becomes "share-within-workspace by default." Cells already deployed do not need changes; missing-tenant means "global / development mode."
- **Per-cell-type federation.** Some cells (e.g. log cells, time-series cells, search indexers) will benefit from running one *per host* and syncing peer-to-peer rather than designating a single mesh-wide instance. That pattern is implemented *inside* such cells — the dep resolver just hands the consumer any one instance, and the cell's federation logic handles the rest. No protocol change needed.
- **Version-pinning override.** Operator command (or a `mesh.policy` cell) that forces all consumers of a given repo onto a single version, suppressing the side-by-side-versions behavior described above.
- **Persistent dep cache.** Survive cell restarts with a `~/.rheo/deps/{cell-id}.json` cache to shave seconds off startup. Skipped initially; re-resolve every time.

## Open questions for review

1. **Spawner authority.** Should any cell be allowed to be a spawner, or should there be an allowlist (via signed manifest)? Current draft: any cell that advertises `mesh.spawn`. Mitigation: spawner-side policy rejects unknown orgs.
2. **Resolver topology.** Each cell resolves its own deps (distributed, symmetric with gossip). Alternative: one mesh-wide reconciler watches the atlas and starts missing cells. Simpler invariants, single point of failure. Current draft is distributed.
