// A example implementation of the cell protocol.
// Pattern: Narrative Transparent Substrate (NTS-1)
const bunServe = (globalThis as any).Bun?.serve;
import { createServer } from "node:http";

import {
    randomUUID,
    createHash,
    generateKeyPairSync,
    sign,
    verify,
    createPublicKey,
    type KeyObject
} from "node:crypto";
import {
    writeFileSync, readFileSync, existsSync, mkdirSync,
    statSync, readdirSync, unlinkSync, createWriteStream
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { loadavg, homedir } from "node:os";
import { createReadStream } from "node:fs";
import { GossipRegistry, ConsistentHashRing, type GossipRecord } from "./gossip.ts";

const currentDir = dirname(new URL(import.meta.url).pathname);
const cellsRoot = resolve(currentDir, ".."); // ../ from app/
// Bootstrap hint directory: stores only ~/.rheo/registry/peers.json (addresses, not state).
// Gossip is the authoritative membership source; disk is a cold-start hint only.
export const REGISTRY_DIR = process.env.RHEO_REGISTRY_DIR || join(homedir(), ".rheo", "registry");
if (!existsSync(REGISTRY_DIR)) mkdirSync(REGISTRY_DIR, { recursive: true });

// ============================================================================
// HOST RESOLUTION
// A cell's advertised host must reach back from the open internet, not just
// from its own loopback. If RHEO_HOST is set, we trust it (operator override).
// Otherwise we probe well-known metadata + echo endpoints. On failure we
// default to localhost so dev still works. Side-effects process.env.RHEO_HOST
// so all the downstream `process.env.RHEO_HOST || 'localhost'` reads see it.
// ============================================================================

let _hostResolutionPromise: Promise<string> | null = null;

export async function resolveCellHost(): Promise<string> {
    if (process.env.RHEO_HOST) return process.env.RHEO_HOST;
    if (process.env.RHEO_NO_HOST_DETECT === '1') return 'localhost';
    if (_hostResolutionPromise) return _hostResolutionPromise;

    _hostResolutionPromise = (async () => {
        const sources = [
            "http://169.254.169.254/hetzner/v1/metadata/public-ipv4",
            "https://api.ipify.org",
            "https://ifconfig.me/ip",
            "https://icanhazip.com",
        ];
        for (const url of sources) {
            try {
                const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
                if (!res.ok) continue;
                const body = (await res.text()).trim();
                if (/^\d+\.\d+\.\d+\.\d+$/.test(body) || /^[0-9a-f:]+$/i.test(body)) {
                    process.env.RHEO_HOST = body;
                    return body;
                }
            } catch { /* try next source */ }
        }
        return 'localhost';
    })();

    return _hostResolutionPromise;
}

// ============================================================================
// CELL ADDRESS ABSTRACTION
// Biological analogy: Like a cell's position in tissue — not just "localhost"
// but a proper address in the extracellular matrix.
// ============================================================================

export interface CellAddress {
    protocol: 'http' | 'https' | 'ws' | 'wss' | 'client' | 'unix';
    host: string;
    port: number;
    path?: string;
    toString(): string;
}

export function createCellAddress(
    protocol: CellAddress['protocol'],
    host: string,
    port: number,
    path?: string
): CellAddress {
    return {
        protocol,
        host,
        port,
        path,
        toString() {
            if (this.protocol === 'client') {
                return `client://${this.host}`;
            }
            if (this.protocol === 'unix') {
                return `unix://${this.host}:${this.port}`;
            }
            const base = `${this.protocol}://${this.host}:${this.port}`;
            return this.path ? `${base}${this.path}` : base;
        }
    };
}

export function parseCellAddress(addr: string): CellAddress {
    if (addr.startsWith('client://')) {
        return createCellAddress('client', addr.replace('client://', ''), 0);
    }
    if (addr.startsWith('unix://')) {
        const rest = addr.replace('unix://', '');
        const [host, portStr] = rest.split(':');
        return createCellAddress('unix', host, parseInt(portStr) || 0);
    }
    const match = addr.match(/^(https?):\/\/([^:]+):(\d+)(\/.*)?$/);
    if (!match) {
        const portMatch = addr.match(/^(\d+)$/);
        if (portMatch) {
            return createCellAddress('http', 'localhost', parseInt(portMatch[1]));
        }
        throw new Error(`Invalid cell address: ${addr}`);
    }
    return createCellAddress(
        match[1] as CellAddress['protocol'],
        match[2],
        parseInt(match[3]),
        match[4] || undefined
    );
}

export function extractPortFromAddr(addr: string): number | null {
    try {
        const parsed = parseCellAddress(addr);
        return parsed.port || null;
    } catch {
        const match = addr.match(/:(\d+)(?:\/|$)/);
        return match ? parseInt(match[1]) : null;
    }
}


// --- TYPES & INTERFACES ---

/**
 * NarrativeStep: A single "Black Box" recording of a cell action.
 * Used to construct the causality chain during mesh failures.
 */
export interface NarrativeStep {
    cell: string;
    timestamp: number;
    action: string;
    data?: any;
}

export interface AtlasEntry {
    id?: string;  // the cell's self-reported ID
    addr: string;
    caps: string[];
    pubKey: string;     // Cryptographic Identity for Vouch Verification
    firstSeen: number;
    lastSeen: number;        // When WE last heard from this cell directly
    lastGossiped: number;    // When we last forwarded this entry
    gossipHopCount: number;  // How many hops from source (for TTL)
    status: 'online' | 'offline'; // State tracking
}

export interface TraceError {
    code: string;
    msg: string;
    from: string;
    trace: string[];
    history?: NarrativeStep[];
    details?: any;
    /** @internal NarrativeEnvelope for rich error reconstruction */
    _envelope?: any;
}

export interface TraceResult {
    ok: boolean;
    value?: any;
    error?: TraceError;
    cid: string;
}

export type TransportMode = 'server' | 'client';

/**
 * Signal: The Extensible Envelope.
 * 
 * TRANSPARENCY: [key: string]: any ensures that if a signal contains 
 * fields from a different example1 protocol implementation (e.g. quantum_sigs), 
 * this cell passes those exact bytes forward untouched.
 */
export interface Signal {
    id: string;
    from: string;
    intent: "ASK" | "TELL";
    payload: { capability: string; args: any;[key: string]: any };
    proofs: Record<string, string>;
    atlas: Record<string, AtlasEntry>;
    trace: string[];
    _steps?: NarrativeStep[]; // Narrative Black Box recorder
    _visitedCellIds?: string[];  // Which cells have processed this (by ID)
    _visitedAddr?: string[]; // Track visited addresses for debugging
    _hops?: number;
    _registryScanned?: boolean;
    _floodAttempted?: boolean;
    [key: string]: any;
}

export interface Contract {
    capability: string;
    version: string;
    inputSchema?: any;
    outputSchema?: any;
    transport: { protocol: string; port?: number; adapters: any[] };
    machine?: any;
    compatibility: string[];
}

export interface CellManifest {
    pid: number;
    version: string;
    port: number;
    startTime: number;
    capabilities: string[];
    seed?: string;
    pubKey: string;
}

// --- ENHANCED ERROR SYSTEM ---

/**
 * MeshError: Rich diagnostic exception for mesh failures.
 * Provides full narrative history, signal context, and debugging information.
 */
export class MeshError extends Error {
    public readonly timestamp: string;
    public readonly signalId: string;
    public readonly failedAt: string;
    public readonly errorChain: string[];

    constructor(public error: TraceError, public cid: string) {
        const timestamp = new Date().toISOString();
        const errorChain = MeshError.buildErrorChain(error);

        super(MeshError.formatMessage(error, cid, timestamp, errorChain));

        this.name = "MeshError";
        this.timestamp = timestamp;
        this.signalId = cid;
        this.failedAt = error.from;
        this.errorChain = errorChain;

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, MeshError);
        }
    }

    private static buildErrorChain(error: TraceError): string[] {
        const chain: string[] = [];
        if (error.history) {
            // We only care about steps where things went wrong to keep the summary concise
            const failures = error.history.filter(s =>
                s.action.includes("FAIL") ||
                s.action.includes("ERROR") ||
                s.action.includes("TIMEOUT") ||
                s.action.includes("REJECTED")
            );

            for (const f of failures) {
                // FIX: Add safety check for timestamp
                const time = f.timestamp ? new Date(f.timestamp).toISOString().split('T')[1].replace('Z', '') : 'unknown';

                // PROTECT: This is where circular/cyclic structures usually crash JSON.stringify
                let dataSummary = "";
                if (f.data) {
                    try {
                        // Try a strict stringify first for accuracy
                        const str = JSON.stringify(f.data);
                        dataSummary = str.length > 120 ? str.substring(0, 120) + "..." : str;
                    } catch (e) {
                        // FALLBACK: If data is cyclic (like a Signal containing itself), 
                        // we extract top-level keys manually to avoid the crash.
                        const keys = Object.keys(f.data).join(', ');
                        dataSummary = `[Cyclic Object Keys: ${keys}]`;
                    }
                }

                chain.push(`[${time}] ${f.cell}: ${f.action} | Data: ${dataSummary}`);
            }
        }
        return chain;
    }

    private static formatMessage(error: TraceError, cid: string, timestamp: string, chain: string[]): string {
        const lines: string[] = [];
        lines.push(`\n${'='.repeat(60)}`);
        lines.push(`💥 MESH FAILURE [${error.code}]`);
        lines.push(`${'='.repeat(60)}`);
        lines.push(`Time:     ${timestamp}`);
        lines.push(`Signal:   ${cid}`);
        lines.push(`Failed At: ${error.from}`);
        lines.push(`Message:  ${error.msg}`);

        if (error.trace && error.trace.length > 0) {
            lines.push(`\n📍 Signal Path (${error.trace.length} hops):`);
            error.trace.forEach((hop, i) => {
                const [cellId, time] = hop.split(':');
                const timeStr = time ? new Date(parseInt(time)).toISOString().split('T')[1].replace('Z', '') : 'unknown';
                lines.push(`   ${i + 1}. ${cellId} @ ${timeStr}`);
            });
        }

        if (chain.length > 0) {
            lines.push(`\n🔥 Failure Chain:`);
            chain.forEach(c => lines.push(`   ${c}`));
        }

        if (error.history && error.history.length > 0) {
            lines.push(`\n📜 Full Narrative (${error.history.length} steps):`);
            error.history.forEach((s, i) => {
                const time = new Date(s.timestamp).toISOString().split('T')[1].replace('Z', '');
                const dataStr = s.data ? ` | ${JSON.stringify(s.data).substring(0, 80)}` : '';
                lines.push(`   [${time}] ${s.cell.padEnd(20)} | ${s.action.padEnd(20)}${dataStr}`);
            });
        }

        // Suggest likely causes based on error code
        lines.push(`\n💡 Likely Causes:`);
        lines.push(...MeshError.suggestCauses(error));

        lines.push(`${'='.repeat(60)}\n`);

        return lines.join('\n');
    }

    private static suggestCauses(error: TraceError): string[] {
        const causes: Record<string, string[]> = {
            "LOOP": [
                "Signal ID was reused (check for duplicate randomUUID calls)",
                "Cell forwarded to itself (check 'from' vs 'addr' comparison in route())",
                "Circular capability chain (A→B→C→A)",
                "Stale Atlas entry pointing to wrong address"
            ],
            "HANDLER_ERR": [
                "Capability handler threw an exception",
                "Missing required arguments in payload",
                "Downstream service unavailable",
                "Check handler implementation for async errors"
            ],
            "NOT_FOUND": [
                "Capability not registered in any cell",
                "Cell hosting capability is offline",
                "Mesh hasn't converged yet (try adding delay)",
                "Typo in capability name",
                "The capability was found earlier, but no cell responded to the signal.",
                "This usually happens if the cell crashed or timed out during the hop."
            ],
            "RPC_FAIL": [
                "Target cell crashed or unreachable",
                "Network timeout (check cell health)",
                "Port conflict or firewall issue",
                "Target cell is shutting down"
            ],
            "TIMEOUT": [
                "Operation exceeded deadline",
                "Downstream cell is overloaded",
                "Deadlock in capability chain",
                "Check for infinite loops in handlers"
            ],
            "RPC_TIMEOUT": [
                "The target cell (AI, Kindly, etc.) is taking too long to process.",
                "Check if the Gemini/LLM API is responding slowly.",
                "Consider increasing the rpc timeout in example1.ts"
            ],
            "RPC_UNREACHABLE": [
                "Target cell crashed or is unreachable",
                "Network partition between cells",
                "Target cell port not open or firewall blocking",
                "Target cell is still starting up (check logs)"
            ]
        };

        return causes[error.code] || [
            "Unknown error type - check narrative history for clues",
            "Verify all cells in the chain are healthy",
            "Check for recent changes to capability implementations"
        ];
    }

    /**
     * Print detailed narrative to stderr
     */
    public printNarrative() {
        console.error(this.message);
    }

    /**
     * Get structured data for programmatic handling
     */
    public toJSON() {
        return {
            code: this.error.code,
            message: this.error.msg,
            signalId: this.cid,
            failedAt: this.failedAt,
            timestamp: this.timestamp,
            trace: this.error.trace,
            history: this.error.history,
            errorChain: this.errorChain
        };
    }
}

// === CELL SPAWN/KILL/ADOPT API ===
// Any cell can manage other cells. No special orchestrator needed.

interface SpawnOptions {
    id: string;                    // Cell ID
    command: string;               // e.g. "bun run index.ts"
    cwd: string;                   // Working directory
    env?: Record<string, string>;  // Extra env vars
    critical?: boolean;            // Restart on crash?
    restartDelayMs?: number;       // Delay before restart
    maxRestarts?: number;          // Give up after N crashes
}

interface ManagedCell {
    id: string;
    pid: number;         // Only populated if WE spawned it. 0 if we just observe it.
    port: number;
    addr: string;
    proc: any;           // ChildProcess — only if WE spawned it
    status: 'starting' | 'online' | 'crashed' | 'stopped' | 'zombie';
    startTime: number;
    restarts: number;
    lastCrash?: number;
    stderrBuffer: string;
}

// --- Narrative ---


// protocols/narrative.ts - The Complete Signal Preservation Layer
// No information loss. Ever.

/**
 * Immutable signal envelope that grows with each hop.
 * Previous signals are never mutated - only wrapped.
 */
export interface NarrativeEnvelope {
    // The current signal being processed
    current: Signal;

    // Complete history of this signal's journey
    // Each entry is the FULL signal as it existed at that point in time
    ancestry: AncestryEntry[];

    // Fork tracking - if this signal spawned children
    children: string[]; // Signal IDs of forked signals

    // Performance telemetry
    timings: TimingEntry[];

    // Binary payload hashes for integrity verification
    integrity: IntegrityEntry[];
}

interface AncestryEntry {
    signalId: string;
    timestamp: number;
    cellId: string;
    cellAddr: string;
    action: string;
    // SNAPSHOT: The complete signal state at this moment
    signalSnapshot: Signal;
    // The delta from previous state (for compression)
    delta?: SignalDelta;
}

interface SignalDelta {
    changedFields: string[];
    previousValues: Record<string, any>;
    reason: string; // Why did we change?
}

interface TimingEntry {
    phase: string;
    cellId: string;
    startTime: number;
    endTime: number;
    durationMs: number;
    // What were we waiting for?
    blockingOn?: string;
}

interface IntegrityEntry {
    timestamp: number;
    cellId: string;
    // Hash of the complete signal JSON at this point
    hash: string;
    // Signature proving this cell saw this state
    signature: string;
}

/**
 * The NarrativeLedger: Append-only, cryptographically verifiable signal history.
 * Every cell maintains a shard of the global narrative.
 */
