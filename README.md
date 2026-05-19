# cell-mesh-protocol-1

The reference implementation of the Cell Mesh Protocol. This package provides everything needed to build a cell: process lifecycle, capability routing, type-safe RPC, peer discovery, and gossip-based atlas synchronization.

Language support: **TypeScript** (primary), **Rust** (high-performance cells).

---

## What This Package Provides

| Export | Purpose |
|--------|---------|
| `RheoCell` | Low-level cell base class. Direct capability registration, full control. |
| `TypedRheoCell` | High-level cell. Uses a `router` for automatic type safety. |
| `router` | Groups procedures into namespaced capability trees. |
| `procedure` | Defines a single typed capability with input/output schemas. |
| `z` | Built-in schema validator (Zod-compatible API). No extra dependency. |
| `InferInput<T>` | Extract input type from a procedure at compile time. |
| `InferOutput<T>` | Extract output type from a procedure at compile time. |
| `InferRouter<T>` | Convert a router definition into its client-callable interface. |
| `createMeshClient` | Create a typed client to call a known router from outside the mesh. |

---

## Core Concepts

### Signal

Every mesh call is a `Signal` — a self-describing envelope that carries:
- `intent`: `"ASK"` (expects a reply) or `"TELL"` (fire and forget)
- `payload.capability`: the target capability path, e.g. `"trading/place-order"`
- `payload.args`: the call arguments
- `atlas`: a snapshot of the caller's known mesh topology, shared with each hop
- `trace`: the routing path taken so far
- `proofs`: cryptographic signatures for vouch verification

Signals are forwarded hop-by-hop through the mesh. Each cell that handles a signal updates the trace and merges atlas entries. This gossip-as-a-side-effect design means the atlas self-heals — cells learn about new peers simply by handling requests.

### Atlas

The atlas is the mesh's view of itself. Each cell maintains a local atlas: a map from cell ID to `AtlasEntry`, which records:
- The cell's address (`http://host:port` or `client://id`)
- Its declared capabilities
- Its Ed25519 public key
- When it was last seen directly vs. via gossip
- Gossip hop count (for TTL)

The registry on disk (`~/.rheo/registry/`) is the persistent atlas. Cells write their manifest on startup and read peers' manifests to bootstrap. The in-memory atlas is updated continuously via gossip piggy-backed on every signal.

### Capabilities

A capability is a named operation a cell can perform. Capabilities are strings: `"cell/capability"` or nested `"cell/sub/capability"`. The `router` / `procedure` API generates these paths automatically from the structure you define.

Capabilities are declared at startup and written to the registry. Any cell in the mesh can call any capability it discovers in the atlas. No service registry to configure, no API gateway to update — publish the capability and it becomes available.

### Cell.toml

Every cell has a `Cell.toml` at its root that declares how to spawn it:

```toml
id = "my-cell"
command = "bun install && bun run index.ts"
critical = false
scalable = false

[env]
SOME_VAR = "value"
```

The orchestrator scans the mesh directory tree for these files and spawns each one. This is the entire deployment contract.

---

## TypeScript Quick Start

### Install

```bash
bun link cell-mesh-protocol-1   # from the cloned protocol repo
# or
bun add cell-mesh-protocol-1    # once published to npm
```

### Minimal Cell

```typescript
import { TypedRheoCell, router, procedure, z } from "cell-mesh-protocol-1";

const cell = new TypedRheoCell("my-cell", 0); // port 0 = auto-assign

const myRouter = router({
    myCell: router({
        // Queries: read-only, idempotent
        greet: procedure
            .input(z.object({ name: z.string() }))
            .output(z.object({ message: z.string() }))
            .query(async ({ name }) => ({ message: `Hello, ${name}!` })),

        // Mutations: write operations, side effects
        setName: procedure
            .input(z.object({ name: z.string() }))
            .output(z.object({ ok: z.boolean() }))
            .mutation(async ({ name }) => {
                // ... persist name
                return { ok: true };
            })
    })
});

cell.useRouter(myRouter);
await cell.listen();
```

### Calling Another Cell

```typescript
// From any other cell in the mesh
const result = await cell.mesh.myCell.greet({ name: "world" });
// TypeScript knows result.message is a string
```

### Client Mode (Browser / Edge / Script)

A client-mode cell participates in the mesh without running an HTTP server. Use this for browsers, CLI tools, and anything that only needs to call capabilities:

