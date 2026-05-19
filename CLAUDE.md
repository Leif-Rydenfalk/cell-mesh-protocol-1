# cell-mesh-protocol-1 — Agent Guide

This is the core runtime library for the OpenJaws cell mesh. Every cell imports `TypedRheoCell` from here. Read this before making any modifications.

## Verifying your changes

**Always run the mesh test suite after modifying this protocol.**

```bash
# With the mesh running (or at least registry + log cells):
cd mesh1/mesh-test
bun install
bun run index.ts
```

Check `mesh1/mesh-test/test-results/latest.log`. The `STATUS` line at the bottom must read `OK`. Any `[FAIL]` line is a regression you need to fix before committing.

Full test documentation: [`mesh1/mesh-test/TESTS.md`](../../mesh1/mesh-test/TESTS.md)

| Change area | Tests to focus on |
|-------------|------------------|
| `askMesh` / routing | T01, T02, T05 |
| Zod / input validation | T03 |
| Atlas / registration / gossip | T04, T07 |
| `handleShutdown` | T09, T10 |
| Error handling | T06 |
| Cross-cell communication | T07, T08 |

## Key classes

- **`RheoCell`** (`core.ts`) — base cell. Handles routing, gossip, atlas, shutdown.
- **`TypedRheoCell`** (`typed-mesh.ts`) — extends `RheoCell` with a typed mesh proxy (`cell.mesh.X.Y()`).
- **`router` / `procedure` / `z`** (`router.ts`) — Zod-backed schema definition for capabilities.

## Entry points

```
core.ts        — RheoCell class, Signal routing, handleShutdown, askMesh, atlas
typed-mesh.ts  — TypedRheoCell, createMeshProxy (cell.mesh.X.Y() ergonomics)
router.ts      — router(), procedure(), z — schema and procedure definitions
index.ts       — re-exports everything
```

## Shutdown flow

Understanding this is critical before touching `handleShutdown`:

1. SIGINT/SIGTERM fires → `handleShutdown()` is called
2. `shutdownPhase = 'draining'` — new incoming signals are rejected immediately
3. `activeIntervals` cleared — stops all protocol-internal timers
4. Phase 1: all `activeControllers` aborted — kills in-flight outbound RPC fetches
5. **`capabilityWaiters` flushed** — pending `askMesh` discovery-waits resolve immediately instead of waiting up to `maxWaitMs` (default 30s). **Do not remove this step.**
6. `cleanupHooks` run — cell-registered `onShutdown()` callbacks
7. Phase 2: drain `activeExecutions` — waits for in-flight incoming handler promises (10m ceiling)
8. Phase 3: server stopped
9. Phase 4: gossip stopped, cleanup
10. `process.exit(0)` — **must remain here**. Without it, cells with unmanaged handles (Bun.serve, setInterval) never exit.

## Cell lifecycle APIs

Cells that use `setInterval` or run their own servers **must** register them:

```typescript
// Register a setInterval so it's cleared on shutdown
cell.registerInterval(setInterval(myFn, 60000));

// Register cleanup (e.g. stop an external Bun.serve)
cell.onShutdown(() => myServer.stop());
```

If a cell omits these, its process will stay alive after extinguish (the process says "💀 Cell extinguished" but never exits). This was the root cause of the dashboard hanging post-shutdown.

## Capability routing rules

- `askMesh(cap, args, {}, { maxWaitMs: 0 })` — fail immediately if cap not found (use for background pollers)
- `askMesh(cap, args)` — default 30s wait for cap to appear (use for startup dependencies)
- The typed mesh proxy (`cell.mesh.X.Y()`) always uses the 30s default — do not use it for background polling

## Common pitfalls

- **Do not remove `process.exit(0)`** from the SIGINT/SIGTERM handlers. Without it, unmanaged handles keep the process alive after extinguish.
- **Do not remove the `capabilityWaiters` flush** from `handleShutdown()`. Without it, any in-flight `askMesh` discovery-wait blocks the shutdown drain for up to 30s per call.
- **Do not make `shutdownPhase` or `isShuttingDown` public** — cells should use `onShutdown()` for cleanup, not inspect internal state.