export class NarrativeLedger {
    entries = new Map<string, NarrativeEnvelope>();
    readonly maxAncestryDepth = 100;

    /**
     * Create or extend a narrative envelope for a signal.
     * NEVER mutates existing entries - creates new envelope with extended ancestry.
     */
    wrap(signal: Signal, cellId: string, action: string, reason?: string | Record<string, any>): NarrativeEnvelope {
        const existing = this.entries.get(signal.id);
        const timestamp = Date.now();

        // Normalize reason to string
        const reasonStr = typeof reason === 'string' ? reason : (reason ? JSON.stringify(reason) : undefined);

        // Create ancestry entry with FULL signal snapshot
        const ancestryEntry: AncestryEntry = {
            signalId: signal.id,
            timestamp,
            cellId,
            cellAddr: this.getCellAddr(cellId),
            action,
            signalSnapshot: this.deepFreeze(structuredClone(signal)),
            delta: existing ? this.computeDelta(existing.current, signal, reasonStr) : undefined
        };

        // Build new envelope
        const envelope: NarrativeEnvelope = {
            current: signal,
            ancestry: existing
                ? [...existing.ancestry, ancestryEntry].slice(-this.maxAncestryDepth)
                : [ancestryEntry],
            children: existing?.children || [],
            timings: existing?.timings || [],
            integrity: [...(existing?.integrity || []), this.computeIntegrity(signal, cellId, timestamp)]
        };

        this.entries.set(signal.id, envelope);
        return envelope;
    }

    /**
     * Record a timing event
     */
    recordTiming(signalId: string, phase: string, cellId: string, startTime: number, endTime: number, blockingOn?: string) {
        const envelope = this.entries.get(signalId);
        if (!envelope) return;

        envelope.timings.push({
            phase,
            cellId,
            startTime,
            endTime,
            durationMs: endTime - startTime,
            blockingOn
        });
    }

    /**
     * Fork a signal - create child signal with linked ancestry
     */
    fork(parentId: string, childSignal: Signal, reason: string): NarrativeEnvelope {
        const parent = this.entries.get(parentId);
        if (!parent) {
            throw new Error(`Cannot fork: parent ${parentId} not found in ledger`);
        }

        // Mark parent as having forked
        parent.children.push(childSignal.id);

        // Child inherits full ancestry PLUS fork marker
        const forkEntry: AncestryEntry = {
            signalId: childSignal.id,
            timestamp: Date.now(),
            cellId: "SYSTEM",
            cellAddr: "fork",
            action: `FORK_FROM_${parentId}`,
            signalSnapshot: this.deepFreeze(structuredClone(childSignal)),
            delta: { changedFields: ["id", "parentId"], previousValues: { parentId }, reason }
        };

        const childEnvelope: NarrativeEnvelope = {
            current: childSignal,
            ancestry: [...parent.ancestry, forkEntry],
            children: [],
            timings: [],
            integrity: [this.computeIntegrity(childSignal, "FORK", Date.now())]
        };

        this.entries.set(childSignal.id, childEnvelope);
        return childEnvelope;
    }

    /**
     * Reconstruct the complete execution path with full fidelity
     */
    reconstructExecutionPath(signalId: string): ExecutionPath {
        const envelope = this.entries.get(signalId);
        if (!envelope) {
            throw new Error(`Signal ${signalId} not found in ledger`);
        }

        const path: ExecutionStep[] = [];

        for (let i = 0; i < envelope.ancestry.length; i++) {
            const entry = envelope.ancestry[i];
            const prevEntry = i > 0 ? envelope.ancestry[i - 1] : null;

            path.push({
                stepNumber: i,
                timestamp: entry.timestamp,
                cellId: entry.cellId,
                cellAddr: entry.cellAddr,
                action: entry.action,

                // FULL signal state at this point
                signalState: entry.signalSnapshot,

                // What changed from previous step
                changes: entry.delta ? {
                    fields: entry.delta.changedFields,
                    previousValues: entry.delta.previousValues,
                    reason: entry.delta.reason
                } : null,

                // Timing for this hop
                timing: envelope.timings.find(t =>
                    t.phase === entry.action &&
                    Math.abs(t.startTime - entry.timestamp) < 100
                ) || null,

                // Integrity verification
                integrity: envelope.integrity.find(int =>
                    Math.abs(int.timestamp - entry.timestamp) < 100
                ) || null
            });
        }

        return {
            signalId,
            totalSteps: path.length,
            totalDurationMs: envelope.timings.reduce((sum, t) => sum + t.durationMs, 0),
            steps: path,
            children: envelope.children,
            finalState: envelope.current
        };
    }

    /**
     * Generate a complete forensic report for debugging
     * This is what gets logged on error - EVERYTHING.
     */
    generateForensicReport(signalId: string, errorContext?: any): ForensicReport {
        const path = this.reconstructExecutionPath(signalId);
        const envelope = this.entries.get(signalId)!;

        // Find the exact point of failure
        const failureStep = errorContext
            ? path.steps.find(s => s.cellId === errorContext.failedAt) || null
            : path.steps[path.steps.length - 1] || null;

        // Analyze what went wrong
        const analysis = this.analyzeFailure(path, failureStep, errorContext);

        return {
            signalId,
            generatedAt: Date.now(),

            summary: {
                totalHops: path.totalSteps,
                totalDurationMs: path.totalDurationMs,
                cellsVisited: [...new Set(path.steps.map(s => s.cellId))],
                failurePoint: failureStep ? {
                    step: failureStep.stepNumber,
                    cell: failureStep.cellId,
                    action: failureStep.action,
                    timestamp: failureStep.timestamp
                } : null
            },

            // Complete execution path with full signal states
            executionPath: path,

            // Detailed analysis of the failure
            failureAnalysis: analysis,

            // Timing breakdown
            timingBreakdown: this.analyzeTimings(envelope.timings),

            // Integrity verification - did anyone tamper with the signal?
            integrityCheck: this.verifyIntegrity(path),

            // Reproduction data - can we replay this exact execution?
            reproduction: {
                canReplay: true,
                initialSignal: path.steps[0]?.signalState,
                replayScript: this.generateReplayScript(path)
            },

            // Raw data for programmatic analysis
            raw: {
                envelope: this.sanitizeForExport(envelope),
                errorContext
            }
        };
    }

    /**
     * Deep analysis of what went wrong
     */
    private analyzeFailure(path: ExecutionPath, failureStep: ExecutionStep | null, errorContext: any): FailureAnalysis {
        if (!failureStep) {
            return {
                type: "UNKNOWN",
                description: "Could not identify failure point",
                likelyCauses: ["Signal completed without error", "Error occurred after last logged step"],
                recommendations: ["Check cell logs for unhandled exceptions"]
            };
        }

        const stepIndex = failureStep.stepNumber;
        const previousStep = stepIndex > 0 ? path.steps[stepIndex - 1] : null;

        // Analyze based on action type
        switch (failureStep.action) {
            case "RPC_ATTEMPT":
                return {
                    type: "NETWORK_FAILURE",
                    description: `Failed to reach ${failureStep.cellAddr}`,
                    details: {
                        targetCell: failureStep.cellId,
                        targetAddr: failureStep.cellAddr,
                        payloadSize: JSON.stringify(failureStep.signalState.payload).length
                    },
                    likelyCauses: [
                        "Target cell crashed or is unreachable",
                        "Network partition between cells",
                        "Target cell overloaded (circuit breaker open)",
                        "DNS resolution failure for target address"
                    ],
                    recommendations: [
                        `Check if cell ${failureStep.cellId} is running: mesh/ping → ${failureStep.cellId}`,
                        `Verify network path: traceroute to ${failureStep.cellAddr}`,
                        `Check target cell logs for crash reports`,
                        `Review circuit breaker state for ${failureStep.cellId}`
                    ]
                };

            case "LOCAL_HANDLER":
                const handlerError = errorContext?.error;
                return {
                    type: "HANDLER_EXCEPTION",
                    description: `Capability handler threw exception in ${failureStep.cellId}`,
                    details: {
                        capability: failureStep.signalState.payload?.capability,
                        handlerCell: failureStep.cellId,
                        errorMessage: handlerError?.message,
                        errorStack: handlerError?.stack
                    },
                    likelyCauses: [
                        "Handler implementation bug",
                        "Missing required arguments in payload",
                        "Downstream dependency failure",
                        "State corruption in handler cell"
                    ],
                    recommendations: [
                        `Review handler code in ${failureStep.cellId}`,
                        `Validate input schema for ${failureStep.signalState.payload?.capability}`,
                        `Check downstream service health`,
                        `Review recent changes to ${failureStep.cellId} handler`
                    ]
                };

            case "RECEIVED_SIGNAL":
                // Check if we looped
                const previousVisits = path.steps.filter((s, i) =>
                    i < stepIndex && s.cellId === failureStep.cellId
                );
                if (previousVisits.length > 0) {
                    return {
                        type: "ROUTING_LOOP",
                        description: `Signal visited ${failureStep.cellId} ${previousVisits.length + 1} times`,
                        details: {
                            loopCell: failureStep.cellId,
                            previousVisits: previousVisits.map(s => s.timestamp),
                            loopDepth: previousVisits.length
                        },
                        likelyCauses: [
                            "Stale atlas entry pointing to wrong address",
                            "Cell forwarding logic error (forwarding to self)",
                            "Circular capability chain (A→B→C→A)",
                            "Signal ID collision (extremely unlikely)"
                        ],
                        recommendations: [
                            `Force atlas refresh: POST ${failureStep.cellAddr}/atlas`,
                            `Check ${failureStep.cellId} route() implementation for self-forwarding`,
                            `Review capability chain for cycles`,
                            `Verify signal ID generation is using crypto.randomUUID()`
                        ]
                    };
                }
                break;
        }

        // Generic analysis
        return {
            type: "UNEXPECTED_FAILURE",
            description: `Failure during ${failureStep.action} in ${failureStep.cellId}`,
            details: {
                lastKnownGoodStep: previousStep ? {
                    cell: previousStep.cellId,
                    action: previousStep.action,
                    timestamp: previousStep.timestamp
                } : null,
                failedStep: {
                    cell: failureStep.cellId,
                    action: failureStep.action,
                    timestamp: failureStep.timestamp,
                    signalState: failureStep.signalState
                }
            },
            likelyCauses: ["Unknown - requires manual investigation"],
            recommendations: ["Review complete execution path below", "Check cell logs for unhandled exceptions"]
        };
    }

    /**
     * Verify cryptographic integrity of signal chain
     */
    private verifyIntegrity(path: ExecutionPath): IntegrityResult {
        const results: IntegrityCheck[] = [];

        for (const step of path.steps) {
            if (!step.integrity) continue;

            // Recompute hash and compare
            const computedHash = this.computeSignalHash(step.signalState);
            const matches = computedHash === step.integrity.hash;

            results.push({
                step: step.stepNumber,
                cell: step.cellId,
                timestamp: step.integrity.timestamp,
                hashMatches: matches,
                claimedHash: step.integrity.hash,
                computedHash,
                signatureValid: this.verifySignature(step.integrity.signature, step.integrity.hash, step.cellId)
            });
        }

        const allValid = results.every(r => r.hashMatches && r.signatureValid);

        return {
            overall: allValid ? "VALID" : "COMPROMISED",
            checks: results,
            tamperedSteps: results.filter(r => !r.hashMatches || !r.signatureValid).map(r => r.step)
        };
    }

    /**
     * Generate a script that can replay this exact execution
     */
    private generateReplayScript(path: ExecutionPath): string {
        const lines: string[] = [];
        lines.push("// Auto-generated replay script");
        lines.push(`const initialSignal = ${JSON.stringify(path.steps[0]?.signalState, null, 2)};`);
        lines.push("");
        lines.push("// Replay each hop");

        for (let i = 1; i < path.steps.length; i++) {
            const step = path.steps[i];
            lines.push(`// Step ${i}: ${step.action} @ ${step.cellId}`);
            lines.push(`await simulateHop({
                cell: "${step.cellId}",
                action: "${step.action}",
                inputSignal: ${JSON.stringify(step.signalState)},
                expectedChanges: ${JSON.stringify(step.changes?.fields)}
            });`);
        }

        return lines.join("\n");
    }

    // Helper methods
    private computeDelta(prev: Signal, curr: Signal, reason?: string): SignalDelta {
        const changedFields: string[] = [];
        const previousValues: Record<string, any> = {};

        for (const key of Object.keys(curr)) {
            if (JSON.stringify((prev as any)[key]) !== JSON.stringify((curr as any)[key])) {
                changedFields.push(key);
                previousValues[key] = (prev as any)[key];
            }
        }

        return { changedFields, previousValues, reason: reason || "unknown" };
    }

    private computeIntegrity(signal: Signal, cellId: string, timestamp: number): IntegrityEntry {
        const hash = this.computeSignalHash(signal);
        const signature = this.signHash(hash, cellId);
        return { timestamp, cellId, hash, signature };
    }

    private computeSignalHash(signal: Signal): string {
        // Deterministic JSON serialization
        const canonical = JSON.stringify(signal, Object.keys(signal).sort());
        // Use crypto in real implementation
        return `sha256:${btoa(canonical).slice(0, 16)}`;
    }

    private signHash(hash: string, cellId: string): string {
        // Use actual crypto in production
        return `sig:${cellId}:${hash.slice(0, 8)}`;
    }

    private verifySignature(signature: string, hash: string, cellId: string): boolean {
        // Verify against cell's public key
        return signature.startsWith(`sig:${cellId}:`);
    }

    private deepFreeze<T>(obj: T): T {
        Object.freeze(obj);
        Object.getOwnPropertyNames(obj).forEach(prop => {
            const value = (obj as any)[prop];
            if (value !== null && (typeof value === "object" || typeof value === "function")) {
                this.deepFreeze(value);
            }
        });
        return obj;
    }

    private getCellAddr(cellId: string): string {
        // Look up in registry
        return "unknown";
    }

    private sanitizeForExport(envelope: NarrativeEnvelope): any {
        // Remove circular refs, reduce size for transport
        return {
            signalId: envelope.current.id,
            ancestryCount: envelope.ancestry.length,
            timingCount: envelope.timings.length,
            children: envelope.children
        };
    }

    private analyzeTimings(timings: TimingEntry[]): TimingAnalysis {
        const byPhase = new Map<string, TimingEntry[]>();
        for (const t of timings) {
            if (!byPhase.has(t.phase)) byPhase.set(t.phase, []);
            byPhase.get(t.phase)!.push(t);
        }

        return {
            totalTime: timings.reduce((sum, t) => sum + t.durationMs, 0),
            byPhase: Array.from(byPhase.entries()).map(([phase, entries]) => ({
                phase,
                count: entries.length,
                totalMs: entries.reduce((sum, t) => sum + t.durationMs, 0),
                avgMs: entries.reduce((sum, t) => sum + t.durationMs, 0) / entries.length,
                maxMs: Math.max(...entries.map(t => t.durationMs))
            })),
            bottlenecks: timings
                .filter(t => t.durationMs > 1000)
                .sort((a, b) => b.durationMs - a.durationMs)
                .slice(0, 5)
        };
    }

