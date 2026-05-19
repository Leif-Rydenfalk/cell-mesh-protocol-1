# Rheo Cell Protocol — Biological Architecture Refactor

## The Problem
Your mesh was suffering from two critical issues:
1. **Regex syntax error**: `http:\/\/localhost:(\d+)` had double-escaped backslashes that Bun v1.3.1 rejected
2. **Hardcoded localhost everywhere**: 15+ hardcoded `http://localhost:${port}` strings scattered throughout, making the mesh non-portable and non-global

## The Biological Metaphor Architecture

We rebuilt the addressing system using biological cell metaphors because **cells in a body don't use "localhost"** — they use chemical gradients, membrane receptors, and gap junctions. Here's the mapping:

### 🧬 Core Biological Analogies

| Biological Structure | Software Equivalent | Purpose |
|---------------------|---------------------|---------|
| **Cell Membrane** | HTTP Transport Layer | Semi-permeable barrier — selective about what enters/exits |
| **Nucleus** | Ed25519 Identity | Immutable "genome" — the cell's permanent cryptographic identity |
| **Cytoplasm** | Capability Handlers | Where metabolic work (business logic) actually happens |
| **Endoplasmic Reticulum** | Signal Router | Transports and "folds" signals to correct destinations |
| **Golgi Apparatus** | Narrative Ledger | Packages, tags, and addresses signals for delivery |
| **Gap Junctions** | Mesh Gossip | Direct cell-to-cell communication channels |
| **Extracellular Matrix** | Registry Directory | Shared substrate all cells inhabit — no owner |
| **Ion Channels** | Port Registry | Voltage-gated (lock-protected) port allocation |
| **Lysosomes** | Cleanup/Ghost Busting | Garbage collection, stale process removal |
| **Mitochondria** | Telemetry/Metrics | Power management and metabolic monitoring |
| **Receptor Upregulation** | Capability Waiters | Cells "wake up" when needed capabilities come online |

### 🧫 The CellAddress Abstraction

**Before (broken):**
```typescript
const addr = `http://localhost:${port}`;  // 15+ scattered copies
```

**After (biological):**
```typescript
// Like a cell's position in tissue — parameterized, not hardcoded
export interface CellAddress {
    protocol: 'http' | 'https' | 'ws' | 'wss' | 'client' | 'unix';
    host: string;      // "localhost", "192.168.1.5", "cell-7.mesh.internal"
    port: number;
    path?: string;
}

// Create via factory — like a cell differentiating
const addr = createCellAddress('http', host, port).toString();
// → "http://localhost:8080" or "http://192.168.1.5:8080" or "client://browser-cell"
```

### 🔬 Key Changes Made

1. **Fixed the regex**: `http:\/\/localhost:(\d+)` → `http:\/localhost:(\d+)` (proper escaping)

2. **Added `CellAddress` type** with:
   - `createCellAddress(protocol, host, port)` — factory function
   - `parseCellAddress(addr)` — inverse (like receptor binding)
   - `extractPortFromAddr(addr)` — extracts port from any format

3. **Replaced all 15+ hardcoded localhost strings** with parameterized `createCellAddress()` calls

4. **Added `RHEO_HOST` environment variable** — set this to your actual host/IP and the entire mesh becomes global:
   ```bash
   RHEO_HOST=192.168.1.5 bun run index.ts  # Cells bind to real network interface
   ```

5. **PortRegistry now takes `host` parameter** — port claims are host-aware

6. **Spawn stdout parsing** now uses `extractPortFromAddr()` instead of brittle regex

### 🦠 Why This Matters for a "Global Mesh"

**Localhost is a lie.** It means "this specific machine." Real biological cells:
- Don't know they're "local" — they just respond to chemical gradients
- Can migrate (client cells)
- Can communicate across tissue boundaries (different hosts)
- Have permanent identity regardless of location (Ed25519 keys)

By making the host a **parameter** (not a constant), your cells can now:
- Run on different machines and find each other
- Use Unix sockets for same-machine zero-overhead communication
- Use WebSockets for browser-based client cells
- Run behind reverse proxies with path prefixes
- Form actual mesh topologies instead of "everything on my laptop"

### 🧪 Usage

```typescript
// Same machine (default)
const cell = new RheoCell("orchestrator", 8080);
await cell.listen();  // → http://localhost:8080

// Different machine / global mesh
process.env.RHEO_HOST = "10.0.0.5";
const cell = new RheoCell("orchestrator", 8080);
await cell.listen();  // → http://10.0.0.5:8080

// Client cell (like a circulating immune cell)
const client = new RheoCell("browser-ui");
await client.connect("http://10.0.0.5:8080");  // → client://browser-ui
```

### 🧬 The Registry as Extracellular Matrix

The `~/.rheo/registry/` directory is now properly understood as the **ECM**:
- No cell owns it
- All cells write their "chemical signatures" (manifests) to it
- Cells sense each other by reading the ECM, not by hardcoded addresses
- Stale entries are like dead cells — eventually cleared by lysosomal activity

---

**Bottom line**: Your cells are no longer trapped on localhost. They can form actual tissue.
