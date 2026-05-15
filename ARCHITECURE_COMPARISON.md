# Architecture Comparison: Old vs New

## OLD ARCHITECTURE ❌

```
┌─────────────────────────────────────────────────────────┐
│                   MESH NETWORK                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │Checklist │  │   Log    │  │    AI    │             │
│  │  (Real   │  │  (Real   │  │  (Real   │             │
│  │   Cell)  │  │   Cell)  │  │   Cell)  │             │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘             │
│       │             │              │                    │
└───────┼─────────────┼──────────────┼────────────────────┘
        │             │              │
        └─────────────┴──────────────┘
                      │
              ┌───────┴────────┐
              │  SvelteKit     │
              │  (FAKE cell)   │  ❌ Separate "runtime"
              │  HTTP wrapper  │  ❌ No real mesh participation
              └───────┬────────┘  ❌ Duplicated types
                      │
              ┌───────┴────────┐
              │   Browser      │
              │  (NO cell)     │  ❌ Just HTTP client
              │  fetch calls   │  ❌ Doesn't appear in atlas
              └────────────────┘  ❌ Not a mesh participant
```

**Problems:**
1. Browser not a real mesh participant
2. Duplicated code (`typed-mesh-runtime.ts` vs `typed-mesh.ts`)
3. Separate type systems
4. No way to extend browser cell capabilities
5. Server "cell" is fake - just HTTP wrapper

---

## NEW ARCHITECTURE ✅

```
┌───────────────────────────────────────────────────────────────┐
│                    RHEO MESH NETWORK                          │
│                                                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │Checklist │  │   Log    │  │    AI    │  │ SvelteKit│     │
│  │ (Server) │  │ (Server) │  │ (Server) │  │ (Server) │     │
│  │ Cell     │  │  Cell    │  │  Cell    │  │  Cell    │     │
│  │ listen() │  │ listen() │  │ listen() │  │ listen() │     │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘     │
│       │             │              │             │            │
│       │             │              │      ┌──────┴──────┐    │
│       │             │              │      │ HTTP Proxy  │    │
│       │             │              │      │ /_mesh/call │    │
│       │             │              │      └──────┬──────┘    │
│       │             │              │             │            │
│       └─────────────┴──────────────┴─────────────┘            │
│                                                  │            │
│                                         ┌────────┴────────┐  │
│                                         │   Browser       │  │
│                                         │   (Client)      │  │
│                                         │   Cell          │  │
│                                         │   connect()     │  │
│                                         └─────────────────┘  │
│                                                                │
│  ALL CELLS USE: TypedRheoCell from protocols/typed-mesh.ts   │
└───────────────────────────────────────────────────────────────┘
```

**Benefits:**
1. ✅ Browser IS a real cell (appears in atlas)
2. ✅ Same code, same types (`TypedRheoCell` everywhere)
3. ✅ Can extend browser cell with capabilities
4. ✅ Server cell is real (can handle requests)
5. ✅ Transport mode is implementation detail

---

## Code Comparison

### OLD: Separate implementations ❌

```typescript
// Server (protocols/typed-mesh.ts)
export class TypedRheoCell extends RheoCell {
    async askMesh<T>(cap: string, args: any) {
        return super.askMesh(cap, args);
    }
}

// Browser (ui/src/lib/typed-mesh-runtime.ts) ❌ DUPLICATE
export function createMeshClient() {
    return {
        mesh: new Proxy({}, {
            get: (_, namespace) => new Proxy({}, {
                get: (_, method) => async (args) => {
                    const res = await fetch('/_mesh/call', {
                        method: 'POST',
                        body: JSON.stringify({ capability: `${namespace}/${method}`, args })
                    });
                    return await res.json();
                }
            })
        })
    };
}
```

### NEW: Single implementation ✅

```typescript
// Everywhere (protocols/typed-mesh.ts)
export class TypedRheoCell extends RheoCell {
    public mode: 'server' | 'client' = 'server';
    
    // Server mode
    listen() {
        this.mode = 'server';
        // Start HTTP server...
    }
    
    // Client mode
    connect(seed?: string) {
        this.mode = 'client';
        this._addr = `client://${this.id}`;
        // Connect via HTTP client...
    }
    
    // Works in both modes!
    async askMesh<T>(cap: string, args: any) {
        // ...
    }
}

// Browser (ui/src/lib/browser-mesh-client.ts)
// Just wraps askMesh to use HTTP proxy
class BrowserRheoCell extends TypedRheoCell {
    async askMesh(cap, args) {
        // Proxy through server instead of direct RPC
        return await fetch('/_mesh/call', {
            body: JSON.stringify({ capability: cap, args })
        }).then(r => r.json());
    }
}
```

---

## Type Safety Comparison

### OLD: Duplicated types ❌

```typescript
// protocols/typed-mesh.ts
interface MeshCapabilities {
    "list/get": { input: void; output: List };
}

// ui/src/lib/generated-mesh-types.ts ❌ DUPLICATE
interface MeshCapabilities {
    "list/get": { input: void; output: List };
}
```

### NEW: Single source of truth ✅

```typescript
// protocols/typed-mesh.ts (ONE PLACE)
interface MeshCapabilities {
    "list/get": { input: void; output: List };
}

// Used everywhere:
// - Server cells
// - Browser cells
// - SvelteKit routes
// - Test files
```

---

## Feature Matrix

| Feature                       | Old   | New   |
|-------------------------------|-------|-------|
| Browser appears in atlas      | ❌    | ✅    |
| Single type system            | ❌    | ✅    |
| Browser can provide caps      | ❌    | ✅    |
| Server is real cell           | ❌    | ✅    |
| No code duplication           | ❌    | ✅    |
| Same API everywhere           | ❌    | ✅    |
| WebSocket upgrade possible    | ❌    | ✅    |
| Browser-to-browser possible   | ❌    | ✅    |

---

## Migration Path

### Phase 1: Add Client Mode ✅
- Add `mode` property
- Add `connect()` method
- Filter client cells in routing
- **Result:** Old code still works

### Phase 2: Replace Browser Client ✅
- Create `BrowserRheoCell`
- Update `hooks.server.ts`
- Update Svelte pages
- **Result:** Browser uses real cell

### Phase 3: Cleanup ✅
- Delete `typed-mesh-runtime.ts`
- Delete `mesh.ts`
- Delete duplicate types
- **Result:** Single protocol

### Phase 4: Future 🚀
- Add WebSocket transport
- Add P2P browser cells
- Add mobile support