    /**
     * Merge a remote envelope into our local ledger.
     * Preserves all ancestry, timings, and integrity checks from remote.
     */
    merge(remoteEnvelope: NarrativeEnvelope): void {
        if (!remoteEnvelope) return;

        const cid = remoteEnvelope.current.id;
        const local = this.entries.get(cid);

        if (!local) {
            // We don't have this signal - adopt it fully
            this.entries.set(cid, this.deepClone(remoteEnvelope));
            return;
        }

        // Merge ancestry: combine both histories, deduplicate by timestamp+cell
        const seen = new Set(local.ancestry.map(a => `${a.timestamp}-${a.cellId}-${a.action}`));
        for (const remoteEntry of remoteEnvelope.ancestry) {
            const key = `${remoteEntry.timestamp}-${remoteEntry.cellId}-${remoteEntry.action}`;
            if (!seen.has(key)) {
                local.ancestry.push(this.deepClone(remoteEntry));
                seen.add(key);
            }
        }

        // Sort by timestamp to maintain chronological order
        local.ancestry.sort((a, b) => a.timestamp - b.timestamp);

        // Merge timings
        const localTimingKeys = new Set(local.timings.map(t => `${t.phase}-${t.cellId}-${t.startTime}`));
        for (const remoteTiming of remoteEnvelope.timings) {
            const key = `${remoteTiming.phase}-${remoteTiming.cellId}-${remoteTiming.startTime}`;
            if (!localTimingKeys.has(key)) {
                local.timings.push(this.deepClone(remoteTiming));
            }
        }

        // Merge integrity checks
        const localHashes = new Set(local.integrity.map(i => i.hash));
        for (const remoteIntegrity of remoteEnvelope.integrity) {
            if (!localHashes.has(remoteIntegrity.hash)) {
                local.integrity.push(this.deepClone(remoteIntegrity));
            }
        }

        // Merge children (fork tracking)
        for (const childId of remoteEnvelope.children) {
            if (!local.children.includes(childId)) {
                local.children.push(childId);
            }
        }

        // Update current signal if remote is newer
        const remoteHops = remoteEnvelope.current._hops ?? 0;
        const localHops = local.current._hops ?? 0;
        if (remoteHops > localHops) {
            local.current = this.deepClone(remoteEnvelope.current);
        }
    }

    private deepClone<T>(obj: T): T {
        return JSON.parse(JSON.stringify(obj));
    }
}

// Type exports
interface ExecutionPath {
    signalId: string;
    totalSteps: number;
    totalDurationMs: number;
    steps: ExecutionStep[];
    children: string[];
    finalState: Signal;
}

interface ExecutionStep {
    stepNumber: number;
    timestamp: number;
    cellId: string;
    cellAddr: string;
    action: string;
    signalState: Signal;
    changes: {
        fields: string[];
        previousValues: Record<string, any>;
        reason: string;
    } | null;
    timing: TimingEntry | null;
    integrity: IntegrityEntry | null;
}

interface ForensicReport {
    signalId: string;
    generatedAt: number;
    summary: {
        totalHops: number;
        totalDurationMs: number;
        cellsVisited: string[];
        failurePoint: {
            step: number;
            cell: string;
            action: string;
            timestamp: number;
        } | null;
    };
    executionPath: ExecutionPath;
    failureAnalysis: FailureAnalysis;
    timingBreakdown: TimingAnalysis;
    integrityCheck: IntegrityResult;
    reproduction: {
        canReplay: boolean;
        initialSignal: Signal | undefined;
        replayScript: string;
    };
    raw: {
        envelope: any;
        errorContext: any;
    };
}

interface FailureAnalysis {
    type: string;
    description: string;
    details?: any;
    likelyCauses: string[];
    recommendations: string[];
}

interface TimingAnalysis {
    totalTime: number;
    byPhase: Array<{
        phase: string;
        count: number;
        totalMs: number;
        avgMs: number;
        maxMs: number;
    }>;
    bottlenecks: TimingEntry[];
}

interface IntegrityResult {
    overall: "VALID" | "COMPROMISED";
    checks: IntegrityCheck[];
    tamperedSteps: number[];
}

interface IntegrityCheck {
    step: number;
    cell: string;
    timestamp: number;
    hashMatches: boolean;
    claimedHash: string;
    computedHash: string;
    signatureValid: boolean;
}

// Global ledger instance per cell
export const globalLedger = new NarrativeLedger();

// RegistryWatcher replaced by GossipRegistry — membership changes now arrive
// via SWIM probes and anti-entropy push/pull rather than fs.watch on JSON files.
// Stub kept for any lingering call sites during the transition.
class RegistryWatcher {
    private static instance: RegistryWatcher | null = null;
    static getInstance(): RegistryWatcher {
        if (!RegistryWatcher.instance) RegistryWatcher.instance = new RegistryWatcher();
        return RegistryWatcher.instance;
    }
    subscribe(_cb: (eventType: string, filename: string | null) => void): () => void {
        return () => { };
    }
    destroy(): void {
        RegistryWatcher.instance = null;
    }
}

// ============================================================================
// PORT REGISTRY & ACQUISITION (Prevents EADDRINUSE collisions)
// ============================================================================

interface PortOwner {
    cellId: string;
    pid: number;
    port: number;
    timestamp: number;
    addr: string;
}

class PortRegistry {
    private static PORT_FILE = join(homedir(), ".rheo", "port-registry.json");
    private static LOCK_FILE = join(homedir(), ".rheo", ".port-lock");
    private static lockFd: number | null = null;

    static read(): Record<string, PortOwner> {
        try {
            if (!existsSync(this.PORT_FILE)) return {};
            return JSON.parse(readFileSync(this.PORT_FILE, "utf8"));
        } catch (e) { return {}; }
    }

    static write(owners: Record<string, PortOwner>) {
        const dir = dirname(this.PORT_FILE);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(this.PORT_FILE, JSON.stringify(owners, null, 2));
    }

    static async acquireLock(): Promise<boolean> {
        // Simple file-based lock with retry
        for (let i = 0; i < 50; i++) {
            try {
                const { openSync } = require("node:fs");
                this.lockFd = openSync(this.LOCK_FILE, "wx");
                return true;
            } catch (e) {
                await new Promise(r => setTimeout(r, 20));
            }
        }
        return false;
    }

    static releaseLock() {
        if (this.lockFd !== null) {
            try {
                const { closeSync, unlinkSync } = require("node:fs");
                closeSync(this.lockFd);
                unlinkSync(this.LOCK_FILE);
            } catch (e) { }
            this.lockFd = null;
        }
    }

    static async claimPort(cellId: string, preferredPort: number, host: string = 'localhost'): Promise<{ port: number; adopted: boolean; existingAddr?: string }> {
        await this.acquireLock();
        try {
            const owners = this.read();
            const now = Date.now();

            // Check if WE already own this port
            if (owners[cellId]) {
                const ours = owners[cellId];
                try {
                    const addr = createCellAddress('http', host, ours.port).toString();
                    const health = await fetch(`${addr}/atlas`, {
                        signal: AbortSignal.timeout(500)
                    });
                    if (health.ok) {
                        return { port: ours.port, adopted: true, existingAddr: addr };
                    }
                } catch {
                    delete owners[cellId];
                }
            }

            // Check if preferred port is taken by someone else
            const occupant = Object.values(owners).find(o => o.port === preferredPort);
            if (occupant) {
                let alive = false;
                try {
                    const addr = createCellAddress('http', host, preferredPort).toString();
                    const ping = await fetch(`${addr}/atlas`, {
                        signal: AbortSignal.timeout(300)
                    });
                    alive = ping.ok;
                } catch {
                    alive = false;
                }

                if (!alive) {
                    delete owners[occupant.cellId];
                } else {
                    preferredPort = await this.findAvailablePort(preferredPort + 1, owners, host);
                }
            }

            const testPort = await this.testPort(preferredPort);
            if (!testPort) {
                preferredPort = await this.findAvailablePort(preferredPort + 1, owners, host);
            }

            const newAddr = createCellAddress('http', host, preferredPort).toString();
            owners[cellId] = {
                cellId,
                pid: process.pid,
                port: preferredPort,
                timestamp: now,
                addr: newAddr
            };

            this.write(owners);
            return { port: preferredPort, adopted: false };

        } finally {
            this.releaseLock();
        }
    }

    private static async findAvailablePort(start: number, owners: Record<string, PortOwner>, host: string = 'localhost'): Promise<number> {
        const usedPorts = new Set(Object.values(owners).map(o => o.port));
        let port = start;
        while (usedPorts.has(port) || !(await this.testPort(port))) {
            port++;
            if (port > 65535) throw new Error("No available ports");
        }
        return port;
    }

    private static async testPort(port: number): Promise<boolean> {
        try {
            const testServer = Bun.serve({
                port,
                fetch: () => new Response("test"),
                development: false
            });
            testServer.stop();
            return true;
        } catch (e: any) {
            if (e.code === 'EADDRINUSE') return false;
            // Other errors might mean port is usable but something else failed
            return false;
        }
    }

    static releasePort(cellId: string) {
        this.acquireLock();
        try {
            const owners = this.read();
            if (owners[cellId]?.pid === process.pid) {
                delete owners[cellId];
                this.write(owners);
            }
        } finally {
            this.releaseLock();
        }
    }
}


// --- CORE RHEO CELL ---

interface MulticastResult {
    results: Array<{ cellId: string; result: any; latency: number }>;
    failures: Array<{ cellId: string; error: TraceError }>;
    consensus?: any; // Aggregated result
}

export class RheoCell {
    public atlas: Record<string, AtlasEntry> = {};
    private handlers: Record<string, Function> = {};
    private contracts = new Map<string, Contract>();
    private seenNonces = new Set<string>();
    public server: any;

    // Cryptographic Identity (Ed25519)
    private privateKey: KeyObject;
    public publicKey: string;

    public mode: TransportMode = 'server';

    // Gossip-based membership state machine (replaces ~/.rheo/registry/*.json)
    public readonly gossip: GossipRegistry;
    public readonly ring: ConsistentHashRing;

    private manifestPath: string;
    private cellDir: string;
    private currentVersion: string;
    private seedFile = ".rheo_seed";

    private isShuttingDown: boolean = false;
    private activeIntervals: Timer[] = [];
    private cleanupHooks: Array<() => void | Promise<void>> = [];

    /** Register a setInterval handle to be cleared on cell shutdown. */
    public registerInterval(interval: Timer): void {
        this.activeIntervals.push(interval);
    }

    /** Register a cleanup function to be called during cell shutdown. */
    public onShutdown(fn: () => void | Promise<void>): void {
        this.cleanupHooks.push(fn);
    }

    private activeExecutions = new Map<string, Promise<TraceResult>>();
    private resultCache = new Map<string, { result: TraceResult, time: number }>();

    // Local Journaling (Ephemeral Memory)
    private journal: Record<string, NarrativeStep[]> = {};
    private rollingJournal: any[] = [];
    private readonly MAX_JOURNAL_SIZE = 100;

    // PubSub for capabilities
    private capabilityWaiters: Map<string, Array<() => void>> = new Map();
    private fsWatcher: any = null;

    private _addr: string = "";
    public get addr(): string {
        return this._addr;
    }

    // Telemetry State
    private metrics = {
        qps: 0,
        errors: 0,
        latencySum: 0,
        requestCount: 0,
        windowStart: Date.now()
    };

    private errorSubscribers = new Set<(error: any) => void>();
    private static globalErrorSubscribers = new Set<(error: any) => void>();

    // Subscribe to errors from this specific cell
    onError(callback: (error: any) => void): () => void {
        this.errorSubscribers.add(callback);
        return () => this.errorSubscribers.delete(callback);
    }

    // Subscribe to errors from ALL cells (static)
    static onGlobalError(callback: (error: any) => void): () => void {
        RheoCell.globalErrorSubscribers.add(callback);
        return () => RheoCell.globalErrorSubscribers.delete(callback);
    }

    // Emit error to all subscribers
    private emitError(error: any): void {
        // Local subscribers
        for (const cb of this.errorSubscribers) {
            try { cb(error); } catch { }
        }
        // Global subscribers
        for (const cb of RheoCell.globalErrorSubscribers) {
            try { cb(error); } catch { }
        }
    }

    /**
 * The Segmented Capability Proxy
 * 
 * Logic: Translates underscores to mesh-standard dashes and maps
 * double-underscores to recursive middleware layers.
 * 
 * Example: cell.mesh.inventory.add__auth_user() -> "inventory/add|auth/user"
 */
    get mesh(): any {
        return new Proxy({} as any, {
            get: (target, namespace: string) => {
                return new Proxy({}, {
                    get: (subTarget, methodCall: string) => {
                        return (...callArgs: any[]) => {
                            const [method, ...middlewares] = methodCall.split('__');
                            let capability = `${namespace}/${method.replace(/_/g, '-')}`;

                            if (middlewares.length > 0) {
                                capability += "|" + middlewares.join('|').replace(/_/g, '/');
                            }

                            const args = callArgs[0] !== undefined ? callArgs[0] : {};
                            const proofs = callArgs[1] !== undefined ? callArgs[1] : {};

                            if (process.env.RHEO_DEBUG) {
                                console.log(`[DEBUG ${this.id}] mesh.${namespace}.${methodCall}(`, JSON.stringify(args), `)`);
                            }

                            return this.askMesh(capability, args, proofs).then(res => {
                                if (!res.ok) {
                                    throw new MeshError(res.error!, res.cid);
                                }
                                return res.value;
                            });
                        };
                    }
                });
            }
        });
    }

    private managedCells = new Map<string, ManagedCell>();
    private cellMonitors = new Map<string, Timer>(); // Health check intervals

    /**
     * Spawn a new cell as a child process.
     * Returns immediately with the managed cell handle.
     * The cell will self-register to the mesh when it comes online.
     */
    async spawn(options: SpawnOptions): Promise<ManagedCell> {
        const { id, command, cwd, env = {}, critical = false, restartDelayMs = 1000, maxRestarts = 5 } = options;

        // Check if already running anywhere on this machine via mesh discovery
        // NEVER read another cell's manifest or inspect its process
        const existing = await this.findCellById(id);
        if (existing) {
            this.log("INFO", `🤝 ${id} already running at ${existing.addr}, observing`);
            return this.observeExisting(id, existing);
        }

        // Actually spawn
        this.log("INFO", `🚀 Spawning ${id}: ${command}`);

        // The child cell manages its OWN logs. We just pipe stdout/stderr to our console
        // for observability while it's our child process. We do NOT create log files for it.
        const proc = spawn(command, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
            shell: true,
            env: {
                ...process.env,
                ...env,
                RHEO_CELL_ID: id,
                RHEO_SEED: this.addr,
                RHEO_PARENT_ADDR: this.addr // Pass parent's mesh address, not PID
            },
            detached: false // If we die, the child dies with us (OS handles this)
        });

        const managed: ManagedCell = {
            id,
            pid: proc.pid!,
            port: 0, // Unknown until cell registers
            addr: "",
            proc,
            status: 'starting',
            startTime: Date.now(),
            restarts: 0,
            stderrBuffer: ""
        };

        this.managedCells.set(id, managed);

        // Pipe output to OUR console for observability while it's our child.
        // The child manages its OWN log files — we don't create them.
        proc.stdout?.on('data', (data: Buffer) => {
            const lines = data.toString().split('\\n').filter(l => l.trim());
            for (const line of lines) {
                this.log("INFO", `[${id}] ${line}`);

                const port = extractPortFromAddr(line);
                if (port && managed.port === 0) {
                    managed.port = port;
                    const host = process.env.RHEO_HOST || 'localhost';
                    managed.addr = createCellAddress('http', host, managed.port).toString();
                    managed.status = 'online';
                    this.log("INFO", `📡 ${id} online at ${managed.addr}`);

                    this.mergeAtlas({
                        [id]: {
                            id, addr: managed.addr, caps: [],
                            pubKey: "", firstSeen: Date.now(),
                            lastSeen: Date.now(), lastGossiped: Date.now(),
                            gossipHopCount: 0, status: 'online'
                        }
                    });
                }
            }
        });

