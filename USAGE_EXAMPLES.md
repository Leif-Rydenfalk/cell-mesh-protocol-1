# Client Mode Usage Examples

## Example 1: Browser Application (SvelteKit)

### Setup (hooks.server.ts)
```typescript
import { TypedRheoCell } from '../../protocols/example1/typed-mesh';

const serverCell = new TypedRheoCell(`SvelteKit_${process.pid}`, 0);
serverCell.listen(); // Server mode

export const handle = async ({ event, resolve }) => {
    // Proxy for browser clients
    if (event.url.pathname === '/_mesh/call') {
        const { capability, args } = await event.request.json();
        const result = await serverCell.askMesh(capability, args);
        return Response.json(result);
    }
    
    return resolve(event);
};
```

### Browser (+page.svelte)
```typescript
<script lang="ts">
    import { getBrowserCell } from '$lib/browser-mesh-client';
    
    const cell = getBrowserCell(); // Client mode
    
    onMount(async () => {
        // Fully typed mesh calls - works exactly like server cells!
        const list = await cell.mesh.list.get();
        const health = await cell.mesh.mesh.health();
        
        console.log(cell.mode);  // "client"
        console.log(cell.atlas); // Full mesh atlas
    });
</script>
```

---

## Example 2: Node.js Client Script

```typescript
#!/usr/bin/env bun
import { TypedRheoCell } from './protocols/typed-mesh';

// Create a client-mode cell
const client = new TypedRheoCell(`CLI_Tool_${process.pid}`, 0);

// Connect to mesh (no listen!)
await client.connect('http://localhost:42373');

// Wait for atlas to populate
await new Promise(r => setTimeout(r, 2000));

// Use the mesh
const tasks = await client.mesh.list.get();
console.log(`Found ${tasks.items.length} tasks`);

// Add a task
await client.mesh.list.add({
    text: "Deploy to production",
    type: "task"
});

// Check health
const health = await client.mesh.mesh.health();
console.log(`Mesh has ${health.totalCells} active cells`);

// Gracefully disconnect
process.exit(0);
```

---

## Example 3: Testing Harness

```typescript
import { TypedRheoCell } from './protocols/typed-mesh';
import { describe, it, expect } from 'bun:test';

describe('Mesh Integration Tests', () => {
    let testClient: TypedRheoCell;
    
    beforeAll(async () => {
        testClient = new TypedRheoCell(`Test_${Date.now()}`, 0);
        await testClient.connect('http://localhost:42373');
        
        // Wait for convergence
        await new Promise(r => setTimeout(r, 3000));
    });
    
    it('should get checklist', async () => {
        const result = await testClient.mesh.list.get();
        expect(result.items).toBeArray();
    });
    
    it('should add and complete task', async () => {
        // Add
        const added = await testClient.mesh.list.add({
            text: 'Test task',
            type: 'task'
        });
        expect(added.ok).toBe(true);
        
        // Complete
        const completed = await testClient.mesh.list.complete({
            id: added.item.id
        });
        expect(completed.ok).toBe(true);
    });
    
    it('should get mesh health', async () => {
        const health = await testClient.mesh.mesh.health();
        expect(health.status).toBe('NOMINAL');
        expect(health.totalCells).toBeGreaterThan(0);
    });
});
```

---

## Example 4: React Native Mobile App

```typescript
// MobileApp.tsx
import { TypedRheoCell } from '@rheo/protocols/typed-mesh';
import { useState, useEffect } from 'react';

const meshClient = new TypedRheoCell(`MobileApp_${Date.now()}`, 0);
meshClient.connect('https://api.myapp.com/_mesh'); // Client mode

export function TaskList() {
    const [tasks, setTasks] = useState([]);
    
    useEffect(() => {
        // Load tasks from mesh
        meshClient.mesh.list.get().then(result => {
            setTasks(result.items);
        });
    }, []);
    
    const addTask = async (text: string) => {
        await meshClient.mesh.list.add({
            text,
            type: 'task'
        });
        
        // Refresh
        const result = await meshClient.mesh.list.get();
        setTasks(result.items);
    };
    
    return (
        <View>
            {tasks.map(task => (
                <TaskItem key={task.id} task={task} />
            ))}
        </View>
    );
}
```

---

## Example 5: Background Worker (Service Worker)

```typescript
// service-worker.ts
import { TypedRheoCell } from './protocols/typed-mesh';

// Client mode in service worker
const worker = new TypedRheoCell(`ServiceWorker_${self.registration.scope}`, 0);
await worker.connect('http://localhost:5173/_mesh');

// Listen for push notifications
self.addEventListener('push', async (event) => {
    const data = event.data.json();
    
    // Store in mesh
    await worker.mesh.list.add({
        text: data.message,
        type: 'task'
    });
    
    // Show notification
    self.registration.showNotification('New Task', {
        body: data.message
    });
});

// Periodic sync
self.addEventListener('periodicsync', async (event) => {
    if (event.tag === 'sync-tasks') {
        const tasks = await worker.mesh.list.get();
        
        // Store offline
        const cache = await caches.open('tasks');
        await cache.put('/tasks', new Response(JSON.stringify(tasks)));
    }
});
```

