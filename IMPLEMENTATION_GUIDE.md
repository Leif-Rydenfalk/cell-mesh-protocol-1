# Client Mode Implementation Guide

## Changes Required to Existing Files

### 1. `protocols/example1.ts`

#### Add after imports:
```typescript
export type TransportMode = 'server' | 'client';
```

#### Add to RheoCell class properties (after `public server: any;`):
```typescript
public mode: TransportMode = 'server';
```

#### Add new method to RheoCell class:
```typescript
/**
 * Connect to mesh in client mode (no server, HTTP client only)
 * For browser environments or cells that only need to call others
 */
public async connect(seedAddr?: string): Promise<void> {
    this.mode = 'client';
    this._addr = `client://${this.id}`; // Virtual address for client cells

    if (seedAddr) {
        this.seed = seedAddr;
    }

    // Bootstrap from registry to find peers
    await this.bootstrapFromRegistry(true);

    // If we have a seed, try to connect directly
    if (this.seed && Object.keys(this.atlas).length === 0) {
        try {
            const response = await fetch(`${this.seed}/atlas`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ requester: this.id })
            });
            if (response.ok) {
                const { atlas } = await response.json();
                this.mergeAtlas(atlas, false, 0);
            }
        } catch (e) {
            this.log("WARN", "Could not connect to seed, will retry via gossip");
        }
    }

    // Register ourselves (even as client) so others know we exist
    this.registerToRegistry();

    // Start heartbeat
    const heartbeat = setInterval(() => this.registerToRegistry(), 5000);
    this.activeIntervals.push(heartbeat);

    this.log("INFO", `Client cell connected @ ${this._addr}`);
}
```

#### Modify `route()` method - replace the "NOT_READY" check:

**Old:**
```typescript
if (!this.addr && this.handlers[cap]) {
    return { ok: false, cid, error: { code: "NOT_READY", msg: "Cell has no address - cannot handle local capabilities", from: myId, trace: [] } };
}
```

**New:**
```typescript
if (!this.addr && this.mode === 'server' && this.handlers[cap]) {
    return { ok: false, cid, error: { code: "NOT_READY", msg: "Cell has no address - cannot handle local capabilities", from: myId, trace: [] } };
}
```

#### Modify `forwardToPeer()` method - update provider filtering:

**Find this section** (around line where `providers` is defined):
```typescript
const providers = Object.entries(this.atlas)
    .filter(([key, e]) => {
        const entryId = e.id || key;
        const hasCap = e.caps.includes(cap);
        const isSelf = entryId === myId || e.addr === myAddr;
        const isVisited = visitedIds.includes(entryId);
        const isDuplicateAddr = seenAddrs.has(e.addr);
```

**Add after `isDuplicateAddr`:**
```typescript
        const isClientOnly = e.addr.startsWith('client://'); // Skip client cells for routing
```

**Update the return condition:**
```typescript
        if (hasCap && !isSelf && !isVisited && !isDuplicateAddr && !isClientOnly) {
```

#### Modify `completeListenSetup()` method - update announce filtering:

**Find the `announce` function inside `completeListenSetup()`:**
```typescript
const targets = Object.values(this.atlas)
    .filter(e => e.addr !== this._addr)
```

**Change to:**
```typescript
const targets = Object.values(this.atlas)
    .filter(e => 
        e.addr !== this._addr && 
        !e.addr.startsWith('client://') // Don't announce to clients
    )
```

**Also update the gossip function in the same method:**
```typescript
const peers = Object.values(this.atlas)
    .filter(e => e.addr !== this._addr && !e.addr.startsWith('client://'))
```

---

### 2. NEW FILE: `ui/src/lib/browser-mesh-client.ts`

Create this entire file (already provided above in the implementation).

---

### 3. REPLACE: `ui/src/hooks.server.ts`

Replace the entire file with the new version (already provided above).

---

### 4. REPLACE: `ui/src/routes/+page.svelte`

Replace the entire file with the new version (already provided above).

---

### 5. REPLACE: `ui/src/routes/debug/+page.svelte`

Replace the entire file with the new version (already provided above).

---

### 6. DELETE: Old Runtime Files

Delete these files as they're no longer needed:
- `ui/src/lib/typed-mesh-runtime.ts` ❌
- `ui/src/lib/mesh.ts` ❌
- `ui/src/lib/generated-mesh-types.ts` ❌ (if exists)

---

## Testing Checklist

After making changes:

1. ✅ Orchestrator starts without errors
2. ✅ Cells converge (check orchestrator logs)
3. ✅ SvelteKit dev server starts: `cd ui && bun run dev`
4. ✅ Navigate to http://localhost:5173
5. ✅ Browser console shows: `[BrowserCell] Connected with N peers`
6. ✅ Main page loads checklist data
7. ✅ Debug page shows:
   - Browser Cell in "client" mode
   - Server Cell in "server" mode
   - Both cells in same atlas
8. ✅ Can add tasks, complete them, get summaries
9. ✅ No TypeScript errors in IDE

---

## Quick Test Command

```bash
# Terminal 1: Start mesh
cd orchestrator
bun run index.ts start

# Terminal 2: Start UI
cd ui
bun run dev

# Browser: http://localhost:5173/debug
```

Expected output in browser console:
```
[BrowserCell] Connected with 5 peers
[UI] Mesh status: { cellId: "SvelteKit_Server_12345", mode: "server", ... }
```

---

## Rollback Plan

If anything breaks:

1. Revert `protocols/example1.ts` changes
2. Restore old `hooks.server.ts` and `+page.svelte`
3. Restore deleted files from git
4. Restart mesh

All changes are backwards compatible - server mode cells work exactly as before.