        proc.stderr?.on('data', (data: Buffer) => {
            const lines = data.toString().split('\\n').filter(l => l.trim());
            for (const line of lines) {
                this.log("WARN", `[${id}] ${line}`);
            }
            managed.stderrBuffer = (managed.stderrBuffer + data.toString()).slice(-10000);
        });

        proc.on('exit', (code, signal) => {
            managed.status = code === 0 ? 'stopped' : 'crashed';

            const emoji = signal === 'SIGKILL' ? '💥' : signal ? '🔪' : code === 0 ? '✅' : '❌';
            this.log("INFO", `${emoji} ${id} exited (code ${code}, signal ${signal})`);

            // Remove from managed
            this.managedCells.delete(id);

            // Auto-restart if critical
            if (critical && managed.restarts < maxRestarts) {
                managed.restarts++;
                this.log("INFO", `🔄 Restarting ${id} in ${restartDelayMs}ms (attempt ${managed.restarts}/${maxRestarts})`);
                setTimeout(() => {
                    this.spawn(options).catch(e => this.log("ERROR", `Failed to restart ${id}: ${e.message}`));
                }, restartDelayMs);
            }
        });

        // Health monitor: poll atlas until cell appears
        const monitor = setInterval(async () => {
            if (managed.status === 'online') {
                // Deep health check
                try {
                    const res = await fetch(`${managed.addr}/atlas`, {
                        signal: AbortSignal.timeout(2000)
                    });
                    if (!res.ok) throw new Error("HTTP " + res.status);
                    managed.status = 'online';
                } catch {
                    this.log("WARN", `⚠️ ${id} failed health check. Marking as unresponsive.`);
                    managed.status = 'zombie';
                    // TRUE SOVEREIGNTY: We do NOT kill the process. 
                    // We just mark it unresponsive. The OS or the cell itself handles its fate.
                }
            }
        }, 10000);
        this.cellMonitors.set(id, monitor);