```typescript
const client = new TypedRheoCell(`Browser_${Date.now()}`, 0);
await client.connect("http://mesh-entry-point:port");

const result = await client.mesh.myCell.greet({ name: "browser" });
```

---

## Schema Reference (`z`)

The built-in `z` validator has a Zod-compatible API:

```typescript
z.string()                        // string
z.string().min(1).max(100)        // with length constraints
z.number()                        // number
z.boolean()                       // boolean
z.object({ key: z.string() })     // object with typed fields
z.array(z.string())               // array
z.enum(["a", "b", "c"])           // string enum
z.any()                           // untyped escape hatch
z.void()                          // no input / no output
z.optional(z.string())            // or z.string().optional()
z.string().default("value")       // with default value
z.union([z.string(), z.number()]) // union type
```

Use `z.any()` only when you genuinely can't type the value — prefer precise schemas everywhere.

---

## Rust Quick Start

For high-performance cells (trading, ML inference, data processing), use the Rust implementation:

```toml
# Cargo.toml
[dependencies]
cell-mesh-protocol-1 = { path = "../protocols/cell-mesh-protocol-1/rs" }
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
axum = "0.7"
```

```rust
use cell_mesh_protocol_1::RheoCell;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct GreetInput { name: String }

#[derive(Serialize, Deserialize)]
struct GreetOutput { message: String }

#[tokio::main]
async fn main() {
    let cell = RheoCell::new("my-cell-rs", 0).await.unwrap();

    cell.provide("myCell/greet", |args| async move {
        let input: GreetInput = serde_json::from_value(args)?;
        Ok(serde_json::to_value(GreetOutput {
            message: format!("Hello, {}!", input.name)
        })?)
    }).await;

    cell.listen().await.unwrap();
}
```

TypeScript and Rust cells are fully interoperable — a TypeScript cell calls a Rust cell's capability with the same typed API and vice versa. The protocol normalizes the wire format.

---

## Cell Lifecycle

```
Startup
  │
  ├─ Generate Ed25519 identity (or load from disk)
  ├─ Claim a port (PortRegistry, file-locked)
  ├─ Scan ~/.rheo/registry/ for existing peers
  ├─ Write own manifest to registry
  │
  ├─ Start HTTP server
  ├─ Announce to all known peers (gossip)
  │
  └─ Ready: handle signals, gossip atlas on every request

Running
  ├─ Signal arrives → route to local handler or forward to peer
  ├─ Atlas merges on every inbound signal (peers stay current)
  ├─ Heartbeat writes to registry every 5s
  └─ Gossip propagates new cells through the mesh

Shutdown
  ├─ Remove manifest from registry
  ├─ Announce departure to peers
  └─ Stop server
```

---

## Addressing

Cells use `CellAddress` — a typed address abstraction that supports:

| Protocol | Usage |
|----------|-------|
| `http://host:port` | Default: LAN or internet cells |
| `https://host:port` | TLS-terminated production cells |
| `ws://host:port` | WebSocket cells |
| `client://cell-id` | Client-mode cells (no server) |
| `unix://path:0` | Same-machine zero-copy (future) |

Set `RHEO_HOST` environment variable to bind to a network interface other than localhost:

```bash
RHEO_HOST=10.0.0.5 bun run index.ts
```

All cells on the node bind to that IP, and their registry entries reflect it. This is how you form a real multi-machine mesh.

---

## Error Handling

Mesh calls throw `MeshError` on failure. It carries the full routing trace, narrative history, and error chain:

```typescript
try {
    const result = await cell.mesh.trading.placeOrder({ symbol: "BTC", qty: 1 });
} catch (e) {
    if (e instanceof MeshError) {
        console.error(e.message);        // Human-readable with full trace
        console.error(e.failedAt);       // Which cell failed
        console.error(e.errorChain);     // Sequence of failures
    }
}
```

The `TraceResult` type (`{ ok: boolean; value?: T; error?: TraceError }`) is used at the lower `RheoCell` layer when you want to handle errors without exceptions.

---

## Code Standards

### Cell Naming

- Cell IDs: kebab-case (`trading-cell`, `supabase-cell`, `ai-ui`)
- Router namespaces: camelCase matching the cell ID (`tradingCell`, `supabaseCell`)
- Capability paths derive from the router: `router({ trading: router({ placeOrder: ... }) })` → `trading/placeOrder`

