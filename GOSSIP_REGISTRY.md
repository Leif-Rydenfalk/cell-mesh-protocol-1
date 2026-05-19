# Gossip Registry

Replaces `~/.rheo/registry/*.json` with an in-memory SWIM-inspired gossip state machine. The mesh now works across machines, dead cells no longer poison the membership view, and no hardcoded seed is required to join.

---

## Why the file registry was replaced

The old design wrote one JSON file per cell under `~/.rheo/registry/`. Every cell polled those files and watched the directory with `fs.watch`. This worked on a single machine but had several failure modes:

- **Stale ghost entries.** A cell that crashed left its file behind. Other cells would attempt to route to it until the file's `lastSeen` timestamp aged out — with no active mechanism to expire it faster.
- **Localhost-only.** `fs.watch` on a shared directory only works if all cells share a filesystem. Cross-machine meshes required a different solution.
- **No failure detection.** Cells did not actively probe each other; they only checked file timestamps.
- **Hardcoded seed crutch.** A cell joining a cross-machine cluster needed a known seed address to be configured explicitly in the source or environment.

---

## New design

### gossip.ts

Three self-contained exports:

#### `GossipRegistry`

SWIM (Scalable Weakly-consistent Infection-style Membership) state machine. Each cell runs one instance.

**Failure detection pipeline:**

```
Every 1500ms:
  1. Pick a random live peer.
  2. POST /gossip/ping  (direct probe, 600ms timeout).
     → If ack: refresh lastSeen, clear suspect state.
     → If no ack: send /gossip/probe to 2 random helpers (indirect probe).
        → If any helper acks: cell is alive.
        → If no ack from any helper: mark SUSPECT.

SUSPECT state:
  - Gossip the suspicion to 3 random peers.
  - After 8 seconds without refutation: mark DEAD.
  - Gossip the death to 3 random peers.
  - Remove from state after 2-minute TTL.

Refutation (self-healing):
  - If any cell learns it has been marked SUSPECT or DEAD,
    it increments its incarnation number and re-announces ALIVE.
  - Higher incarnation always wins, regardless of timestamps.
  - This prevents a slow or partitioned cell from being permanently evicted.
```

**Anti-entropy (convergence across partitions):**

```
Every 30 seconds:
  Pick a random live peer.
  POST /gossip/pull → receive their full state.
  Merge: higher incarnation wins; tie-break on version (timestamp).
```

This guarantees that even after a network partition heals, all cells converge to the same membership view without manual intervention.

**Key methods:**

| Method | Purpose |
|--------|---------|
| `gossip.join(addrs)` | Pull state from the first reachable address. One round-trip is enough to bootstrap. |
| `gossip.announce(record)` | Register / refresh our own entry (called every 5s heartbeat). |
| `gossip.announceOffline(record)` | Declare ourselves dead on graceful shutdown; gossips the departure immediately. |
| `gossip.subscribe(cb)` | Receive `joined`, `updated`, `suspect`, `dead` events. Used by `RheoCell` to sync the atlas. |
| `gossip.liveAtlas()` | All non-dead records as a plain object, compatible with `AtlasEntry`. |
| `gossip.snapshot()` | Full state for anti-entropy pull responses. |
| `gossip.start(send)` | Start the SWIM probe and sync loops. |
| `gossip.stop()` | Clean shutdown — clears all intervals and suspect timers. |

#### `ConsistentHashRing`

150 virtual nodes per real node on a sorted ring. Used to assign shard responsibility to cells — when a cell dies, the next clockwise node inherits its range.

```typescript
ring.add("trading-cell");
ring.add("ai-cell");
ring.owners("some-key", 2); // ["trading-cell", "ai-cell"]
ring.remove("trading-cell"); // ai-cell now owns the full ring
```

#### `jumpHash(key, buckets)`

O(log n) consistent hash (Karger et al., 2014). Maps a string key to a bucket index with minimal remapping when the bucket count changes.

```typescript
jumpHash("trading-cell", 5); // → deterministic bucket 0..4
```

---

## HTTP endpoints

Four new endpoints are added to every cell's HTTP server:

