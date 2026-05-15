# Client Mode Architecture

## Overview

The mesh now supports **two transport modes** for cells:

1. **Server Mode** (`mode: 'server'`) - Traditional cells that listen on HTTP ports
2. **Client Mode** (`mode: 'client'`) - Cells that can only make HTTP requests (browsers, restricted environments)

## Key Insight

**All cells use the same `TypedRheoCell` class** - the transport layer (HTTP server vs HTTP client) is an implementation detail.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    RHEO MESH NETWORK                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Orchestrator │  │  Checklist   │  │     Log      │      │
│  │   (Server)   │  │   (Server)   │  │   (Server)   │      │
│  │ listen():0   │  │ listen():0   │  │ listen():0   │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         │                 │                 │               │
│         └─────────────────┴─────────────────┘               │
│                           │                                 │
│                  ┌────────┴────────┐                        │
│                  │  SvelteKit      │                        │
│                  │  Server Cell    │                        │
│                  │  (Server Mode)  │                        │
│                  │  listen():5173  │                        │
│                  └────────┬────────┘                        │
│                           │                                 │
│                  ┌────────┴────────┐                        │
│                  │  HTTP Proxy     │                        │
│                  │  /_mesh/call    │                        │
│                  │  /_mesh/atlas   │                        │
│                  └────────┬────────┘                        │
│                           │                                 │
└───────────────────────────┼─────────────────────────────────┘
                            │
                   ┌────────┴────────┐
                   │   Browser Tab   │
                   │  Browser Cell   │
                   │  (Client Mode)  │
                   │  connect()      │
                   └─────────────────┘
```

## How It Works

### Server Mode Cells

```typescript
// Traditional cells (Orchestrator, Checklist, Log, etc.)
const cell = new TypedRheoCell(`Checklist_${process.pid}`, 0);
cell.useRouter(checklistRouter);
cell.listen(); // Starts HTTP server, mode = 'server'
```

### Client Mode Cells

```typescript
// Browser cells
const cell = new TypedRheoCell(`Browser_${tabId}`, 0);
await cell.connect('http://localhost:5173/_mesh'); // mode = 'client'

// Same API works!
const result = await cell.mesh.list.get();
```

## Implementation Details

### 1. Client Mode in `example1.ts`

```typescript
export class RheoCell {
    public mode: TransportMode = 'server';

    // New: Connect without listening
    async connect(seedAddr?: string): Promise<void> {
        this.mode = 'client';
        this._addr = `client://${this.id}`;
        
        // Bootstrap from seed
        await this.bootstrapFromRegistry(true);
        
        // Register as client
        this.registerToRegistry();
        
        // Heartbeat
        setInterval(() => this.registerToRegistry(), 5000);
    }
}
```

### 2. Browser Cell Proxy

The browser cell overrides `askMesh` to proxy through the server:

```typescript
class BrowserRheoCell extends TypedRheoCell {
    async askMesh(capability, ...args) {
        // Instead of direct mesh RPC, proxy through SvelteKit
        const response = await fetch('/_mesh/call', {
            method: 'POST',
            body: JSON.stringify({ capability, args: args[0] })
        });
        
        return await response.json();
    }
}
```

### 3. SvelteKit Server Cell

The server runs a real cell that acts as a bridge:

```typescript
// hooks.server.ts
const cell = new TypedRheoCell(`SvelteKit_Server_${process.pid}`, 0);
cell.listen(); // Server mode

export const handle = async ({ event, resolve }) => {
    // Proxy endpoint for browser clients
    if (event.url.pathname === '/_mesh/call') {
        const { capability, args } = await event.request.json();
        const result = await cell.askMesh(capability, args);
        return Response.json(result);
    }
    
    return resolve(event);
};
```

## Benefits

1. **Single Protocol** - `TypedRheoCell` works everywhere
2. **Full Type Safety** - Browser gets same types as server cells
3. **True Mesh Participation** - Browser cell appears in atlas, can provide capabilities
4. **No Duplication** - One implementation, two transport modes

## Files Changed

### New Files
- `ui/src/lib/browser-mesh-client.ts` - Browser cell with HTTP proxy
- `protocols/example1-client-mode-patch.ts` - Patch notes for example1.ts

### Modified Files
- `protocols/example1.ts` - Add `mode`, `connect()`, filter client cells
- `ui/src/hooks.server.ts` - Real cell instead of fake runtime
- `ui/src/routes/+page.svelte` - Use real cell API
- `ui/src/routes/debug/+page.svelte` - Show client mode status

### Deleted Files
- `ui/src/lib/typed-mesh-runtime.ts` ❌ (replaced by real cell)
- `ui/src/lib/mesh.ts` ❌ (replaced by real cell)

## Usage in Browser

```typescript
import { getBrowserCell } from '$lib/browser-mesh-client';

const cell = getBrowserCell();

// Fully typed mesh calls
const health = await cell.mesh.mesh.health();
const list = await cell.mesh.list.get();
const logs = await cell.mesh.log.get({ limit: 20 });

// Cell info
console.log(cell.id);      // "Browser_1234567890_abcdef"
console.log(cell.mode);    // "client"
console.log(cell.addr);    // "client://Browser_1234567890_abcdef"
console.log(cell.atlas);   // Full mesh atlas
```

## Testing

1. Start the mesh:
```bash
cd orchestrator
bun run index.ts start
```

2. Start UI:
```bash
cd ui
bun run dev
```

3. Open browser:
- Main UI: http://localhost:5173
- Debug panel: http://localhost:5173/debug

4. Check debug panel:
- Should show "Browser Cell (Client Mode)"
- Server cell should be in "server" mode
- All capability tests should pass ✅

## Future Enhancements

1. **WebSocket Transport** - Replace HTTP polling with persistent connection
2. **Service Worker Cells** - Run cells in background threads
3. **Peer-to-Peer Browser Cells** - WebRTC for direct browser-to-browser
4. **Mobile App Cells** - React Native cells in client mode