---

## Example 6: Electron Desktop App

```typescript
// main.ts (Electron main process)
import { TypedRheoCell } from './protocols/typed-mesh';
import { app, BrowserWindow, ipcMain } from 'electron';

// Server mode - can listen
const mainCell = new TypedRheoCell(`Electron_Main_${process.pid}`, 0);
mainCell.listen();

// Provide electron-specific capabilities
mainCell.provide('electron/open-file', async (args) => {
    const { dialog } = await import('electron');
    const result = await dialog.showOpenDialog({
        properties: ['openFile']
    });
    return result.filePaths[0];
});

// renderer.ts (Electron renderer process)
import { TypedRheoCell } from './protocols/typed-mesh';

// Client mode - connects to main process
const rendererCell = new TypedRheoCell(`Electron_Renderer_${Date.now()}`, 0);
await rendererCell.connect(`http://localhost:${mainCell.server.port}`);

// Use main process capabilities
const filePath = await rendererCell.mesh.electron['open-file']();

// Use mesh capabilities
const tasks = await rendererCell.mesh.list.get();
```

---

## Example 7: CLI Tool with Interactive Mode

```typescript
#!/usr/bin/env bun
import { TypedRheoCell } from './protocols/typed-mesh';
import readline from 'readline';

const cli = new TypedRheoCell(`CLI_Interactive_${process.pid}`, 0);
await cli.connect(process.env.MESH_URL || 'http://localhost:42373');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

console.log('🌐 Connected to mesh');
console.log(`Mode: ${cli.mode}`);
console.log(`Peers: ${Object.keys(cli.atlas).length - 1}`);
console.log('\nCommands: list, add <task>, complete <id>, health, quit\n');

rl.on('line', async (line) => {
    const [cmd, ...args] = line.trim().split(' ');
    
    try {
        switch (cmd) {
            case 'list':
                const list = await cli.mesh.list.get();
                list.items.forEach((item: any) => {
                    console.log(`[${item.completed ? '✓' : ' '}] ${item.text}`);
                });
                break;
                
            case 'add':
                await cli.mesh.list.add({
                    text: args.join(' '),
                    type: 'task'
                });
                console.log('✅ Added');
                break;
                
            case 'complete':
                await cli.mesh.list.complete({ id: args[0] });
                console.log('✅ Completed');
                break;
                
            case 'health':
                const health = await cli.mesh.mesh.health();
                console.log(`Status: ${health.status}`);
                console.log(`Cells: ${health.totalCells}`);
                break;
                
            case 'quit':
                process.exit(0);
                
            default:
                console.log('Unknown command');
        }
    } catch (e: any) {
        console.error('Error:', e.message);
    }
    
    rl.prompt();
});

rl.prompt();
```

---

## Example 8: Monitoring Dashboard

```typescript
// dashboard.ts
import { TypedRheoCell } from './protocols/typed-mesh';

const monitor = new TypedRheoCell(`Monitor_${process.pid}`, 0);
await monitor.connect('http://localhost:42373');

// Poll mesh health
setInterval(async () => {
    const health = await monitor.mesh.mesh.health();
    
    console.clear();
    console.log('=== MESH HEALTH ===');
    console.log(`Status: ${health.status}`);
    console.log(`Total Cells: ${health.totalCells}`);
    console.log(`Avg Load: ${(health.avgLoad * 100).toFixed(1)}%`);
    console.log(`Hot Spots: ${health.hotSpots.join(', ')}`);
    
    // Show atlas
    console.log('\n=== ATLAS ===');
    for (const [id, entry] of Object.entries(monitor.atlas)) {
        const age = Math.round((Date.now() - entry.lastSeen) / 1000);
        console.log(`${id.padEnd(30)} | ${entry.caps.length} caps | ${age}s ago`);
    }
}, 2000);
```

---

## Key Patterns

### Pattern 1: Always await connect()
```typescript
const cell = new TypedRheoCell('MyCell', 0);
await cell.connect(seedUrl); // Wait for initial bootstrap
// Now ready to use
```

### Pattern 2: Check mode before providing capabilities
```typescript
const cell = new TypedRheoCell('MyCell', 0);

if (process.env.NODE_ENV === 'production') {
    cell.listen(); // Server mode
    cell.provide('my/capability', handler);
} else {
    await cell.connect('http://localhost:42373'); // Client mode
}
```

### Pattern 3: Shared client singleton
```typescript
let globalCell: TypedRheoCell | null = null;

export function getCell() {
    if (!globalCell) {
        globalCell = new TypedRheoCell(`Shared_${Date.now()}`, 0);
        globalCell.connect();
    }
    return globalCell;
}
```

### Pattern 4: Graceful degradation
```typescript
try {
    const result = await cell.mesh.ai.generate({ prompt: 'Hello' });
    console.log(result.response);
} catch (e) {
    // AI cell might be offline
    console.log('Using fallback response');
}
```