| Endpoint | Purpose |
|----------|---------|
| `POST /gossip/ping` | SWIM direct liveness probe. Returns `{ ok: true, id: string }`. |
| `POST /gossip/pull` | Anti-entropy: return full membership snapshot. Body: `{ from: string }`. |
| `POST /gossip/push` | Receive pushed state; return our state (push-pull). Body: `{ state: GossipSnapshot }`. |
| `POST /gossip/probe` | Indirect probe: we probe `target` and report back. Body: `{ target: string }`. |

The existing `/atlas` and `/announce` endpoints are unchanged — signal-piggybacked atlas gossip continues to work alongside the SWIM membership layer.

---

## Bootstrap: joining without a hardcoded seed

On startup, bootstrap address priority is:

1. **`RHEO_BOOTSTRAP_PEERS`** environment variable — comma-separated addresses.  
   ```bash
   RHEO_BOOTSTRAP_PEERS=http://10.0.1.2:3000,http://10.0.1.3:3001 bun run index.ts
   ```
2. **`~/.rheo/registry/peers.json`** — written by previous sessions (just addresses, not state). Survives restarts; gives a fresh cell somewhere to start.
3. **`seed` constructor argument** — `new RheoCell("my-cell", 0, "http://known-peer:3000")`.

Only one live address is needed. The cell pulls the full mesh state in a single `/gossip/pull` round-trip and is immediately aware of all other members.

If no address is reachable, the cell starts in isolation and waits for others to discover it (via peer's SWIM probes or signal-piggybacked atlas).

---

## What the disk now stores

| Path | Contents | Role |
|------|----------|------|
| `~/.rheo/registry/peers.json` | `{ addrs: string[], updated: number }` | Cold-start bootstrap hint. Written on each heartbeat if live peers exist. Not authoritative. |
| `~/.rheo/identities/{id}.json` | Ed25519 key pair | Permanent cell identity. Unchanged. |
| `.rheo/manifests/{id}.cell.json` | Port, PID, version | Local singleton check. Unchanged. |

The old `~/.rheo/registry/{id}.json` per-cell files are no longer written or read.

---

## Integration in `core.ts`

| Old code | New code |
|----------|---------|
| `registerToRegistry()` writes `{id}.json` | `gossip.announce(record)` + writes `peers.json` hint |
| `markOfflineInRegistry()` writes offline `{id}.json` | `gossip.announceOffline(record)` — gossips departure to peers |
| `bootstrapFromRegistry()` reads `*.json`, pings each | `gossip.join(addrs)` — one pull from first live peer |
| `RegistryWatcher` (`fs.watch` on registry dir) | No-op stub; gossip push/pull replaces filesystem pubsub |
| `findCellById()` reads `{id}.json` | checks `gossip.liveAtlas()`, then atlas |
| `localCensus()` scans all `*.json` files | iterates `gossip.liveAtlas()` |

`RheoCell` gains two public fields:

```typescript
cell.gossip  // GossipRegistry — subscribe to membership events
cell.ring    // ConsistentHashRing — query shard ownership
```

Gossip membership events are wired into the atlas automatically:

```typescript
this.gossip.subscribe((id, record, event) => {
    if (event === 'dead') atlas[id].status = 'offline';
    else mergeAtlas({ [id]: record });
    if (event === 'joined') ring.add(id);
    if (event === 'dead')   ring.remove(id);
});
```

---

## SWIM parameters

All tunable via static properties before calling `gossip.start()`:

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `PROBE_INTERVAL_MS` | 1500ms | How often to probe a random peer |
| `PROBE_TIMEOUT_MS` | 600ms | Timeout for a direct probe |
| `INDIRECT_K` | 2 | Number of helpers for indirect probes |
| `SUSPECT_TIMEOUT_MS` | 8000ms | How long to wait for refutation before declaring dead |
| `DEAD_TTL_MS` | 120000ms | How long to keep a dead entry before discarding |
| `SYNC_INTERVAL_MS` | 30000ms | Anti-entropy sync interval |
| `PUSH_FANOUT` | 3 | How many peers to gossip state changes to |

For a small local mesh (< 10 cells), the defaults converge in under 10 seconds. For a large distributed mesh, increase `PROBE_INTERVAL_MS` and `SYNC_INTERVAL_MS` to reduce network overhead.