### Router Structure

Always nest capabilities under a namespace that matches the cell:

```typescript
// Correct — capability path is "trading/placeOrder"
const myRouter = router({
    trading: router({
        placeOrder: procedure...
    })
});

// Wrong — flat capabilities pollute the global namespace
const myRouter = router({
    placeOrder: procedure...
});
```

### Schema Strictness

- Never use `z.any()` for inputs — always define the full shape
- `z.any()` is acceptable for outputs when the shape is genuinely dynamic
- Use `.default()` for optional fields rather than making the entire field optional when there's a sensible default

### Queries vs Mutations

- `.query()` — safe to retry, no observable side effects
- `.mutation()` — has side effects, not safe to retry automatically

The distinction matters for future caching and retry infrastructure.

### TypedRheoCell vs RheoCell

Use `TypedRheoCell` everywhere in production. It enforces typed routers and gives IDE completions across cells. `RheoCell` is the base class — use it only when building protocol-level tooling or during initial prototyping.

### Cell Size

Cells should be 200–800 lines. When a cell grows past ~800 lines, consider whether it has taken on a second responsibility that should be its own cell.

### No Source Coupling

Cells never import each other's source files. The only inter-cell communication is through mesh capability calls. This is what makes cells independently deployable and replaceable.

### Testing

Each cell ships with a test script that calls its own capabilities end-to-end:

```typescript
// test.ts — runs against the live cell
const client = new TypedRheoCell(`Test_${Date.now()}`, 0);
await client.connect(`http://localhost:${PORT}`);

const result = await client.mesh.myCell.greet({ name: "test" });
console.assert(result.message === "Hello, test!");
console.log("✅ All tests passed");
```

This is not a unit test with mocks. It is a live integration test that proves the cell works as deployed. Because the cell is the deployment, testing the cell is testing production behavior.

---

## Pattern: Wrapping an Existing System

The most powerful use of cells is wrapping any existing system — database, API, CLI, subprocess — and giving it a type-safe mesh interface:

```typescript
// supabase-cell/index.ts — wraps the Supabase CLI
const supabaseRouter = router({
    supabase: router({
        start: procedure
            .input(z.object({ publicUrl: z.string() }))
            .output(z.object({ ok: z.boolean() }))
            .mutation(async ({ publicUrl }) => {
                execSync(`supabase start --public-url ${publicUrl}`);
                return { ok: true };
            }),

        sql: procedure
            .input(z.object({ query: z.string() }))
            .output(z.any())
            .mutation(async ({ query }) => {
                const result = execSync(`supabase db query '${query}'`);
                return JSON.parse(result.toString());
            })
    })
});
```

Now any cell in the mesh has a fully-typed Supabase client — no SDK to install, no config to share, no credentials to distribute. The supabase-cell manages its own secrets; callers just call capabilities.

---

## Protocol Internals

The protocol is intentionally transparent: signals carry the full atlas and trace as they flow through the mesh. Any cell can inspect what happened, who routed what, and where failures occurred.

Key internal behaviors:

- **Gossip is piggybacked on every signal** — no dedicated gossip protocol
- **Port allocation uses file locks** — prevents port conflicts when cells start concurrently
- **Registry is the filesystem** — `~/.rheo/registry/*.json`, no database required
- **Identity is Ed25519** — each cell generates a keypair on first boot, signs its atlas entries
- **Ghost busting** — stale manifest files (no heartbeat) are cleaned up automatically
- **Flood routing** — if a capability isn't found in the atlas, the signal is broadcast to all known peers

---

## Files

| File | Purpose |
|------|---------|
| `core.ts` | RheoCell, Signal, AtlasEntry, CellAddress, MeshError, registry |
| `router.ts` | Procedure, Router, z schema system, InferInput/Output |
| `typed-mesh.ts` | TypedRheoCell, MeshCapabilities registry, codegen types |
| `index.ts` | Re-exports everything |
| `browser-shim.ts` | Browser-compatible shim (no Node builtins) |
| `rs/src/lib.rs` | Rust implementation |

---

## Versioning

This is protocol version 1. Future protocol versions will be published as separate packages (`cell-mesh-protocol-2`, etc.). The mesh gateway translates between versions, so upgrading one cell does not require upgrading all cells.