        return managed;
    }

    /**
     * Kill a managed cell by ID.
     */
    public async kill(cellId: string): Promise<boolean> {
        // SOVEREIGNTY: We NEVER perform OS-level process kills.
        // We politely ASK the cell to shut itself down via the mesh protocol.
        // The target cell DECIDES whether to comply — it's sovereign.

        const entry = this.atlas[cellId];
        if (entry) {
            try {
                this.log("INFO", `🛑 Requesting graceful shutdown for ${cellId} via mesh...`);
                await this.askMesh("cell/shutdown" as any, {}, {}, { maxWaitMs: 5000 });
                return true;
            } catch {
                this.log("WARN", `⚠️ Could not reach ${cellId} to request shutdown.`);
                return false;
            }
        }

        this.log("WARN", `⚠️ Cannot request shutdown for ${cellId}: not found in atlas.`);
        return false;
    }

    /**
     * Observe an existing cell. We do NOT adopt its process — it remains sovereign.
     * We just add it to our atlas and optionally subscribe to updates.
     */
    private observeExisting(id: string, existing: { addr: string }): ManagedCell {
        // We create a lightweight handle for observability, NOT ownership
        const managed: ManagedCell = {
            id,
            pid: 0, // We do NOT know or care about the PID
            port: parseInt(existing.addr.split(':').pop() || '0'),
            addr: existing.addr,
            proc: null as any,
            status: 'online',
            startTime: Date.now(),
            restarts: 0,
            stderrBuffer: ""
        };
        this.managedCells.set(id, managed);

        // Pull their atlas and announce ourselves to them (mesh protocol)
        fetch(`${existing.addr}/atlas`)
            .then(r => r.json())
            .then(data => {
                if (data.atlas) this.mergeAtlas(data.atlas, false, 0);
            })
            .catch(() => { });

        // Announce ourselves so they know we're here
        const myEntry = {
            id: this.id,
            addr: this._addr,
            caps: Object.keys(this.handlers),
            pubKey: this.publicKey,
            firstSeen: Date.now(),
            status: 'online' as const,
            lastSeen: Date.now(),
            lastGossiped: Date.now(),
            gossipHopCount: 0
        };
        fetch(`${existing.addr}/announce`, {
            method: "POST",
            body: JSON.stringify(myEntry),
            headers: { "Content-Type": "application/json" }
        }).catch(() => { });

        // NO log tailing — that's the cell's private business.
        // If we spawned it, we already get stdout/stderr via the proc pipes.
        // If we didn't spawn it, we have no right to its logs.

        return managed;
    }

    /**
     * Find a cell by ID using gossip state, then atlas, then a live HTTP probe.
     * NEVER reads another cell's manifest. NEVER inspects PIDs.
     */
    private async findCellById(id: string): Promise<{ addr: string } | null> {
        // 1. Gossip is authoritative
        const gossipEntry = this.gossip.liveAtlas()[id];
        if (gossipEntry?.addr) {
            try {
                const res = await fetch(`${gossipEntry.addr}/gossip/ping`, {
                    signal: AbortSignal.timeout(500)
                });
                if (res.ok) return { addr: gossipEntry.addr };
            } catch { }
        }
        // 2. Fallback to atlas (covers cells not yet in gossip state)
        const atlasEntry = this.atlas[id];
        if (atlasEntry?.addr) {
            try {
                const res = await fetch(`${atlasEntry.addr}/gossip/ping`, {
                    signal: AbortSignal.timeout(500)
                });
                if (res.ok) return { addr: atlasEntry.addr };
            } catch { }
        }
        return null;
    }

    /**
     * Get all cells managed by this cell.
     */
    getManagedCells(): Array<{ id: string; addr: string; status: string; spawned: boolean }> {
        return Array.from(this.managedCells.values()).map(m => ({
            id: m.id,
            addr: m.addr,
            status: m.status,
            spawned: m.proc !== null // true if we created the process
        }));
    }

    /**
     * Get census of ALL cells on this machine (managed or not).
     */
    async localCensus(): Promise<Array<{ id: string, alive: boolean, addr?: string, managed: boolean }>> {
        const results: Array<{ id: string, alive: boolean, addr?: string, managed: boolean }> = [];
        const seen = new Set<string>();

        // Managed cells (ones we spawned — we know about them via proc, not via filesystem)
        for (const [id, m] of this.managedCells) {
            seen.add(id);
            results.push({ id, alive: m.status === 'online', addr: m.addr, managed: true });
        }

        // Gossip-known cells (authoritative membership view)
        for (const [id, r] of Object.entries(this.gossip.liveAtlas())) {
            if (seen.has(id)) continue;
            seen.add(id);
            results.push({ id, alive: r.memberStatus === 'alive', addr: r.addr, managed: false });
        }

        return results;
    }

    private async checkForExistingInstance(): Promise<{ addr: string, port: number } | null> {
        const manifestDir = join(process.cwd(), ".rheo", "manifests");
        const manifestPath = join(manifestDir, `${this.id}.cell.json`);

        if (!existsSync(manifestPath)) return null;

        try {
            const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
            if (!manifest.port) return null;

            if (manifest.pid === process.pid) {
                // We're the ones running now
            }

            try {
                const host = process.env.RHEO_HOST || 'localhost';
                const addr = createCellAddress('http', host, manifest.port).toString();
                const res = await fetch(`${addr}/atlas`, {
                    signal: AbortSignal.timeout(500)
                });
                if (res.ok) {
                    if (manifest.pid && manifest.pid !== process.pid) {
                        return { addr, port: manifest.port };
                    }
                    return { addr, port: manifest.port };
                }
            } catch {
                try { unlinkSync(manifestPath); } catch { }
                return null;
            }
        } catch { }

        return null;
    }

    constructor(public id: string, public port: number = 0, public seed?: string) {
        if (process.env.RHEO_CELL_ID) {
            this.id = process.env.RHEO_CELL_ID;
        } else {
            // FIX: Strip _PID if run manually so cells reuse the same ID and registry file
            this.id = this.id.replace(/_\d+$/, '');
        }

        this.cellDir = process.cwd();

        // 2. LOCAL MANIFESTS: Keep process tracking local to where you run the script
        const manifestDir = join(process.cwd(), ".rheo", "manifests");
        if (!existsSync(manifestDir)) mkdirSync(manifestDir, { recursive: true });
        this.manifestPath = join(manifestDir, `${this.id}.cell.json`);

        // --- IMMORTAL IDENTITY GENERATION (Ed25519) ---
        const IDENTITIES_DIR = process.env.RHEO_IDENTITIES_DIR || join(homedir(), ".rheo", "identities");
        if (!existsSync(IDENTITIES_DIR)) mkdirSync(IDENTITIES_DIR, { recursive: true });

        const identityFile = join(IDENTITIES_DIR, `${this.id}.json`);

        if (existsSync(identityFile)) {
            // Reuse existing identity
            const keys = JSON.parse(readFileSync(identityFile, 'utf8'));
            const { createPrivateKey } = require('node:crypto');
            this.privateKey = createPrivateKey(keys.privateKey);
            this.publicKey = keys.publicKey;
        } else {
            // Generate and save new immortal identity
            const { publicKey, privateKey } = generateKeyPairSync('ed25519');
            this.privateKey = privateKey;
            this.publicKey = publicKey.export({ type: 'spki', format: 'pem' }) as string;

            const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
            writeFileSync(identityFile, JSON.stringify({
                publicKey: this.publicKey,
                privateKey: privPem
            }, null, 2));
        }

        // Log key fingerprint for debugging
        let pubKeyObject: KeyObject;
        if (this.publicKey) {
            pubKeyObject = createPublicKey(this.publicKey);
        } else {
            // Should not happen, but fallback (generate temporary)
            pubKeyObject = generateKeyPairSync('ed25519').publicKey;
        }
        const pubKeyBuffer = pubKeyObject.export({ type: 'spki', format: 'der' });
        const fingerprint = createHash('sha256').update(pubKeyBuffer).digest('hex').substring(0, 16);
        console.log(`[${this.id}] Key fingerprint: ${fingerprint}`);

        // Only reuse port from manifest if explicitly allowed
        const forceRandomPort = process.env.RHEO_FORCE_RANDOM_PORT === "true";

        if (this.port === 0 && existsSync(this.manifestPath) && !forceRandomPort) {
            try {
                const manifestPort = JSON.parse(readFileSync(this.manifestPath, 'utf8')).port;
                // Check if port is likely in use ( heuristic: if manifest is older than 30 seconds, assume stale)
                const manifestStat = statSync(this.manifestPath);
                const manifestAge = Date.now() - manifestStat.mtimeMs;
                if (manifestAge < 30000) {
                    this.port = manifestPort;
                }
            } catch (e) { }
        }

        this.currentVersion = this.calculateVersion();
        this.cleanupGhostProcesses();

        // --- GOSSIP MEMBERSHIP INIT ---
        this.gossip = new GossipRegistry(this.id);
        this.ring = new ConsistentHashRing();

        // --- SOVEREIGN DEFAULTS ---
        this.provide("mesh/ping", () => "PONG");
        this.provide("mesh/gossip", (args: { atlas: Record<string, AtlasEntry> }, ctx: any) => {
            const hopCount = ctx?._hops || 0;
            this.mergeAtlas(args.atlas, true, hopCount);

            return {
                atlas: this.atlas,
                _hops: hopCount + 1
            };
        });
        this.provide("cell/shutdown", this.handleShutdown.bind(this));
        this.provide("cell/inspect", () => ({
            id: this.id, version: this.currentVersion, metrics: this.metrics, capabilities: Object.keys(this.handlers), atlasSize: Object.keys(this.atlas).length
        }));
        this.provide("cell/journal", (args: { limit?: number }) => this.rollingJournal.slice(-(args.limit || 50)));
        this.provide("mesh/directory", () => this.atlas);
        this.provide("mesh/who", (args: { cap: string }) => Object.entries(this.atlas)
            .filter(([_, e]) => e.caps.includes(args.cap))
            .map(([id, e]) => ({ id, addr: e.addr, pubKey: e.pubKey })));

        this.provide("mesh/signal-to-url", async (args: { url: string, payload: any }, ctx: Signal) => {
            const urlObj = new URL(args.url);
            const cap = urlObj.pathname.replace(/^\//, '');
            const signal: Signal = {
                ...ctx, id: randomUUID(), from: this.id, intent: "TELL",
                payload: { capability: cap, args: args.payload },
                _steps: [...(ctx._steps || []), { cell: this.id, timestamp: Date.now(), action: "EMITTING_REACTIVE_SIGNAL", data: { url: args.url } }]
            };
            fetch(args.url, { method: "POST", body: JSON.stringify(signal), headers: { "Content-Type": "application/json" } }).catch(() => { });
            return { sent: true };
        });

        this.provide("cell/debug-atlas", () => ({
            id: this.id,
            addr: this.addr,
            peers: Object.entries(this.atlas).map(([id, e]) => ({
                id,
                addr: e.addr,
                caps: e.caps,
                lastSeenAgeMs: Date.now() - e.lastSeen
            }))
        }));

        this.provide("cell/contract", (args: { cap: string }) => this.contracts.get(args.cap) || null);

        this.provide("cell/spawn", async (args: SpawnOptions) => {
            const managed = await this.spawn(args);
            return { id: managed.id, pid: managed.pid, addr: managed.addr, status: managed.status };
        });

        this.provide("cell/kill", async (args: { id: string }) => {
            const ok = await this.kill(args.id);
            return { ok };
        });

        this.provide("cell/list-managed", () => {
            return this.getManagedCells().map(m => ({
                id: m.id, addr: m.addr, status: m.status, spawned: m.spawned
            }));
        });

        this.provide("cell/census", async () => {
            return this.localCensus();
        });
    }

    /**
     * Call ALL cells providing a capability, not just one
     * Returns when all respond or timeout
     */
    async askAll(capability: string, args: any, timeoutMs = 5000): Promise<MulticastResult> {
        const providers = Object.values(this.atlas)
            .filter(e => e.caps.includes(capability));

        const promises = providers.map(async entry => {
            const start = performance.now();
            try {
                const result = await this.rpc(entry.addr, {
                    id: randomUUID(),
                    from: this.id,
                    intent: "ASK",
                    payload: { capability, args },
                    proofs: {},
                    atlas: this.atlas,
                    trace: [],
                    _steps: []
                } as Signal);

                return {
                    cellId: entry.id || entry.addr,
                    result: result.ok ? result.value : null,
                    error: result.ok ? null : result.error,
                    latency: performance.now() - start
                };
            } catch (e) {
                const error = e as Error;
                return {
                    cellId: entry.id || entry.addr,
                    result: null,
                    error: {
                        code: "TIMEOUT",
                        msg: error.message,
                        from: entry.addr,
                        trace: []
                    },
                    latency: performance.now() - start
                };
            }
        });

        const settled = await Promise.allSettled(promises);

        return {
            results: settled
                .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
                .map(r => r.value)
                .filter(r => !r.error),
            failures: settled
                .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
                .map(r => r.value)
                .filter(r => r.error)
        };
    }

    // --- GOSSIP-BASED DISCOVERY ---

    // Gossip transport: thin fetch wrapper used by GossipRegistry probe/sync loops.
    private readonly _gossipSend = async (addr: string, path: string, body: unknown) => {
        try {
            const res = await fetch(`${addr}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(GossipRegistry.PROBE_TIMEOUT_MS + 200)
            });
            if (res.ok) {
                const data = await res.json().catch(() => null);
                return { ok: true, data };
            }
            return { ok: false };
        } catch {
            return null;
        }
    };

    private registerToRegistry() {
        if (!this.addr) return;
        const record = {
            id: this.id,
            addr: this.addr,
            caps: Object.keys(this.handlers),
            pubKey: this.publicKey,
            firstSeen: this.atlas[this.id]?.firstSeen || Date.now(),
            lastSeen: Date.now(),
            lastGossiped: Date.now(),
            gossipHopCount: 0,
            status: 'online' as const,
        };
        this.gossip.announce(record);
        this.ring.add(this.id);
        // Write bootstrap hint so fresh restarts can find at least one peer address
        this._saveBootstrapHint();
    }

    private markOfflineInRegistry() {
        if (!this.addr) return;
        const record = {
            id: this.id,
            addr: this.addr,
            caps: Object.keys(this.handlers),
            pubKey: this.publicKey,
            firstSeen: this.atlas[this.id]?.firstSeen || Date.now(),
            lastSeen: Date.now(),
            lastGossiped: Date.now(),
            gossipHopCount: 0,
            status: 'offline' as const,
        };
        this.gossip.announceOffline(record);
        this.ring.remove(this.id);
    }

    // Bootstrap: pull gossip state from any reachable peer.
    // Priority: RHEO_BOOTSTRAP_PEERS env > ~/.rheo/registry/peers.json > seed arg.
    // The old per-cell *.json files are no longer written or read.
    public async bootstrapFromRegistry(_forceAll = false) {
        const addrs = this._collectBootstrapAddrs();
        if (addrs.length > 0) {
            await this.gossip.join(addrs);
        }
        // Merge whatever gossip already knows into our atlas
        const live = this.gossip.liveAtlas();
        for (const [id, r] of Object.entries(live)) {
            if (id !== this.id) {
                this.mergeAtlas({ [id]: r as unknown as AtlasEntry }, false, 0);
            }
        }
    }

    private _collectBootstrapAddrs(): string[] {
        const addrs: string[] = [];
        // 1. Explicit env override (works across machines; no seed file needed)
        const envPeers = process.env.RHEO_BOOTSTRAP_PEERS;
        if (envPeers) {
            addrs.push(...envPeers.split(',').map(s => s.trim()).filter(Boolean));
        }
        // 2. Bootstrap hint file written by previous sessions
        const hintFile = join(REGISTRY_DIR, 'peers.json');
        try {
            if (existsSync(hintFile)) {
                const { addrs: saved } = JSON.parse(readFileSync(hintFile, 'utf8')) as { addrs: string[] };
                if (Array.isArray(saved)) addrs.push(...saved);
            }
        } catch { }
        // 3. Seed passed to constructor / connect()
        if (this.seed) addrs.push(this.seed);
        return [...new Set(addrs)];
    }

    // Write the bootstrap hint (just addresses, not full state).
    private _saveBootstrapHint() {
        try {
            const live = Object.values(this.gossip.liveAtlas())
                .filter(r => r.id !== this.id && !r.addr.startsWith('client://'))
                .map(r => r.addr);
            if (live.length === 0) return;
            writeFileSync(join(REGISTRY_DIR, 'peers.json'), JSON.stringify({ addrs: live, updated: Date.now() }));
        } catch { }
    }

    // --- NARRATIVE METHODS ---

    private addStep(cid: string, action: string, data?: any) {
        if (!this.journal[cid]) this.journal[cid] = [];

        // --- DEFENSIVE STRIPPING ---
        // This breaks the circular reference. We record the business data 
        // but throw away the "plumbing" headers (atlas, trace, etc) for this specific log entry.
        let safeData = data;
        if (data && typeof data === 'object' && !Array.isArray(data)) {
            try {
                // Shallow clone the data and remove recursive mesh fields
                const { _steps, atlas, trace, _visitedCellIds, _visitedAddr, ...clean } = data;
                safeData = clean;
            } catch (e) {
                safeData = "[Complex Data - Stripped]";
            }
        }

        const step = {
            cell: this.id,
            timestamp: Date.now(),
            action,
            data: safeData
        };

        this.journal[cid].push(step);

        // PRUNING: Keep history lean to prevent massive network payloads.
        // The Ledger only needs the most relevant recent steps.
        if (this.journal[cid].length > 40) {
            this.journal[cid].shift();
        }

        return step;
    }

    // --- RECURSIVE PROOF METHODS ---

    public signVouch(capPart: string, signalId: string): string {
        const message = Buffer.from(`${signalId}:${capPart}`);
        // For Ed25519, pass undefined as the digest algorithm
        const signature = sign(undefined, message, this.privateKey);
        return signature.toString('hex');
    }

    public verifyVouch(capPart: string, signalId: string, signatureHex: string, pemPubKey: string): boolean {
        try {
            const message = Buffer.from(`${signalId}:${capPart}`);
            const signature = Buffer.from(signatureHex, 'hex');
            const publicKey = createPublicKey(pemPubKey);
            // For Ed25519 verification, also pass undefined
            return verify(undefined, message, publicKey, signature);
        } catch (e) {
            console.error(`[verifyVouch] Error: ${e}`);
            return false;
        }
    }

    // --- LIFECYCLE & TELEMETRY ---

    public log(level: "DEBUG" | "INFO" | "WARN" | "ERROR", msg: string, cid?: string) {
        const timestamp = new Date().toISOString().split('T')[1].split('Z')[0];
        const colors = {
            DEBUG: "\x1b[90m",  // Gray
            INFO: "\x1b[32m",
            WARN: "\x1b[33m",
            ERROR: "\x1b[31m"
        };

        // Filter at runtime based on env
        const minLevel = process.env.RHEO_LOG_LEVEL || "INFO";
        if (!this.shouldLog(level, minLevel)) return;

        const color = colors[level] || colors.INFO;
        console.log(`${color}[${timestamp}] [${level}] [${this.id}]${cid ? ` [${cid.substring(0, 8)}]` : ""} ${msg}\x1b[0m`);
    }

    private shouldLog(msgLevel: string, minLevel: string): boolean {
        const levels = ["DEBUG", "INFO", "WARN", "ERROR"];
        return levels.indexOf(msgLevel) >= levels.indexOf(minLevel);
    }

    private updateMetrics(duration: number, isError: boolean) {
        const now = Date.now();
        if (now - this.metrics.windowStart > 5000) {
            this.metrics.qps = this.metrics.requestCount / 5;
            this.metrics.requestCount = 0; this.metrics.errors = 0; this.metrics.latencySum = 0;
            this.metrics.windowStart = now;
        }
        this.metrics.requestCount++; this.metrics.latencySum += duration;
        if (isError) this.metrics.errors++;
    }

    private calculateVersion(): string {
        try {
            const hash = createHash('sha256');
            hash.update(readFileSync(new URL(import.meta.url).pathname));
            return hash.digest('hex').substring(0, 16);
        } catch (e) { return `v_${Date.now()}`; }
    }

    private cleanupGhostProcesses() {
        if (!existsSync(this.manifestPath)) return;
        try {
            const m = JSON.parse(readFileSync(this.manifestPath, 'utf8'));
            if (m.pid && m.pid !== process.pid) {
                try {
                    if (m.port) {
                        const host = process.env.RHEO_HOST || 'localhost';
                        const addr = createCellAddress('http', host, m.port).toString();
                        fetch(`${addr}/atlas`, {
                            signal: AbortSignal.timeout(300)
                        }).then(res => {
                            if (!res.ok) {
                                try { unlinkSync(this.manifestPath); } catch { }
                            }
                        }).catch(() => {
                            try { unlinkSync(this.manifestPath); } catch { }
                        });
                    }
                } catch {
                    try { unlinkSync(this.manifestPath); } catch { }
                }
            }
        } catch { }
    }

    private saveManifest() {
        if (this.isShuttingDown) return;
        const manifest: CellManifest = {
            pid: process.pid,
            version: this.currentVersion,
            port: this.server?.port || this.port,
            startTime: Date.now(),
            capabilities: Object.keys(this.handlers),
            seed: this.seed,
            pubKey: this.publicKey
        };
        const manifestDir = join(process.cwd(), ".rheo", "manifests");
        if (!existsSync(manifestDir)) mkdirSync(manifestDir, { recursive: true });
        writeFileSync(join(manifestDir, `${this.id}.cell.json`), JSON.stringify(manifest, null, 2));
    }

    private shutdownPhase: 'running' | 'draining' | 'closing' | 'dead' = 'running';

    public async handleShutdown(): Promise<TraceResult> {
        if (this.shutdownPhase !== 'running') {
            return { ok: true, value: { status: this.shutdownPhase }, cid: randomUUID() };
        }

        this.shutdownPhase = 'draining';
        this.isShuttingDown = true;

        PortRegistry.releasePort(this.id);
        this.markOfflineInRegistry();
        this.activeIntervals.forEach(clearInterval);
        this.activeIntervals.length = 0;
        this.log("WARN", "Extinguishing cell...");

        // === PHASE 1: ABORT ALL OUTBOUND FETCHES ===
        // We own these controllers. We abort them. They throw immediately.
        const controllerCount = this.activeControllers.size;
        if (controllerCount > 0) {
            this.log("INFO", `🔪 Aborting ${controllerCount} outbound requests...`);
            for (const [id, ctrl] of this.activeControllers) {
                ctrl.abort();
            }
        }

        // Wake all suspended askMesh discovery-waits so they fail fast instead
        // of blocking drain for the full maxWaitMs (default 30s).
        for (const waiters of this.capabilityWaiters.values()) {
            for (const wakeup of waiters) wakeup();
        }
        this.capabilityWaiters.clear();

        // Run cell-level cleanup hooks (stop external servers, flush state, etc.)
        if (this.cleanupHooks.length > 0) {
            await Promise.allSettled(this.cleanupHooks.map(fn => fn()));
        }

        // === PHASE 2: WAIT FOR IN-FLIGHT HANDLERS ===
        // These are promises WE created in route(). We await them.
        // They will finish naturally (no new signals accepted) or hit our abort.
        const pending = Array.from(this.activeExecutions.values());
        if (pending.length > 0) {
            this.log("INFO", `⏳ Draining ${pending.length} active executions...`);
            await Promise.race([
                Promise.allSettled(pending),
                new Promise(resolve => setTimeout(resolve, 600000)) // 10m hard ceiling
            ]);
        }

        // === PHASE 3: CLOSE SERVER ===
        // Stop accepting new connections. Bun/Node close() waits for in-flight HTTP responses.
        this.shutdownPhase = 'closing';
        if (this.server) {
            this.server.stop(); // Immediate, no await
            // Give in-flight handlers a moment to notice shutdownPhase
            await new Promise(r => setTimeout(r, 500));
        }

        // === PHASE 4: CLEANUP ===
        this.gossip.stop();
        RegistryWatcher.getInstance().destroy();  // no-op stub; kept for safety

        this.shutdownPhase = 'dead';
        this.log("INFO", "💀 Cell extinguished.");

        return { ok: true, value: { status: "extinguished" }, cid: randomUUID() };
    }

    public provide(capability: string, handler: Function) {
        this.handlers[capability] = handler;
        this.saveManifest();
    }

    public provideContract<I, O>(
        contract: Contract,
        handler: (args: I, ctx: Signal) => Promise<O>
    ) {
        this.contracts.set(contract.capability, contract);

        // Här skulle vi kunna lägga till runtime-validering mot contract.inputSchema
        // För nu kör vi "trust but verify" via TypeScript
        this.provide(contract.capability, handler);
    }

    // --- MESH COMMUNICATIONS ---

    /**
   * Ask mesh with exponential backoff retry for discovery.
   * 
   * When a capability isn't found, this will:
   * 1. Retry with exponential backoff (100ms, 200ms, 400ms, 800ms...)
   * 2. Refresh atlas from registry periodically
   * 3. Continue until success or max timeout (default 30s)
   * 
   * This handles the race condition where cells are still registering
   * when the first request comes in.
   */
    // public async askMesh(
    //     capability: string,
    //     args: any = {},
    //     proofs: Record<string, string> = {},
    //     options: {
    //         maxWaitMs?: number;
    //         baseDelayMs?: number;
    //         maxDelayMs?: number;
    //         atlasRefreshIntervalMs?: number;
    //     } = {}
    // ): Promise<TraceResult> {
    //     const {
    //         maxWaitMs = 30000,
    //         baseDelayMs = 100,
    //         maxDelayMs = 5000,
    //         atlasRefreshIntervalMs = 1000
    //     } = options;

    //     const startTime = Date.now();
    //     let attempt = 0;
    //     let lastAtlasRefresh = 0;

    //     while (true) {
    //         const signal: Signal = {
    //             id: randomUUID(),
    //             from: this.id,
    //             intent: "ASK",
    //             payload: { capability, args },
    //             proofs,
    //             atlas: this.atlas,
    //             trace: [],
    //             _steps: []
    //         };

    //         const result = await this.route(signal);

    //         // Success? Return immediately
    //         if (result.ok) {
    //             if (attempt > 0) {
    //                 this.log("INFO", `✅ [${capability}] succeeded after ${attempt + 1} attempts (${Date.now() - startTime}ms)`);
    //             }
    //             return result;
    //         }

    //         // Not a NOT_FOUND error? Don't retry
    //         if (result.error?.code !== "NOT_FOUND") {
    //             return result;
    //         }

    //         // Check timeout
    //         const elapsed = Date.now() - startTime;
    //         if (elapsed >= maxWaitMs) {
    //             this.log("WARN", `⏰ [${capability}] discovery timeout after ${maxWaitMs}ms, ${attempt + 1} attempts`);
    //             return result;
    //         }

    //         // Calculate backoff delay
    //         const delay = Math.min(
    //             baseDelayMs * Math.pow(2, attempt),
    //             maxDelayMs
    //         );

    //         // Check if we should refresh atlas
    //         if (elapsed - lastAtlasRefresh >= atlasRefreshIntervalMs) {
    //             this.log("DEBUG", `🔄 [${capability}] refreshing atlas (attempt ${attempt + 1}, ${elapsed}ms elapsed)`);
    //             await this.bootstrapFromRegistry(true);
    //             lastAtlasRefresh = elapsed;
    //         }

    //         attempt++;
    //         this.log("DEBUG", `⏳ [${capability}] retry ${attempt} in ${delay}ms (${elapsed}ms elapsed)`);

    //         await new Promise(r => setTimeout(r, delay));
    //     }
    // }

    public async askMesh(
        capability: string,
        args: any = {},
        proofs: Record<string, string> = {},
        options: { maxWaitMs?: number } = {}
    ): Promise<TraceResult> {
        const { maxWaitMs = 30000 } = options;

        const signal: Signal = {
            id: randomUUID(),
            from: this.id,
            intent: "ASK",
            payload: { capability, args },
            proofs,
            atlas: this.atlas,
            trace: [],
            _steps: []
        };

        // Try immediately
        let result = await this.route(signal);
        if (result.ok || result.error?.code !== "NOT_FOUND") return result;

        // If not found, check if we know an OFFLINE cell that has it
        const offlineProvider = Object.values(this.atlas).find(e =>
            e.status === 'offline' && e.caps.includes(capability)
        );

        if (offlineProvider) {
            this.log("DEBUG", `[${capability}] Found offline provider ${offlineProvider.id}, attempting to wake...`);
            // Ping it directly to see if it resurrected
            fetch(`${offlineProvider.addr}/atlas`, { method: "POST" }).catch(() => { });
        }

        this.log("INFO", `⏳ Suspending execution. Waiting for [${capability}] to come online...`);

        // Subscribe to the capability and go to sleep
        return new Promise((resolve) => {
            let timeoutId: any;

            const wakeup = async () => {
                clearTimeout(timeoutId);
                const retryResult = await this.route(signal);
                resolve(retryResult);
            };

            if (!this.capabilityWaiters.has(capability)) {
                this.capabilityWaiters.set(capability, []);
            }
            this.capabilityWaiters.get(capability)!.push(wakeup);

            // Timeout fallback
            timeoutId = setTimeout(() => {
                // Remove from waiters
                const waiters = this.capabilityWaiters.get(capability) || [];
                this.capabilityWaiters.set(capability, waiters.filter(w => w !== wakeup));

                resolve(result); // Return the original NOT_FOUND error
            }, maxWaitMs);
        });
    }

    private requestQueue = new Map<string, Promise<TraceResult>>();
    private maxConcurrent = 50;
    private ledger = new NarrativeLedger();

    /**
     * The Logic Engine of the Cell.
     * Responsibility: Deduplication, Loop Prevention, Narrative Tracking, and Execution.
     */
    private async route(signal: Signal): Promise<TraceResult> {
        // REJECT new signals once draining starts
        if (this.shutdownPhase !== 'running') {
            return {
                ok: false,
                cid: signal.id,
                error: {
                    code: "SHUTTING_DOWN",
                    msg: `Cell is ${this.shutdownPhase} and not accepting new signals`,
                    from: this.id,
                    trace: signal.trace || []
                }
            };
        }

        while (this.activeExecutions.size >= this.maxConcurrent) {
            await new Promise(r => setTimeout(r, 10));
        }

        const cid = signal.id;
        const myId = this.id;
        const cap = signal.payload.capability;

        // CLIENT MODE: Can forward but not handle unless explicitly provided
        if (!this.addr && this.mode === 'server' && this.handlers[cap]) {
            const envelope = this.ledger.wrap(signal, myId, "REJECTED_NOT_READY", "Cell has no address");
            const error = {
                code: "NOT_READY",
                msg: "Cell has no address - cannot handle local capabilities",
                from: myId,
                trace: [],
                _envelope: envelope
            };
            return { ok: false, cid, error };
        }

        // --- 1. RESULT CACHE (Idempotency) ---
        if (this.resultCache.has(cid)) {
            return this.resultCache.get(cid)!.result;
        }

        // --- 2. REQUEST JOINING (Deduplication) ---
        if (this.activeExecutions.has(cid)) {
            return this.activeExecutions.get(cid)!;
        }

        // --- 3. LOOP PREVENTION ---
        const visitedIds = signal._visitedCellIds || [];
        if (visitedIds.includes(myId)) {
            const envelope = this.ledger.wrap(signal, myId, "LOOP_DETECTED", "Signal already visited this cell");
            const error = {
                code: "LOOP",
                msg: "Loop detected",
                from: myId,
                trace: signal.trace,
                _envelope: envelope
            };
            return { ok: false, cid, error };
        }

        // --- 4. EXECUTION WRAPPER ---
        const executionPromise = (async (): Promise<TraceResult> => {
            visitedIds.push(myId);

            this.ledger.wrap(signal, myId, "RECEIVED_SIGNAL", { capability: cap });

            if (cap !== 'mesh/gossip' && cap !== 'cell/contract') {
                this.log("DEBUG", `📥 SIGNAL_ARRIVED: [${cap}] from [${signal.from}]`, cid);
            }

            const updatedSignal: Signal = {
                ...signal,
                _visitedCellIds: visitedIds,
                _visitedAddr: [...(signal._visitedAddr || []), this.addr],
                trace: [...(signal.trace || []), `${myId}:${Date.now()}`],
                atlas: { ...this.atlas, ...(signal.atlas || {}) },
                _hops: (signal._hops || 0) + 1
            };

            let result: TraceResult;
            const startTime = performance.now();

            try {
                if (this.handlers[cap]) {
                    this.ledger.wrap(updatedSignal, myId, "LOCAL_HANDLER", { capability: cap });
                    const val = await this.handlers[cap](updatedSignal.payload.args, updatedSignal);
                    result = { ok: true, value: val, cid };
                } else {
                    result = await this.forwardToPeer(updatedSignal, cap, cid);
                }
            } catch (e: any) {
                this.ledger.wrap(updatedSignal, myId, "HANDLER_EXCEPTION", { error: e.message });

                const richError: TraceError = {
                    code: "HANDLER_ERR",
                    msg: e.message,
                    from: myId,
                    trace: updatedSignal.trace,
                    _envelope: this.ledger.entries.get(cid)
                };

                // ONLY print full narrative if we're the origin cell (signal.from === this.id)
                // or if this is the first time we're seeing this error
                const isOrigin = signal.from === this.id;
                const hasBeenPrinted = (signal as any)._errorPrinted;

                if (isOrigin || !hasBeenPrinted) {
                    // ✅ CHANGE: Only print massive narrative if RHEO_DEBUG is on
                    if (process.env.RHEO_DEBUG) {
                        const meshErr = new MeshError(richError, cid);
                        this.log('ERROR', `\n${meshErr.message}`);
                    } else {
                        // Clean one-liner
                        this.log('ERROR', `❌ HANDLER_ERR: [${cap}] - ${e.message}`, cid);
                    }
                    (signal as any)._errorPrinted = true;
                }


                result = { ok: false, cid, error: richError };
            }

            this.updateMetrics(performance.now() - startTime, !result.ok);
            this.resultCache.set(cid, { result, time: Date.now() });
            this.activeExecutions.delete(cid);
            return result;
        })();

        this.activeExecutions.set(cid, executionPromise);

        if (this.resultCache.size > 1000) {
            const now = Date.now();
            for (const [id, entry] of this.resultCache) {
                if (now - entry.time > 10000) this.resultCache.delete(id);
            }
        }

        return executionPromise;
    }

    /**
     * REFACTORED ROUTING ENGINE
     * Strategy: Sequential attempt through 5 layers: Direct -> Failover -> Flood -> Seed -> Registry
     */
    private async forwardToPeer(signal: Signal, cap: string, cid: string): Promise<TraceResult> {
        const trimmedAtlas = this.getTrimmedAtlas(signal);
        const forwardSignal = { ...signal, atlas: trimmedAtlas };

        // 1. Discovery Phase
        const providers = this.getEligibleProviders(cap, signal);

        // 2. Direct Routing Phase (Top Provider)
        if (providers.length > 0) {
            const directResult = await this.attemptDirectRouting(providers, forwardSignal);
            if (directResult && this.isDelivered(directResult)) return directResult;
        }

        // 3. Flood Phase (Broaden search)
        if (this.shouldAttemptFlood(signal, providers)) {
            const floodResult = await this.executeFlooding(signal, trimmedAtlas, providers);
            if (floodResult && this.isDelivered(floodResult)) return floodResult;
        }

        // 4. Seed Phase (Authority Fallback)
        if (this.shouldTrySeed(signal)) {
            const seedResult = await this.attemptSeedFallback(forwardSignal);
            if (this.isDelivered(seedResult)) return seedResult;
        }

        // 5. Registry Phase (Disk Sync & Last Try)
        if (!signal._registryScanned) {
            return await this.syncRegistryAndRetry(signal, cap, cid);
        }

        // 6. Terminal Phase (Failure Analysis)
        return this.handleRouteNotFound(cap, cid, signal, providers.length);
    }

    /** 1. Reduces payload size for P2P hops */
    private getTrimmedAtlas(signal: Signal): Record<string, AtlasEntry> {
        return Object.fromEntries(
            Object.entries(signal.atlas || {})
                .sort(([, a], [, b]) => b.lastSeen - a.lastSeen)
                .slice(0, 20)
        );
    }

    /** 2. Filters atlas for healthy providers of a specific capability */
    private getEligibleProviders(cap: string, signal: Signal): AtlasEntry[] {
        const visitedIds = signal._visitedCellIds || [];
        const myAddr = this.addr;

        return Object.values(this.atlas).filter(entry => {
            const isProvider = entry.caps.includes(cap);
            const isSelf = entry.id === this.id || entry.addr === myAddr;
            const isVisited = visitedIds.includes(entry.id || '');
            const isClient = entry.addr.startsWith('client://');
            return isProvider && !isSelf && !isVisited && !isClient;
        }).sort((a, b) => b.lastSeen - a.lastSeen);
    }

    /** 3. Iterates through the top 3 providers for failover support */
    private async attemptDirectRouting(providers: AtlasEntry[], signal: Signal): Promise<TraceResult | null> {
        for (let i = 0; i < Math.min(providers.length, 3); i++) {
            const target = providers[i];
            const action = i === 0 ? "P2P_ROUTE_ATTEMPT" : "P2P_FAILOVER_ATTEMPT";

            this.ledger.wrap(signal, this.id, action, { target: target.addr, attempt: i + 1 });
            const result = await this.rpc(target.addr, signal);

            if (this.isDelivered(result)) {
                this.ledger.wrap(signal, this.id, "P2P_ROUTE_SUCCESS", { via: target.addr });
                return result;
            }

            this.recordCircuitFailure(target.addr);
        }
        return null;
    }

    /** 4. Determines if a result counts as a successful delivery (inc. idempotency hits) */
    private isDelivered(result: TraceResult | null): boolean {
        if (!result) return false;
        return result.ok ||
            result.error?.code === "DUPLICATE_SIGNAL" ||
            result.error?.code === "DUPLICATE_ARRIVAL";
    }

    /** 5. Logic to prevent infinite flood storms */
    private shouldAttemptFlood(signal: Signal, providers: AtlasEntry[]): boolean {
        return false; // <-- DISABLE FLOODING TEMPORARILY
        // return !signal._floodAttempted;
    }

    /** 6. Orchestrates parallel flooding to non-provider neighbors */
    private async executeFlooding(signal: Signal, atlas: any, providers: AtlasEntry[]): Promise<TraceResult | null> {
        const visitedIds = signal._visitedCellIds || [];
        const neighbors = Object.values(this.atlas)
            .filter(e => e.addr !== this.addr && !visitedIds.includes(e.id || '') && !providers.includes(e))
            .sort(() => 0.5 - Math.random())
            .slice(0, 3);

        if (neighbors.length === 0) return null;

        this.ledger.wrap(signal, this.id, "P2P_FLOOD_START", { neighborCount: neighbors.length });
        const floodSignal = { ...signal, _floodAttempted: true, atlas };

        const floodResults = await Promise.allSettled(neighbors.map(n => this.rpc(n.addr, floodSignal)));

        for (let i = 0; i < floodResults.length; i++) {
            const res = floodResults[i];
            if (res.status === 'fulfilled' && this.isDelivered(res.value)) {
                this.ledger.wrap(signal, this.id, "P2P_FLOOD_SUCCESS", { via: neighbors[i].addr });
                return res.value;
            }
        }
        return null;
    }

    /** 7. Validates if seed contact is appropriate */
    private shouldTrySeed(signal: Signal): boolean {
        return !!this.seed && !(signal._visitedAddr || []).includes(this.seed);
    }

    /** 8. Contacts the seed cell as the ultimate authority */
    private async attemptSeedFallback(signal: Signal): Promise<TraceResult> {
        this.ledger.wrap(signal, this.id, "P2P_SEED_ATTEMPT", { seed: this.seed });
        return await this.rpc(this.seed!, signal);
    }

    /** 9. Performs a hard-sync with disk registry and restarts routing */
    private async syncRegistryAndRetry(signal: Signal, cap: string, cid: string): Promise<TraceResult> {
        this.ledger.wrap(signal, this.id, "REGISTRY_SYNC_RETRY");
        await this.bootstrapFromRegistry(true);
        signal._registryScanned = true;
        return await this.forwardToPeer(signal, cap, cid);
    }

    /** 10. Generates rich diagnostic error when all routes fail */
    private handleRouteNotFound(cap: string, cid: string, signal: Signal, providersChecked: number): TraceResult {
        const allAvailableCaps = Array.from(new Set(Object.values(this.atlas).flatMap(e => e.caps)));

        this.ledger.wrap(signal, this.id, "P2P_NO_ROUTE_FAILURE", {
            capability: cap,
            peersInAtlas: Object.keys(this.atlas).length
        });

        return {
            ok: false,
            cid,
            error: {
                code: "NOT_FOUND",
                msg: `No route to [${cap}]. Checked ${providersChecked} providers. Atlas has ${Object.keys(this.atlas).length} peers.`,
                from: this.id,
                trace: signal.trace || [],
                details: { knownCaps: allAvailableCaps.slice(0, 15) },
                _envelope: this.ledger.entries.get(cid)
            }
        };
    }

    /** Helper: Internal circuit breaker management */
    private recordCircuitFailure(addr: string) {
        const failure = this.failedAddresses.get(addr) || { count: 0, lastFail: 0 };
        failure.count++;
        failure.lastFail = Date.now();
        this.failedAddresses.set(addr, failure);
    }

    private failedAddresses = new Map<string, { count: number, lastFail: number }>();

    // === EXPLICIT RPC LIFECYCLE MANAGEMENT ===
    // Every outbound fetch gets an AbortController that WE own.
    // Shutdown calls abort() on all of them. No praying.

    private activeControllers = new Map<string, AbortController>();

    public async rpc(addr: string, signal: Signal): Promise<TraceResult> {
        const failure = this.failedAddresses.get(addr);
        if (failure && failure.count > 3 && Date.now() - failure.lastFail < 30000) {
            return {
                ok: false, cid: signal.id, error: {
                    code: "CIRCUIT_OPEN",
                    msg: "Circuit breaker open",
                    from: addr,
                    trace: [],
                    _envelope: this.ledger.entries.get(signal.id)
                }
            };
        }

        const cid = signal.id;
        const startTime = performance.now();

        if (signal.payload.capability !== 'mesh/gossip' && signal.payload.capability !== 'cell/contract') {
            this.log("DEBUG", `📡 RPC_OUT: [${signal.payload.capability}] -> ${addr}`, cid);
        }

        this.ledger.wrap(signal, this.id, "RPC_ATTEMPT", {
            target: addr,
            capability: signal.payload.capability,
            payloadSize: JSON.stringify(signal.payload).length
        });

        // Create OUR controller for this fetch. If shutdown fires, we abort this.
        const controller = new AbortController();
        const rpcId = `${cid}:${addr}:${Date.now()}`;
        this.activeControllers.set(rpcId, controller);

        // If already shutting down, abort immediately — don't even start
        if (this.isShuttingDown) {
            controller.abort();
        }

        try {
            const res = await fetch(addr, {
                method: "POST",
                body: JSON.stringify(signal),
                headers: { "Content-Type": "application/json" },
                signal: AbortSignal.any([
                    controller.signal,
                    AbortSignal.timeout(600000)
                ])
            });

            const duration = performance.now() - startTime;

            if (!res.ok) {
                const body = await res.text().catch(() => 'unreadable');
                this.ledger.wrap(signal, this.id, "RPC_HTTP_ERROR", {
                    status: res.status,
                    statusText: res.statusText,
                    body: body.substring(0, 200),
                    duration
                });

                return {
                    ok: false,
                    cid,
                    error: {
                        code: "RPC_HTTP_ERR",
                        msg: `HTTP ${res.status} ${res.statusText} from ${addr}`,
                        details: {
                            httpStatus: res.status,
                            responseBody: body.substring(0, 500),
                            targetAddress: addr,
                            duration: Math.round(duration)
                        },
                        from: addr,
                        trace: signal.trace,
                        _envelope: this.ledger.entries.get(cid)
                    }
                };
            }

            const data = await res.json();

            if (data.atlas) this.mergeAtlas(data.atlas);

            const r = data.result || data;

            if (!r.ok && r.error?._envelope) {
                try {
                    this.ledger.merge(r.error._envelope);
                } catch (mergeErr: any) {
                    this.log("WARN", `Failed to merge narrative: ${mergeErr.message}`, cid);
                }
            }

            if (r.ok && signal.payload.capability !== "mesh/gossip" && signal.payload.capability !== "cell/contract") {
                this.log("INFO", "✅ RPC_SUCCESS: [" + signal.payload.capability + "] from " + addr, cid);
            } else if (!r.ok) {
                const err = r.error as TraceError;
                this.log('ERROR',
                    `❌ RPC_REMOTE_FAIL: [${signal.payload.capability}] @ ${addr} | ${err?.code}: ${err?.msg?.substring(0, 100)}`,
                    cid
                );
            }

            return r;

        } catch (e: any) {
            // Distinguish OUR abort from other errors
            if (controller.signal.aborted && this.isShuttingDown) {
                return {
                    ok: false,
                    cid,
                    error: {
                        code: "SHUTDOWN_ABORT",
                        msg: "Request aborted due to cell shutdown",
                        from: this.id,
                        trace: signal.trace || []
                    }
                };
            }

            const duration = performance.now() - startTime;
            let errorCode = "RPC_FAIL";
            let errorDetails: any = {
                targetAddress: addr,
                duration: Math.round(duration),
                errorType: e.constructor?.name || 'Unknown',
                rawMessage: e.message
            };

            if (e.name === 'AbortError' || e.message?.includes('timeout')) {
                errorCode = "RPC_TIMEOUT";
                errorDetails.reason = "Request timed out";
            } else if (
                e.message?.includes('ECONNREFUSED') ||
                e.message?.includes('fetch failed') ||
                e.message?.includes('Connection refused') ||
                e.message?.includes('Unable to connect')
            ) {
                errorCode = "RPC_UNREACHABLE";
                errorDetails.reason = "Target offline";
                const targetId = Object.entries(this.atlas).find(([_, e]) => e.addr === addr)?.[0] || 'unknown';
                if (targetId !== 'unknown') {
                    const entry = this.atlas[targetId];
                    if (entry && entry.status !== 'offline') {
                        entry.status = 'offline';
                        this.log("WARN", `🔻 Marked ${targetId} as offline`);
                    }
                }
            } else if (e.message?.includes('JSON')) {
                errorCode = "RPC_PARSE_ERR";
                errorDetails.reason = "Invalid JSON response";
            }

            const envelope = this.ledger.entries.get(cid);
            const richError: TraceError = {
                code: errorCode,
                msg: `${errorCode}: ${e.message}`,
                details: errorDetails,
                from: addr,
                trace: signal.trace || [],
                history: envelope?.ancestry?.map((a: any) => ({
                    cell: a.cellId,
                    timestamp: a.timestamp,
                    action: a.action,
                    data: a.signalSnapshot?._steps?.[0]?.data
                })).flat() || [],
                _envelope: envelope
            };

            const isOrigin = signal.from === this.id;
            const hasPrinted = (signal as any)._errorPrinted;
            const isGossipUnreachable = errorCode === "RPC_UNREACHABLE" && signal.payload.capability === 'mesh/gossip';

            if ((isOrigin || !hasPrinted) && !isGossipUnreachable) {
                if (process.env.RHEO_DEBUG) {
                    const meshErr = new MeshError(richError, cid);
                    this.log('ERROR', meshErr.message, cid);
                } else {
                    this.log('ERROR', `❌ ${errorCode}: [${signal.payload.capability}] @ ${addr} - ${e.message}`, cid);
                }
                (signal as any)._errorPrinted = true;
            }

            return { ok: false, cid, error: richError };

        } finally {
            // ALWAYS clean up, no matter what
            this.activeControllers.delete(rpcId);
        }
    }


    /**
 * Create a pipeline that auto-updates when mesh topology changes.
 * Returns a proxy that always points to the latest generated implementation.
 */
    async livePipeline(config: {
        target: string;
        through: string[];
        name: string;
        intervalMs?: number;
    }): Promise<{
        invoke: (args: any) => Promise<any>;
        stop: () => void;
        getHash: () => string;
    }> {
        let currentPipeline: any = null;
        let currentHash = "";

        const stop = await this.watchPipeline({
            ...config,
            onUpdate: (module) => {
                const PipelineClass = Object.values(module).find(
                    (v: any) => v.prototype?.invoke
                ) as any;

                if (PipelineClass) {
                    currentPipeline = new PipelineClass(this);
                }
            }
        });

        return {
            invoke: async (args: any) => {
                if (!currentPipeline) {
                    throw new Error("Pipeline not yet initialized");
                }
                return currentPipeline.invoke(args);
            },
            stop,
            getHash: () => currentHash
        };
    }

    /**
     * Generate an optimized pipeline client from live mesh topology.
     * The generated code is specific to the current cell distribution
     * and can be hot-reloaded when topology changes.
     */
    async pipeline(config: {
        target: string;
        through: string[];
        name?: string;
    }): Promise<{
        code: string;
        filePath: string;
        moduleUrl: string;
        topology: any[];
        hash: string;
    }> {
        const result = await this.askMesh("pipeline/generate", config);

        if (!result.ok) {
            throw new Error(`Pipeline generation failed: ${result.error?.msg || result.error}`);
        }

        return result.value;
    }

    /**
     * Watch for topology changes and auto-regenerate pipeline.
     * Calls onUpdate with the new pipeline module when cells join/leave.
     */
    async watchPipeline(config: {
        target: string;
        through: string[];
        name: string;
        onUpdate: (module: any) => void | Promise<void>;
        intervalMs?: number;
    }): Promise<() => void> {
        const { target, through, name, onUpdate, intervalMs = 5000 } = config;
        let lastHash = "";
        let stopped = false;
        let timeoutId: Timer | null = null;

        const check = async () => {
            if (stopped) return;

            try {
                const result = await this.pipeline({ target, through, name });

                if (result.hash !== lastHash) {
                    lastHash = result.hash;

                    // Hot-import the generated module
                    // @ts-ignore
                    const module = await import(/* @vite-ignore */ result.moduleUrl); // Sketchy... Fuck
                    await onUpdate(module);
                }
            } catch (e) {
                // Log but don't stop watching - mesh might be temporarily unstable
                this.log("WARN", `Pipeline watch error: ${e}`);
            }

            if (!stopped) {
                timeoutId = setTimeout(check, intervalMs);
            }
        };

        // Initial check
        await check();

        // Return stop function
        return () => {
            stopped = true;
            if (timeoutId) clearTimeout(timeoutId);
        };
    }

    private atlasCallbacks: Set<(atlas: Record<string, AtlasEntry>) => void> = new Set();

    public onAtlasUpdate(callback: (atlas: Record<string, AtlasEntry>) => void): () => void {
        this.atlasCallbacks.add(callback);
        return () => this.atlasCallbacks.delete(callback);
    }

    public mergeAtlas(incoming: Record<string, AtlasEntry>, receivedViaGossip = false, hopCount = 0) {
        if (this.isShuttingDown) return;
        let now = Date.now();

        for (const [key, entry] of Object.entries(incoming)) {
            const cellId = entry.id || key;
            if (cellId === this.id) continue;

            // Fix: Use ID as key, but only if the entry is newer or we don't have it
            const existing = this.atlas[cellId];

            // STALENESS CHECK: Ignore entries older than 30 seconds
            if (now - entry.lastSeen > 60000) {
                if (existing && existing.status !== 'offline') {
                    existing.status = 'offline';
                    this.log("DEBUG", `💤 Marked ${cellId} as offline (stale)`);
                }
                continue;
            }

            if (!existing || entry.lastSeen > existing.lastSeen || entry.addr !== existing.addr) {
                // This is a fresh or better entry
                this.atlas[cellId] = {
                    ...entry,
                    lastGossiped: now,
                    gossipHopCount: receivedViaGossip ? Math.min((entry.gossipHopCount || 0) + 1, 3) : 0
                };
            }
        }

        // Track changes for logging - ONLY meaningful changes
        let addedPeers: string[] = [];
        let removedPeers: string[] = [];
        let changedPeers: string[] = []; // caps or addr changed, not just timestamp

        for (const [key, entry] of Object.entries(incoming)) {
            // Determine the actual cell ID
            let cellId: string;

            // If key looks like a URL, extract ID from entry or skip
            if (key.startsWith('http://') || key.startsWith('https://')) {
                cellId = entry.id || '';
                if (!cellId) {
                    // No ID provided with address - use address as ID (not ideal but works)
                    cellId = key;
                }
            } else {
                // Key is already a proper cell ID
                cellId = key;
            }

            if (cellId === this.id) continue;
            if (!cellId) continue;
            if (hopCount > 3) continue;

            const entryAge = now - entry.lastSeen;
            if (entryAge > 30000 && !this.atlas[cellId]) continue;

            const existing = this.atlas[cellId];

            if (receivedViaGossip) {
                const isFreshGossip = entryAge < 10000;
                if (!existing && !isFreshGossip) continue;

                // Check if MEANINGFUL properties changed (not just timestamp)
                const meaningfulChange = !existing ||
                    existing.addr !== entry.addr ||
                    existing.caps.length !== entry.caps.length ||
                    existing.caps.some((c, i) => c !== entry.caps[i]) ||
                    existing.pubKey !== entry.pubKey;

                // Only track as "changed" if meaningful properties differ
                if (!existing) {
                    addedPeers.push(cellId);
                } else if (meaningfulChange) {
                    changedPeers.push(cellId);
                }

                // Merge: keep our direct timestamp if newer, use gossip addr if different
                this.atlas[cellId] = {
                    addr: entry.addr, // Always use latest address
                    caps: entry.caps,
                    pubKey: entry.pubKey,
                    firstSeen: existing?.firstSeen || now,
                    status: 'online',
                    lastSeen: existing && existing.lastSeen > entry.lastSeen
                        ? existing.lastSeen  // Keep our newer direct timestamp
                        : entry.lastSeen,     // Or use theirs if newer
                    lastGossiped: now,  // Always update this (internal bookkeeping)
                    gossipHopCount: Math.min((entry.gossipHopCount || 0) + 1, 3)
                };

                // Wake up any sleeping processes waiting for these capabilities
                if (this.atlas[cellId].status === 'online') {
                    for (const cap of this.atlas[cellId].caps) {
                        if (this.capabilityWaiters.has(cap)) {
                            this.log("INFO", `🔔 Waking up suspended processes waiting for [${cap}]`);
                            const waiters = this.capabilityWaiters.get(cap)!;
                            this.capabilityWaiters.delete(cap);
                            waiters.forEach(w => w());
                        }
                    }
                }
            } else {
                // Direct contact - always authoritative
                const meaningfulChange = !existing ||
                    existing.addr !== entry.addr ||
                    existing.caps.length !== entry.caps.length ||
                    existing.caps.some((c, i) => c !== entry.caps[i]);

                if (!existing) {
                    addedPeers.push(cellId);
                } else if (meaningfulChange) {
                    changedPeers.push(cellId);
                }

                this.atlas[cellId] = {
                    addr: entry.addr,
                    caps: entry.caps,
                    pubKey: entry.pubKey,
                    firstSeen: existing?.firstSeen || now,
                    status: 'online',
                    lastSeen: now,  // Direct contact = fresh
                    lastGossiped: now,
                    gossipHopCount: 0
                };
            }
        }

        // Update self entry (no logging for self)
        const myAddr = this.addr;
        if (myAddr) {
            this.atlas[this.id] = {
                id: this.id,
                addr: myAddr,
                caps: Object.keys(this.handlers),
                pubKey: this.publicKey,
                firstSeen: this.atlas[this.id]?.firstSeen || now,
                status: 'online',
                lastSeen: now,
                lastGossiped: now,
                gossipHopCount: 0
            };
        }

        // Only log if something MEANINGFUL changed
        const hasChanges = addedPeers.length > 0 || changedPeers.length > 0 || removedPeers.length > 0;

        if (hasChanges) {
            const parts: string[] = [];

            if (addedPeers.length > 0) {
                const names = addedPeers.map(id => id.split('_')[0]).join(',');
                parts.push(`+${addedPeers.length}(${names})`);
            }

            if (changedPeers.length > 0) {
                parts.push(`~${changedPeers.length}`);
            }

            if (removedPeers.length > 0) {
                parts.push(`-${removedPeers.length}`);
            }

            const currentPeers = Object.keys(this.atlas).filter(id => id !== this.id).length;
            const currentCaps = new Set(Object.values(this.atlas).flatMap(e => e.caps)).size;

            const changeStr = parts.join(' ');
            this.log("INFO", `🌐 ${changeStr} → ${currentPeers}p/${currentCaps}c`);
        }

        // Notify callbacks only on meaningful changes
        if (addedPeers.length > 0 || changedPeers.length > 0) {
            this.atlasCallbacks.forEach(cb => cb(this.atlas));
        }

        now = Date.now();
        for (const [id, entry] of Object.entries(this.atlas)) {
            if (id === this.id) continue;
            // 60 second timeout -> mark offline, DO NOT delete
            if (entry.status === 'online' && now - entry.lastSeen > 60000) {
                entry.status = 'offline';
                this.log("DEBUG", `💤 Marked inactive cell as offline: ${id}`);
            }
        }
    }

    private async handleRequest(req: Request): Promise<Response> {
        if (this.shutdownPhase !== 'running') {
            return new Response(`Cell is ${this.shutdownPhase}`, { status: 503 });
        }

        // 1. HANDSHAKE
        if (req.url.endsWith('/announce')) {
            try {
                const entry: AtlasEntry = await req.json();
                this.mergeAtlas({ [entry.addr]: entry }, false, 0);
                return new Response("OK");
            } catch (e) {
                return new Response("Bad Request", { status: 400 });
            }
        }

        // 2. GOSSIP PROTOCOL ENDPOINTS
        // /gossip/ping  — SWIM liveness probe (direct)
        // /gossip/pull  — anti-entropy: return our full gossip state
        // /gossip/push  — receive pushed gossip state (push-pull: returns ours)
        // /gossip/probe — indirect probe: we probe `target` on the caller's behalf
        if (req.url.includes('/gossip/')) {
            try {
                if (req.url.endsWith('/gossip/ping')) {
                    return Response.json(this.gossip.handlePing());
                }
                if (req.url.endsWith('/gossip/pull')) {
                    return Response.json({ state: this.gossip.handlePull() });
                }
                if (req.url.endsWith('/gossip/push') && req.method === 'POST') {
                    const { state } = await req.json() as { state: any[] };
                    const reply = this.gossip.receivePush(state);
                    // Merge incoming state into our atlas as well
                    for (const r of state) {
                        if (r?.id && r.memberStatus !== 'dead') {
                            this.mergeAtlas({ [r.id]: r as AtlasEntry }, false, 0);
                        }
                    }
                    return Response.json({ state: reply });
                }
                if (req.url.endsWith('/gossip/probe') && req.method === 'POST') {
                    const { target } = await req.json() as { target: string };
                    const ok = await this.gossip.probeFor(target);
                    return Response.json({ ok });
                }
            } catch {
                return new Response("Bad Request", { status: 400 });
            }
        }

        // 3. REFLECTION
        if (req.url.endsWith('/atlas')) {
            return Response.json({ atlas: this.atlas });
        }

        // 3. PRIMARY MESH ROUTE
        if (req.method === "POST") {
            try {
                const raw: Signal = await req.json();

                if (this.seenNonces.has(raw.id)) {
                    return Response.json({
                        result: { ok: true, value: { _meshStatus: "DUPLICATE_ARRIVAL" }, cid: raw.id }
                        // No atlas on duplicate nonce response
                    });
                }

                if (raw.atlas) this.mergeAtlas(raw.atlas, true, 0);

                const result = await this.route(raw);

                try {
                    const url = new URL(req.url);
                    const wantsAtlas = url.searchParams.has('atlas') || raw.payload?.capability === 'mesh/gossip';
                    return Response.json(wantsAtlas ? { result, atlas: this.atlas } : { result });
                } catch (err) {
                    if (result.error) result.error.history = [];
                    const url = new URL(req.url);
                    const wantsAtlas = url.searchParams.has('atlas') || raw.payload?.capability === 'mesh/gossip';
                    return Response.json(wantsAtlas ? { result, atlas: this.atlas } : { result });
                }
            } catch (e: any) {
                return new Response(JSON.stringify({ error: "INVALID_SIGNAL" }), { status: 400 });
            }
        }

        return new Response("Rheo Mesh Node: Endpoint not found", { status: 404 });
    }

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

        // Bootstrap via gossip pull (any reachable peer will do)
        await this.bootstrapFromRegistry(true);

        // Wire gossip events into atlas (client cells don't run a server-side SWIM loop)
        this.gossip.subscribe((id, record, event) => {
            if (event === 'dead') {
                if (this.atlas[id]) this.atlas[id].status = 'offline';
            } else if (record) {
                this.mergeAtlas({ [id]: record as unknown as AtlasEntry }, false, 0);
            }
        });

        // Register our client presence into the gossip ring
        this.registerToRegistry();

        // Heartbeat: keep our gossip entry fresh
        const heartbeat = setInterval(() => this.registerToRegistry(), 5000);
        this.activeIntervals.push(heartbeat);

        this.log("INFO", `Client cell connected @ ${this._addr}`);
    }


    /**
 * The Cell Interface Layer.
 * Responsibility: Serves the HTTP substrate, handles P2P handshake, 
 * and performs defensive entry-point checks before routing.
 */
    public async listen() {
        // Resolve our public-facing host BEFORE any addr is constructed. If
        // RHEO_HOST is unset we probe metadata/echo endpoints. Without this,
        // every downstream `process.env.RHEO_HOST || 'localhost'` would
        // fall back to localhost on cloud VMs and break gossip routing.
        await resolveCellHost();

        // === GHOST BUSTER (Dead-Man's Switch) ===
        // Voluntary Dead-Man's Switch: If spawned by a parent, we MAY choose to
        // shut down if the parent disappears. But it's OUR choice — sovereignty.
        const parentAddr = process.env.RHEO_PARENT_ADDR;
        if (parentAddr) {
            const watchdog = setInterval(async () => {
                try {
                    // Check parent via mesh protocol (HTTP), not process inspection
                    const res = await fetch(`${parentAddr}/atlas`, {
                        signal: AbortSignal.timeout(1000)
                    });
                    if (!res.ok) throw new Error("Parent not responding");
                } catch (e) {
                    // Parent is gone. We can choose to:
                    // 1. Continue as orphan (sovereign default)
                    // 2. Shut down (if we depend on parent)
                    const orphanMode = process.env.RHEO_ORPHAN_MODE !== 'false';
                    if (orphanMode) {
                        this.log("INFO", `Parent at ${parentAddr} vanished. Continuing as orphan (sovereign mode).`);
                        clearInterval(watchdog);
                        // We keep running. We're sovereign.
                    } else {
                        this.log("WARN", `Parent at ${parentAddr} vanished. Shutting down (dependent mode).`);
                        clearInterval(watchdog);
                        await this.handleShutdown();
                    }
                }
            }, 5000); // Check every 5s (less aggressive)
            this.activeIntervals.push(watchdog);
        }

        // === SOVEREIGN SINGLETON CHECK ===
        const existing = await this.checkForExistingInstance();
        if (existing) {
            console.log(`🤝 ${this.id} already alive at ${existing.addr} (PID ${existing.pid}). Yielding to existing instance.`);
            // DO NOT connect as a client zombie. Just return.
            // By returning immediately, the event loop remains empty and the engine evaporates instantly.
            return;
        }

        let actualPort = this.port;

        if (!bunServe) {
            this.log("WARN", "Native Bun.serve not found. Falling back to Node.js http server...");

            // Use Node.js HTTP server as fallback
            const nodeServer = createServer((req, res) => {
                // Convert Node req to Web API Request
                const chunks: Buffer[] = [];
                req.on('data', chunk => chunks.push(chunk));
                req.on('end', async () => {
                    const body = Buffer.concat(chunks);
                    const host = process.env.RHEO_HOST || 'localhost';
                    const url = `${createCellAddress('http', host, this.port).toString()}${req.url}`;

                    const request = new Request(url, {
                        method: req.method,
                        headers: Object.entries(req.headers).reduce((acc, [k, v]) => {
                            if (v) acc[k] = Array.isArray(v) ? v.join(', ') : v;
                            return acc;
                        }, {} as Record<string, string>),
                        body: body.length > 0 ? body : undefined
                    });

                    try {
                        const response = await this.handleRequest(request);
                        res.statusCode = response.status;
                        response.headers.forEach((value, key) => {
                            res.setHeader(key, value);
                        });
                        const responseBody = await response.text();
                        res.end(responseBody);
                    } catch (e) {
                        res.statusCode = 500;
                        res.end(JSON.stringify({ error: "Internal Server Error" }));
                    }
                });
            });

            nodeServer.listen(this.port, () => {
                const address = nodeServer.address();
                if (address && typeof address === 'object') {
                    this.port = address.port;
                    const host = process.env.RHEO_HOST || 'localhost';
                    this._addr = createCellAddress('http', host, address.port).toString();

                    // Store server for shutdown
                    (this as any).server = {
                        stop: () => nodeServer.close(),
                        port: address.port
                    };

                    this.completeListenSetup();
                }
            });

            return;
        }

        // Use port registry for robust acquisition
        let portResult: { port: number; adopted: boolean; existingAddr?: string };
        try {
            const host = process.env.RHEO_HOST || 'localhost';
            portResult = await PortRegistry.claimPort(this.id, this.port || 0, host);
        } catch (e: any) {
            this.log("ERROR", `Failed to acquire port: ${e.message}`);
            portResult = { port: 0, adopted: false };
        }

        if (portResult.adopted && portResult.existingAddr) {
            // Don't start server - connect to existing instance
            this.port = portResult.port;
            this._addr = portResult.existingAddr;
            this.log("INFO", `🤝 Adopted existing cell at ${this._addr}`);
            this.completeListenSetup();
            return;
        }

        this.port = portResult.port;

        try {
            this.server = bunServe({
                port: this.port,
                fetch: this.handleRequest.bind(this)
            });
            actualPort = this.server.port;
        } catch (e: any) {
            if (e.code === 'EADDRINUSE') {
                // Port registry was wrong, force new search
                this.log("WARN", `Port ${this.port} in use despite registry check, finding alternative...`);
                const host = process.env.RHEO_HOST || 'localhost';
                portResult = await PortRegistry.claimPort(this.id, this.port + 1000, host);
                this.port = portResult.port;
                this.server = bunServe({
                    port: this.port,
                    fetch: this.handleRequest.bind(this)
                });
                actualPort = this.server.port;
            } else { throw e; }
        }

        // --- POST-BOOT INITIALIZATION ---
        this.port = actualPort;
        const host = process.env.RHEO_HOST || 'localhost';
        this._addr = createCellAddress('http', host, actualPort).toString();

        this.completeListenSetup();
    }


    private async connectAsClient() {
        this.mode = 'client';

        // Bootstrap via gossip pull from any reachable peer
        await this.bootstrapFromRegistry(true);

        // Register our presence into gossip
        this.registerToRegistry();

        const heartbeat = setInterval(() => this.registerToRegistry(), 5000);
        this.activeIntervals.push(heartbeat);

        this.log("INFO", `Connected as client @ ${this._addr}`);
    }

    /**
     * Complete the listen setup (shared between Bun and Node paths)
     */
    private completeListenSetup() {
        // Ensure we are the first entry in our own Atlas.
        this.atlas[this.id] = {
            id: this.id, addr: this._addr, caps: Object.keys(this.handlers),
            pubKey: this.publicKey,
            firstSeen: Date.now(),
            status: 'online',
            lastSeen: Date.now(),
            lastGossiped: Date.now(), gossipHopCount: 0
        };

        // --- GOSSIP MEMBERSHIP BOOTSTRAP ---
        this.registerToRegistry();
        this.bootstrapFromRegistry().catch(() => { });

        // Wire gossip membership events into the atlas so routing always has live data.
        this.gossip.subscribe((id, record, event) => {
            if (event === 'dead') {
                if (this.atlas[id]) {
                    this.atlas[id].status = 'offline';
                    this.atlas[id].lastSeen = Date.now();
                }
            } else if (record) {
                this.mergeAtlas({ [id]: record as unknown as AtlasEntry }, false, 0);
                // Keep the consistent hash ring in sync
                if (event === 'joined') this.ring.add(id);
            }
            if (event === 'dead') this.ring.remove(id);
        });

        // Start SWIM probes + anti-entropy sync
        this.gossip.start(this._gossipSend);

        // --- IMMORTAL RESURRECTION PING ---
        // Gossip handles failure detection; this resurrects cells that were offline
        // and came back. We still probe them occasionally via SWIM, but an explicit
        // hour-level check keeps the atlas clean.
        const resurrectionPing = setInterval(() => {
            const now = Date.now();
            const deadCells = Object.values(this.atlas).filter(e =>
                e.status === 'offline' && (now - e.lastSeen > 3600000)
            );
            if (deadCells.length > 0) {
                const target = deadCells[Math.floor(Math.random() * deadCells.length)];
                fetch(`${target.addr}/gossip/ping`, { signal: AbortSignal.timeout(1000) })
                    .catch(() => { });
            }
        }, 60000);
        this.activeIntervals.push(resurrectionPing);

        // Heartbeat: refresh our own gossip entry every 5s
        const heartbeat = setInterval(() => this.registerToRegistry(), 5000);
        this.activeIntervals.push(heartbeat);

        this.log("INFO", `Sovereign Cell online @ ${this._addr}`);
        this.saveManifest();

        process.on("SIGINT", async () => {
            await this.handleShutdown();
            process.exit(0);
        });

        process.on("SIGTERM", async () => {
            await this.handleShutdown();
            process.exit(0);
        });

        // Burst announce to speed up test convergence
        const announce = () => {
            const myEntry: AtlasEntry = {
                id: this.id,
                addr: this._addr,
                caps: Object.keys(this.handlers),
                pubKey: this.publicKey,
                firstSeen: Date.now(),
                status: 'online',
                lastSeen: Date.now(),
                lastGossiped: Date.now(),
                gossipHopCount: 0
            };

            const targets = Object.values(this.atlas)
                .filter(e =>
                    e.addr !== this._addr &&
                    !e.addr.startsWith('client://') // NEW: Don't announce to clients
                )
                .sort(() => 0.5 - Math.random())
                .slice(0, 3);

            targets.forEach(target => {
                fetch(`${target.addr}/announce`, {
                    method: "POST",
                    body: JSON.stringify(myEntry),
                    headers: { "Content-Type": "application/json" }
                }).catch(() => { });
            });
        };

        const gossip = () => {
            const peers = Object.values(this.atlas)
                .filter(e => e.addr !== this._addr)
                .sort(() => 0.5 - Math.random())
                .slice(0, 2);

            peers.forEach(peer => {
                this.rpc(peer.addr, {
                    id: randomUUID(),
                    from: this.id,
                    intent: "ASK",
                    payload: { capability: "mesh/gossip", args: { atlas: this.atlas } },
                    proofs: {},
                    atlas: this.atlas,
                    trace: [],
                    _steps: [],
                    _hops: 0
                } as Signal).catch(() => { });
            });
        };

        const healPartition = () => {
            const peerCount = Object.keys(this.atlas).length - 1;
            if (peerCount < 2 && this.seed) {
                fetch(`${this.seed}/announce`, {
                    method: "POST",
                    body: JSON.stringify({
                        id: this.id,
                        addr: this._addr,
                        caps: Object.keys(this.handlers),
                        pubKey: this.publicKey,
                        lastSeen: Date.now(),
                        lastGossiped: Date.now(),
                        gossipHopCount: 0
                    }),
                    headers: { "Content-Type": "application/json" }
                }).catch(() => { });
            }
        };

        // Burst announce for rapid convergence
        announce();
        setTimeout(announce, 200);
        setTimeout(announce, 500);
        setTimeout(announce, 1000);

        const announceInterval = setInterval(announce, 10000);
        this.activeIntervals.push(announceInterval);

        setTimeout(gossip, 500);
        const gossipInterval = setInterval(gossip, 15000);
        this.activeIntervals.push(gossipInterval);

        const healInterval = setInterval(healPartition, 30000);
        this.activeIntervals.push(healInterval);
    }

    // private async fetchSeedAtlas() {
    //     // Ask seed for its entire atlas immediately
    //     try {
    //         const res = await fetch(`${this.seed}/atlas`, {
    //             method: "POST",
    //             body: JSON.stringify({ requester: this.id }),
    //             headers: { "Content-Type": "application/json" }
    //         });
    //         if (res.ok) {
    //             const { atlas } = await res.json();
    //             this.mergeAtlas(atlas, false, 0); // Direct contact = authoritative
    //         }
    //     } catch (e) {
    //         // Seed not ready yet, will get via normal gossip
    //     }
    // }

    private detectLoopCause(signal: Signal): string {
        const trace = signal.trace || [];
        const ids = trace.map(t => t.split(':')[0]);
        const duplicates = ids.filter((item, index) => ids.indexOf(item) !== index);

        if (duplicates.length > 0) {
            return `Cell(s) ${[...new Set(duplicates)].join(', ')} appear multiple times in path - routing logic may be forwarding back to sender`;
        }

        if (signal.from === this.id) {
            return "Signal 'from' field matches current cell ID - possible self-forwarding";
        }

        return "Unknown - check for duplicate signal generation or stale Atlas entries";
    }
}

// --- 🛡️ NATIVE TYPE SYSTEM (Sovereign Schema) ---

export interface JsonSchema {
    type: string;
    properties?: Record<string, JsonSchema>;
    items?: JsonSchema;
    required?: string[];
    enum?: any[];
}

// En wrapper för att bära både Runtime Schema och Compile-time Type
export class TypeDef<T> {
    constructor(public schema: JsonSchema) { }

    optional(): TypeDef<T | undefined> {
        return new TypeDef({ ...this.schema, _optional: true } as any);
    }
}

// Typ-hjälpare för att extrahera T från TypeDef<T>
export type Infer<T> = T extends TypeDef<infer U> ? U : never;

export const S = {
    string: () => new TypeDef<string>({ type: "string" }),
    number: () => new TypeDef<number>({ type: "number" }),
    boolean: () => new TypeDef<boolean>({ type: "boolean" }),
    any: () => new TypeDef<any>({ type: "object" }), // Fallback

    // Enums
    enum: <U extends string>(values: [U, ...U[]]) =>
        new TypeDef<U>({ type: "string", enum: values }),

    // Arrays
    array: <T>(item: TypeDef<T>) =>
        new TypeDef<T[]>({ type: "array", items: item.schema }),

    // Objects
    object: <T extends Record<string, TypeDef<any>>>(shape: T) => {
        const properties: Record<string, JsonSchema> = {};
        const required: string[] = [];

        for (const [key, def] of Object.entries(shape)) {
            properties[key] = def.schema;
            // Hack: Vi markerar optional internt, standard JSON schema har required-listan
            if (!(def.schema as any)._optional) {
                required.push(key);
            }
        }

        return new TypeDef<{ [K in keyof T]: Infer<typeof shape[K]> }>({
            type: "object",
            properties,
            required
        });
    }
};

/**
 * Helper för att skapa kontrakt utan externa deps
 */
export function createContract<I extends TypeDef<any>, O extends TypeDef<any>>(
    capability: string,
    def: { input: I; output: O }
): Contract {
    return {
        capability,
        version: "1.0.0",
        inputSchema: def.input.schema,
        outputSchema: def.output.schema,
        compatibility: [],
        transport: { protocol: "INTERNAL", adapters: [] }
    };
}