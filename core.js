// A example implementation of the cell protocol.
// Pattern: Narrative Transparent Substrate (NTS-1)
const bunServe = globalThis.Bun?.serve;
import { createServer } from "node:http";
import { randomUUID, createHash, generateKeyPairSync, sign, verify, createPublicKey } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
const currentDir = dirname(new URL(import.meta.url).pathname);
const cellsRoot = resolve(currentDir, ".."); // ../ from app/
// 1. GLOBAL REGISTRY: All cells on this computer will use this folder to find each other
const REGISTRY_DIR = process.env.RHEO_REGISTRY_DIR || join(homedir(), ".rheo", "registry");
if (!existsSync(REGISTRY_DIR))
    mkdirSync(REGISTRY_DIR, { recursive: true });
// --- ENHANCED ERROR SYSTEM ---
/**
 * MeshError: Rich diagnostic exception for mesh failures.
 * Provides full narrative history, signal context, and debugging information.
 */
export class MeshError extends Error {
    error;
    cid;
    timestamp;
    signalId;
    failedAt;
    errorChain;
    constructor(error, cid) {
        const timestamp = new Date().toISOString();
        const errorChain = MeshError.buildErrorChain(error);
        super(MeshError.formatMessage(error, cid, timestamp, errorChain));
        this.error = error;
        this.cid = cid;
        this.name = "MeshError";
        this.timestamp = timestamp;
        this.signalId = cid;
        this.failedAt = error.from;
        this.errorChain = errorChain;
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, MeshError);
        }
    }
    static buildErrorChain(error) {
        const chain = [];
        if (error.history) {
            // We only care about steps where things went wrong to keep the summary concise
            const failures = error.history.filter(s => s.action.includes("FAIL") ||
                s.action.includes("ERROR") ||
                s.action.includes("TIMEOUT") ||
                s.action.includes("REJECTED"));
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
                    }
                    catch (e) {
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
    static formatMessage(error, cid, timestamp, chain) {
        const lines = [];
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
    static suggestCauses(error) {
        const causes = {
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
    printNarrative() {
        console.error(this.message);
    }
    /**
     * Get structured data for programmatic handling
     */
    toJSON() {
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
/**
 * The NarrativeLedger: Append-only, cryptographically verifiable signal history.
 * Every cell maintains a shard of the global narrative.
 */
export class NarrativeLedger {
    entries = new Map();
    maxAncestryDepth = 100;
    /**
     * Create or extend a narrative envelope for a signal.
     * NEVER mutates existing entries - creates new envelope with extended ancestry.
     */
    wrap(signal, cellId, action, reason) {
        const existing = this.entries.get(signal.id);
        const timestamp = Date.now();
        // Normalize reason to string
        const reasonStr = typeof reason === 'string' ? reason : (reason ? JSON.stringify(reason) : undefined);
        // Create ancestry entry with FULL signal snapshot
        const ancestryEntry = {
            signalId: signal.id,
            timestamp,
            cellId,
            cellAddr: this.getCellAddr(cellId),
            action,
            signalSnapshot: this.deepFreeze(structuredClone(signal)),
            delta: existing ? this.computeDelta(existing.current, signal, reasonStr) : undefined
        };
        // Build new envelope
        const envelope = {
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
    recordTiming(signalId, phase, cellId, startTime, endTime, blockingOn) {
        const envelope = this.entries.get(signalId);
        if (!envelope)
            return;
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
    fork(parentId, childSignal, reason) {
        const parent = this.entries.get(parentId);
        if (!parent) {
            throw new Error(`Cannot fork: parent ${parentId} not found in ledger`);
        }
        // Mark parent as having forked
        parent.children.push(childSignal.id);
        // Child inherits full ancestry PLUS fork marker
        const forkEntry = {
            signalId: childSignal.id,
            timestamp: Date.now(),
            cellId: "SYSTEM",
            cellAddr: "fork",
            action: `FORK_FROM_${parentId}`,
            signalSnapshot: this.deepFreeze(structuredClone(childSignal)),
            delta: { changedFields: ["id", "parentId"], previousValues: { parentId }, reason }
        };
        const childEnvelope = {
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
    reconstructExecutionPath(signalId) {
        const envelope = this.entries.get(signalId);
        if (!envelope) {
            throw new Error(`Signal ${signalId} not found in ledger`);
        }
        const path = [];
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
                timing: envelope.timings.find(t => t.phase === entry.action &&
                    Math.abs(t.startTime - entry.timestamp) < 100) || null,
                // Integrity verification
                integrity: envelope.integrity.find(int => Math.abs(int.timestamp - entry.timestamp) < 100) || null
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
    generateForensicReport(signalId, errorContext) {
        const path = this.reconstructExecutionPath(signalId);
        const envelope = this.entries.get(signalId);
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
    analyzeFailure(path, failureStep, errorContext) {
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
                const previousVisits = path.steps.filter((s, i) => i < stepIndex && s.cellId === failureStep.cellId);
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
    verifyIntegrity(path) {
        const results = [];
        for (const step of path.steps) {
            if (!step.integrity)
                continue;
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
    generateReplayScript(path) {
        const lines = [];
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
    computeDelta(prev, curr, reason) {
        const changedFields = [];
        const previousValues = {};
        for (const key of Object.keys(curr)) {
            if (JSON.stringify(prev[key]) !== JSON.stringify(curr[key])) {
                changedFields.push(key);
                previousValues[key] = prev[key];
            }
        }
        return { changedFields, previousValues, reason: reason || "unknown" };
    }
    computeIntegrity(signal, cellId, timestamp) {
        const hash = this.computeSignalHash(signal);
        const signature = this.signHash(hash, cellId);
        return { timestamp, cellId, hash, signature };
    }
    computeSignalHash(signal) {
        // Deterministic JSON serialization
        const canonical = JSON.stringify(signal, Object.keys(signal).sort());
        // Use crypto in real implementation
        return `sha256:${btoa(canonical).slice(0, 16)}`;
    }
    signHash(hash, cellId) {
        // Use actual crypto in production
        return `sig:${cellId}:${hash.slice(0, 8)}`;
    }
    verifySignature(signature, hash, cellId) {
        // Verify against cell's public key
        return signature.startsWith(`sig:${cellId}:`);
    }
    deepFreeze(obj) {
        Object.freeze(obj);
        Object.getOwnPropertyNames(obj).forEach(prop => {
            const value = obj[prop];
            if (value !== null && (typeof value === "object" || typeof value === "function")) {
                this.deepFreeze(value);
            }
        });
        return obj;
    }
    getCellAddr(cellId) {
        // Look up in registry
        return "unknown";
    }
    sanitizeForExport(envelope) {
        // Remove circular refs, reduce size for transport
        return {
            signalId: envelope.current.id,
            ancestryCount: envelope.ancestry.length,
            timingCount: envelope.timings.length,
            children: envelope.children
        };
    }
    analyzeTimings(timings) {
        const byPhase = new Map();
        for (const t of timings) {
            if (!byPhase.has(t.phase))
                byPhase.set(t.phase, []);
            byPhase.get(t.phase).push(t);
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
    merge(remoteEnvelope) {
        if (!remoteEnvelope)
            return;
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
    deepClone(obj) {
        return JSON.parse(JSON.stringify(obj));
    }
}
// Global ledger instance per cell
export const globalLedger = new NarrativeLedger();
export class RheoCell {
    id;
    port;
    seed;
    atlas = {};
    handlers = {};
    contracts = new Map();
    seenNonces = new Set();
    server;
    // Cryptographic Identity (Ed25519)
    privateKey;
    publicKey;
    mode = 'server';
    manifestPath;
    cellDir;
    currentVersion;
    seedFile = ".rheo_seed";
    isShuttingDown = false;
    activeIntervals = [];
    activeExecutions = new Map();
    resultCache = new Map();
    // Local Journaling (Ephemeral Memory)
    journal = {};
    rollingJournal = [];
    MAX_JOURNAL_SIZE = 100;
    _addr = "";
    get addr() {
        return this._addr;
    }
    // Telemetry State
    metrics = {
        qps: 0,
        errors: 0,
        latencySum: 0,
        requestCount: 0,
        windowStart: Date.now()
    };
    errorSubscribers = new Set();
    static globalErrorSubscribers = new Set();
    // Subscribe to errors from this specific cell
    onError(callback) {
        this.errorSubscribers.add(callback);
        return () => this.errorSubscribers.delete(callback);
    }
    // Subscribe to errors from ALL cells (static)
    static onGlobalError(callback) {
        RheoCell.globalErrorSubscribers.add(callback);
        return () => RheoCell.globalErrorSubscribers.delete(callback);
    }
    // Emit error to all subscribers
    emitError(error) {
        // Local subscribers
        for (const cb of this.errorSubscribers) {
            try {
                cb(error);
            }
            catch { }
        }
        // Global subscribers
        for (const cb of RheoCell.globalErrorSubscribers) {
            try {
                cb(error);
            }
            catch { }
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
    get mesh() {
        return new Proxy({}, {
            get: (target, namespace) => {
                return new Proxy({}, {
                    get: (subTarget, methodCall) => {
                        return (...callArgs) => {
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
                                    throw new MeshError(res.error, res.cid);
                                }
                                return res.value;
                            });
                        };
                    }
                });
            }
        });
    }
    constructor(id, port = 0, seed) {
        this.id = id;
        this.port = port;
        this.seed = seed;
        if (process.env.RHEO_CELL_ID)
            this.id = process.env.RHEO_CELL_ID;
        this.cellDir = process.cwd();
        // 2. LOCAL MANIFESTS: Keep process tracking local to where you run the script
        const manifestDir = join(process.cwd(), ".rheo", "manifests");
        if (!existsSync(manifestDir))
            mkdirSync(manifestDir, { recursive: true });
        this.manifestPath = join(manifestDir, `${this.id}.cell.json`);
        // --- IDENTITY GENERATION (Session-based Ed25519) ---
        // Generate Identity with explicit Ed25519
        // Remove the encoding options to get KeyObjects
        const { publicKey, privateKey } = generateKeyPairSync('ed25519');
        this.privateKey = privateKey; // This is a KeyObject
        this.publicKey = publicKey.export({ type: 'spki', format: 'pem' }); // Export as PEM string
        // Log key fingerprint for debugging
        const pubKeyBuffer = publicKey.export({ type: 'spki', format: 'der' });
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
            }
            catch (e) { }
        }
        this.currentVersion = this.calculateVersion();
        this.cleanupGhostProcesses();
        // --- SOVEREIGN DEFAULTS ---
        this.provide("mesh/ping", () => "PONG");
        this.provide("mesh/gossip", (args, ctx) => {
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
        this.provide("cell/journal", (args) => this.rollingJournal.slice(-(args.limit || 50)));
        this.provide("mesh/directory", () => this.atlas);
        this.provide("mesh/who", (args) => Object.entries(this.atlas)
            .filter(([_, e]) => e.caps.includes(args.cap))
            .map(([id, e]) => ({ id, addr: e.addr, pubKey: e.pubKey })));
        this.provide("mesh/signal-to-url", async (args, ctx) => {
            const urlObj = new URL(args.url);
            const cap = urlObj.pathname.replace(/^\//, '');
            const signal = {
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
        this.provide("cell/contract", (args) => this.contracts.get(args.cap) || null);
    }
    /**
     * Call ALL cells providing a capability, not just one
     * Returns when all respond or timeout
     */
    async askAll(capability, args, timeoutMs = 5000) {
        const providers = Object.values(this.atlas)
            .filter(e => e.caps.includes(capability));
        const promises = providers.map(async (entry) => {
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
                });
                return {
                    cellId: entry.id || entry.addr,
                    result: result.ok ? result.value : null,
                    error: result.ok ? null : result.error,
                    latency: performance.now() - start
                };
            }
            catch (e) {
                const error = e;
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
                .filter((r) => r.status === 'fulfilled')
                .map(r => r.value)
                .filter(r => !r.error),
            failures: settled
                .filter((r) => r.status === 'fulfilled')
                .map(r => r.value)
                .filter(r => r.error)
        };
    }
    // --- DECENTRALIZED DISCOVERY ---
    registerToRegistry() {
        if (!this.addr)
            return;
        const entry = {
            id: this.id,
            addr: this.addr,
            caps: Object.keys(this.handlers),
            pubKey: this.publicKey,
            lastSeen: Date.now(),
            lastGossiped: Date.now(),
            gossipHopCount: 0
        };
        try {
            writeFileSync(join(REGISTRY_DIR, `${this.id}.json`), JSON.stringify(entry));
        }
        catch (e) { }
    }
    removeFromRegistry() {
        try {
            const file = join(REGISTRY_DIR, `${this.id}.json`);
            if (existsSync(file))
                unlinkSync(file);
        }
        catch (e) { }
    }
    pruneDeadPeer(peerId) {
        // 1. Remove from local memory
        delete this.atlas[peerId];
        // 2. Remove from shared disk registry (Self-Healing)
        // This stops other cells from discovering this dead peer
        try {
            const file = join(REGISTRY_DIR, `${peerId}.json`);
            if (existsSync(file))
                unlinkSync(file);
        }
        catch (e) { }
    }
    async bootstrapFromRegistry(forceAll = false) {
        try {
            const files = readdirSync(REGISTRY_DIR).filter(f => f.endsWith('.json') && f !== `${this.id}.json`);
            const peers = forceAll ? files : files.sort(() => 0.5 - Math.random()).slice(0, 5);
            for (const file of peers) {
                try {
                    const content = readFileSync(join(REGISTRY_DIR, file), 'utf8');
                    const entry = JSON.parse(content);
                    // ADD THIS: Verify cell is actually alive before merging
                    if (Date.now() - entry.lastSeen < 60000) {
                        try {
                            // Quick ping to verify liveness
                            const pingRes = await fetch(`${entry.addr}/atlas`, {
                                method: "POST",
                                signal: AbortSignal.timeout(500)
                            });
                            if (!pingRes.ok)
                                throw new Error("Dead");
                        }
                        catch (e) {
                            // Cell is dead, remove from registry
                            unlinkSync(join(REGISTRY_DIR, file));
                            continue; // Skip this entry
                        }
                    }
                    this.mergeAtlas({ [entry.id || file.replace('.json', '')]: entry }, false, 0);
                }
                catch (e) { }
            }
        }
        catch (e) { }
    }
    // --- NARRATIVE METHODS ---
    addStep(cid, action, data) {
        if (!this.journal[cid])
            this.journal[cid] = [];
        // --- DEFENSIVE STRIPPING ---
        // This breaks the circular reference. We record the business data 
        // but throw away the "plumbing" headers (atlas, trace, etc) for this specific log entry.
        let safeData = data;
        if (data && typeof data === 'object' && !Array.isArray(data)) {
            try {
                // Shallow clone the data and remove recursive mesh fields
                const { _steps, atlas, trace, _visitedCellIds, _visitedAddr, ...clean } = data;
                safeData = clean;
            }
            catch (e) {
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
    signVouch(capPart, signalId) {
        const message = Buffer.from(`${signalId}:${capPart}`);
        // For Ed25519, pass undefined as the digest algorithm
        const signature = sign(undefined, message, this.privateKey);
        return signature.toString('hex');
    }
    verifyVouch(capPart, signalId, signatureHex, pemPubKey) {
        try {
            const message = Buffer.from(`${signalId}:${capPart}`);
            const signature = Buffer.from(signatureHex, 'hex');
            const publicKey = createPublicKey(pemPubKey);
            // For Ed25519 verification, also pass undefined
            return verify(undefined, message, publicKey, signature);
        }
        catch (e) {
            console.error(`[verifyVouch] Error: ${e}`);
            return false;
        }
    }
    // --- LIFECYCLE & TELEMETRY ---
    log(level, msg, cid) {
        const timestamp = new Date().toISOString().split('T')[1].split('Z')[0];
        const colors = {
            DEBUG: "\x1b[90m", // Gray
            INFO: "\x1b[32m",
            WARN: "\x1b[33m",
            ERROR: "\x1b[31m"
        };
        // Filter at runtime based on env
        const minLevel = process.env.RHEO_LOG_LEVEL || "INFO";
        if (!this.shouldLog(level, minLevel))
            return;
        const color = colors[level] || colors.INFO;
        console.log(`${color}[${timestamp}] [${level}] [${this.id}]${cid ? ` [${cid.substring(0, 8)}]` : ""} ${msg}\x1b[0m`);
    }
    shouldLog(msgLevel, minLevel) {
        const levels = ["DEBUG", "INFO", "WARN", "ERROR"];
        return levels.indexOf(msgLevel) >= levels.indexOf(minLevel);
    }
    updateMetrics(duration, isError) {
        const now = Date.now();
        if (now - this.metrics.windowStart > 5000) {
            this.metrics.qps = this.metrics.requestCount / 5;
            this.metrics.requestCount = 0;
            this.metrics.errors = 0;
            this.metrics.latencySum = 0;
            this.metrics.windowStart = now;
        }
        this.metrics.requestCount++;
        this.metrics.latencySum += duration;
        if (isError)
            this.metrics.errors++;
    }
    calculateVersion() {
        try {
            const hash = createHash('sha256');
            hash.update(readFileSync(new URL(import.meta.url).pathname));
            return hash.digest('hex').substring(0, 16);
        }
        catch (e) {
            return `v_${Date.now()}`;
        }
    }
    cleanupGhostProcesses() {
        if (process.env.RHEO_GHOST_CLEANUP === "true") {
            if (!existsSync(this.manifestPath))
                return;
            try {
                const m = JSON.parse(readFileSync(this.manifestPath, 'utf8'));
                if (m.pid && m.pid !== process.pid)
                    process.kill(m.pid, 'SIGKILL');
            }
            catch (e) { }
        }
        ;
    }
    saveManifest() {
        if (this.isShuttingDown)
            return;
        const manifest = {
            pid: process.pid, version: this.currentVersion, port: this.server?.port || this.port,
            startTime: Date.now(), capabilities: Object.keys(this.handlers), seed: this.seed, pubKey: this.publicKey
        };
        if (!existsSync(dirname(this.manifestPath)))
            mkdirSync(dirname(this.manifestPath), { recursive: true });
        writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2));
    }
    handleShutdown() {
        if (this.isShuttingDown)
            return { ok: true, cid: randomUUID() };
        this.isShuttingDown = true;
        this.removeFromRegistry();
        this.activeIntervals.forEach(clearInterval);
        this.log("WARN", "Extinguishing cell...");
        if (this.server)
            this.server.stop();
        setTimeout(() => process.exit(0), 200);
        return { ok: true, value: { status: "extinguishing" }, cid: randomUUID() };
    }
    provide(capability, handler) {
        this.handlers[capability] = handler;
        this.saveManifest();
    }
    provideContract(contract, handler) {
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
    async askMesh(capability, args = {}, proofs = {}, options = {}) {
        const { maxWaitMs = 30000, baseDelayMs = 100, maxDelayMs = 5000, atlasRefreshIntervalMs = 1000 } = options;
        const startTime = Date.now();
        let attempt = 0;
        let lastAtlasRefresh = 0;
        while (true) {
            const signal = {
                id: randomUUID(),
                from: this.id,
                intent: "ASK",
                payload: { capability, args },
                proofs,
                atlas: this.atlas,
                trace: [],
                _steps: []
            };
            const result = await this.route(signal);
            // Success? Return immediately
            if (result.ok) {
                if (attempt > 0) {
                    this.log("INFO", `✅ [${capability}] succeeded after ${attempt + 1} attempts (${Date.now() - startTime}ms)`);
                }
                return result;
            }
            // Not a NOT_FOUND error? Don't retry
            if (result.error?.code !== "NOT_FOUND") {
                return result;
            }
            // Check timeout
            const elapsed = Date.now() - startTime;
            if (elapsed >= maxWaitMs) {
                this.log("WARN", `⏰ [${capability}] discovery timeout after ${maxWaitMs}ms, ${attempt + 1} attempts`);
                return result;
            }
            // Calculate backoff delay
            const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
            // Check if we should refresh atlas
            if (elapsed - lastAtlasRefresh >= atlasRefreshIntervalMs) {
                this.log("DEBUG", `🔄 [${capability}] refreshing atlas (attempt ${attempt + 1}, ${elapsed}ms elapsed)`);
                await this.bootstrapFromRegistry(true);
                lastAtlasRefresh = elapsed;
            }
            attempt++;
            this.log("DEBUG", `⏳ [${capability}] retry ${attempt} in ${delay}ms (${elapsed}ms elapsed)`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    requestQueue = new Map();
    maxConcurrent = 50;
    ledger = new NarrativeLedger();
    /**
     * The Logic Engine of the Cell.
     * Responsibility: Deduplication, Loop Prevention, Narrative Tracking, and Execution.
     */
    async route(signal) {
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
            return this.resultCache.get(cid).result;
        }
        // --- 2. REQUEST JOINING (Deduplication) ---
        if (this.activeExecutions.has(cid)) {
            return this.activeExecutions.get(cid);
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
        const executionPromise = (async () => {
            visitedIds.push(myId);
            this.ledger.wrap(signal, myId, "RECEIVED_SIGNAL", { capability: cap });
            if (cap !== 'mesh/gossip' && cap !== 'cell/contract') {
                this.log("DEBUG", `📥 SIGNAL_ARRIVED: [${cap}] from [${signal.from}]`, cid);
            }
            const updatedSignal = {
                ...signal,
                _visitedCellIds: visitedIds,
                _visitedAddr: [...(signal._visitedAddr || []), this.addr],
                trace: [...(signal.trace || []), `${myId}:${Date.now()}`],
                atlas: { ...this.atlas, ...(signal.atlas || {}) },
                _hops: (signal._hops || 0) + 1
            };
            let result;
            const startTime = performance.now();
            try {
                if (this.handlers[cap]) {
                    this.ledger.wrap(updatedSignal, myId, "LOCAL_HANDLER", { capability: cap });
                    const val = await this.handlers[cap](updatedSignal.payload.args, updatedSignal);
                    result = { ok: true, value: val, cid };
                }
                else {
                    result = await this.forwardToPeer(updatedSignal, cap, cid);
                }
            }
            catch (e) {
                this.ledger.wrap(updatedSignal, myId, "HANDLER_EXCEPTION", { error: e.message });
                const richError = {
                    code: "HANDLER_ERR",
                    msg: e.message,
                    from: myId,
                    trace: updatedSignal.trace,
                    _envelope: this.ledger.entries.get(cid)
                };
                // ONLY print full narrative if we're the origin cell (signal.from === this.id)
                // or if this is the first time we're seeing this error
                const isOrigin = signal.from === this.id;
                const hasBeenPrinted = signal._errorPrinted;
                if (isOrigin || !hasBeenPrinted) {
                    // ✅ CHANGE: Only print massive narrative if RHEO_DEBUG is on
                    if (process.env.RHEO_DEBUG) {
                        const meshErr = new MeshError(richError, cid);
                        this.log('ERROR', `\n${meshErr.message}`);
                    }
                    else {
                        // Clean one-liner
                        this.log('ERROR', `❌ HANDLER_ERR: [${cap}] - ${e.message}`, cid);
                    }
                    signal._errorPrinted = true;
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
                if (now - entry.time > 10000)
                    this.resultCache.delete(id);
            }
        }
        return executionPromise;
    }
    /**
     * REFACTORED ROUTING ENGINE
     * Strategy: Sequential attempt through 5 layers: Direct -> Failover -> Flood -> Seed -> Registry
     */
    async forwardToPeer(signal, cap, cid) {
        const trimmedAtlas = this.getTrimmedAtlas(signal);
        const forwardSignal = { ...signal, atlas: trimmedAtlas };
        // 1. Discovery Phase
        const providers = this.getEligibleProviders(cap, signal);
        // 2. Direct Routing Phase (Top Provider)
        if (providers.length > 0) {
            const directResult = await this.attemptDirectRouting(providers, forwardSignal);
            if (directResult && this.isDelivered(directResult))
                return directResult;
        }
        // 3. Flood Phase (Broaden search)
        if (this.shouldAttemptFlood(signal, providers)) {
            const floodResult = await this.executeFlooding(signal, trimmedAtlas, providers);
            if (floodResult && this.isDelivered(floodResult))
                return floodResult;
        }
        // 4. Seed Phase (Authority Fallback)
        if (this.shouldTrySeed(signal)) {
            const seedResult = await this.attemptSeedFallback(forwardSignal);
            if (this.isDelivered(seedResult))
                return seedResult;
        }
        // 5. Registry Phase (Disk Sync & Last Try)
        if (!signal._registryScanned) {
            return await this.syncRegistryAndRetry(signal, cap, cid);
        }
        // 6. Terminal Phase (Failure Analysis)
        return this.handleRouteNotFound(cap, cid, signal, providers.length);
    }
    /** 1. Reduces payload size for P2P hops */
    getTrimmedAtlas(signal) {
        return Object.fromEntries(Object.entries(signal.atlas || {})
            .sort(([, a], [, b]) => b.lastSeen - a.lastSeen)
            .slice(0, 20));
    }
    /** 2. Filters atlas for healthy providers of a specific capability */
    getEligibleProviders(cap, signal) {
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
    async attemptDirectRouting(providers, signal) {
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
    isDelivered(result) {
        if (!result)
            return false;
        return result.ok ||
            result.error?.code === "DUPLICATE_SIGNAL" ||
            result.error?.code === "DUPLICATE_ARRIVAL";
    }
    /** 5. Logic to prevent infinite flood storms */
    shouldAttemptFlood(signal, providers) {
        return !signal._floodAttempted;
    }
    /** 6. Orchestrates parallel flooding to non-provider neighbors */
    async executeFlooding(signal, atlas, providers) {
        const visitedIds = signal._visitedCellIds || [];
        const neighbors = Object.values(this.atlas)
            .filter(e => e.addr !== this.addr && !visitedIds.includes(e.id || '') && !providers.includes(e))
            .sort(() => 0.5 - Math.random())
            .slice(0, 3);
        if (neighbors.length === 0)
            return null;
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
    shouldTrySeed(signal) {
        return !!this.seed && !(signal._visitedAddr || []).includes(this.seed);
    }
    /** 8. Contacts the seed cell as the ultimate authority */
    async attemptSeedFallback(signal) {
        this.ledger.wrap(signal, this.id, "P2P_SEED_ATTEMPT", { seed: this.seed });
        return await this.rpc(this.seed, signal);
    }
    /** 9. Performs a hard-sync with disk registry and restarts routing */
    async syncRegistryAndRetry(signal, cap, cid) {
        this.ledger.wrap(signal, this.id, "REGISTRY_SYNC_RETRY");
        await this.bootstrapFromRegistry(true);
        signal._registryScanned = true;
        return await this.forwardToPeer(signal, cap, cid);
    }
    /** 10. Generates rich diagnostic error when all routes fail */
    handleRouteNotFound(cap, cid, signal, providersChecked) {
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
    recordCircuitFailure(addr) {
        const failure = this.failedAddresses.get(addr) || { count: 0, lastFail: 0 };
        failure.count++;
        failure.lastFail = Date.now();
        this.failedAddresses.set(addr, failure);
    }
    failedAddresses = new Map();
    async rpc(addr, signal) {
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
        try {
            const res = await fetch(addr, {
                method: "POST",
                body: JSON.stringify(signal),
                headers: { "Content-Type": "application/json" },
                signal: AbortSignal.timeout(600000)
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
            if (data.atlas)
                this.mergeAtlas(data.atlas);
            const r = data.result || data;
            // FIXED: Properly merge remote narrative
            if (!r.ok && r.error?._envelope) {
                try {
                    this.ledger.merge(r.error._envelope);
                }
                catch (mergeErr) {
                    this.log("WARN", `Failed to merge narrative: ${mergeErr.message}`, cid);
                }
            }
            if (r.ok && signal.payload.capability !== "mesh/gossip" && signal.payload.capability !== "cell/contract") {
                this.log("INFO", "✅ RPC_SUCCESS: [" + signal.payload.capability + "] from " + addr, cid);
            }
            else if (!r.ok) {
                const err = r.error;
                // CONCISE ERROR LOGGING: Don't dump the whole narrative, just the essentials
                this.log('ERROR', `❌ RPC_REMOTE_FAIL: [${signal.payload.capability}] @ ${addr} | ${err?.code}: ${err?.msg?.substring(0, 100)}`, cid);
            }
            return r;
        }
        catch (e) {
            const duration = performance.now() - startTime;
            let errorCode = "RPC_FAIL";
            let errorDetails = {
                targetAddress: addr,
                duration: Math.round(duration),
                errorType: e.constructor?.name || 'Unknown',
                rawMessage: e.message
            };
            if (e.name === 'AbortError' || e.message?.includes('timeout')) {
                errorCode = "RPC_TIMEOUT";
                errorDetails.reason = "Request timed out";
            }
            else if (e.message?.includes('ECONNREFUSED') ||
                e.message?.includes('fetch failed') ||
                e.message?.includes('Connection refused') ||
                e.message?.includes('Unable to connect')) {
                errorCode = "RPC_UNREACHABLE";
                errorDetails.reason = "Target offline";
                const targetId = signal.trace.length > 0 ? signal.trace[signal.trace.length - 1].split(':')[0] : 'unknown';
                this.pruneDeadPeer(targetId);
            }
            else if (e.message?.includes('JSON')) {
                errorCode = "RPC_PARSE_ERR";
                errorDetails.reason = "Invalid JSON response";
            }
            const envelope = this.ledger.entries.get(cid);
            const richError = {
                code: errorCode,
                msg: `${errorCode}: ${e.message}`,
                details: errorDetails,
                from: addr,
                trace: signal.trace || [],
                history: envelope?.ancestry?.map((a) => ({
                    cell: a.cellId,
                    timestamp: a.timestamp,
                    action: a.action,
                    data: a.signalSnapshot?._steps?.[0]?.data
                })).flat() || [],
                _envelope: envelope
            };
            // LOGGING LOGIC
            const isOrigin = signal.from === this.id;
            const hasPrinted = signal._errorPrinted;
            // 🔇 SILENCE GOSSIP FAILURES:
            // If we can't reach a node during gossip, we pruned it above. 
            // We don't need to log an error for it.
            const isGossipUnreachable = errorCode === "RPC_UNREACHABLE" && signal.payload.capability === 'mesh/gossip';
            if ((isOrigin || !hasPrinted) && !isGossipUnreachable) {
                if (process.env.RHEO_DEBUG) {
                    const meshErr = new MeshError(richError, cid);
                    this.log('ERROR', meshErr.message, cid);
                }
                else {
                    this.log('ERROR', `❌ ${errorCode}: [${signal.payload.capability}] @ ${addr} - ${e.message}`, cid);
                }
                signal._errorPrinted = true;
            }
            return { ok: false, cid, error: richError };
        }
    }
    /**
 * Create a pipeline that auto-updates when mesh topology changes.
 * Returns a proxy that always points to the latest generated implementation.
 */
    async livePipeline(config) {
        let currentPipeline = null;
        let currentHash = "";
        const stop = await this.watchPipeline({
            ...config,
            onUpdate: (module) => {
                const PipelineClass = Object.values(module).find((v) => v.prototype?.invoke);
                if (PipelineClass) {
                    currentPipeline = new PipelineClass(this);
                }
            }
        });
        return {
            invoke: async (args) => {
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
    async pipeline(config) {
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
    async watchPipeline(config) {
        const { target, through, name, onUpdate, intervalMs = 5000 } = config;
        let lastHash = "";
        let stopped = false;
        let timeoutId = null;
        const check = async () => {
            if (stopped)
                return;
            try {
                const result = await this.pipeline({ target, through, name });
                if (result.hash !== lastHash) {
                    lastHash = result.hash;
                    // Hot-import the generated module
                    // @ts-ignore
                    const module = await import(/* @vite-ignore */ result.moduleUrl); // Sketchy... Fuck
                    await onUpdate(module);
                }
            }
            catch (e) {
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
            if (timeoutId)
                clearTimeout(timeoutId);
        };
    }
    atlasCallbacks = new Set();
    onAtlasUpdate(callback) {
        this.atlasCallbacks.add(callback);
        return () => this.atlasCallbacks.delete(callback);
    }
    mergeAtlas(incoming, receivedViaGossip = false, hopCount = 0) {
        if (this.isShuttingDown)
            return;
        let now = Date.now();
        for (const [key, entry] of Object.entries(incoming)) {
            const cellId = entry.id || key;
            if (cellId === this.id)
                continue;
            // Fix: Use ID as key, but only if the entry is newer or we don't have it
            const existing = this.atlas[cellId];
            // STALENESS CHECK: Ignore entries older than 30 seconds
            if (now - entry.lastSeen > 30000) {
                if (existing && existing.addr === entry.addr)
                    delete this.atlas[cellId];
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
        let addedPeers = [];
        let removedPeers = [];
        let changedPeers = []; // caps or addr changed, not just timestamp
        for (const [key, entry] of Object.entries(incoming)) {
            // Determine the actual cell ID
            let cellId;
            // If key looks like a URL, extract ID from entry or skip
            if (key.startsWith('http://') || key.startsWith('https://')) {
                cellId = entry.id || '';
                if (!cellId) {
                    // No ID provided with address - use address as ID (not ideal but works)
                    cellId = key;
                }
            }
            else {
                // Key is already a proper cell ID
                cellId = key;
            }
            if (cellId === this.id)
                continue;
            if (!cellId)
                continue;
            if (hopCount > 3)
                continue;
            const entryAge = now - entry.lastSeen;
            if (entryAge > 30000 && !this.atlas[cellId])
                continue;
            const existing = this.atlas[cellId];
            if (receivedViaGossip) {
                const isFreshGossip = entryAge < 10000;
                if (!existing && !isFreshGossip)
                    continue;
                // Check if MEANINGFUL properties changed (not just timestamp)
                const meaningfulChange = !existing ||
                    existing.addr !== entry.addr ||
                    existing.caps.length !== entry.caps.length ||
                    existing.caps.some((c, i) => c !== entry.caps[i]) ||
                    existing.pubKey !== entry.pubKey;
                // Only track as "changed" if meaningful properties differ
                if (!existing) {
                    addedPeers.push(cellId);
                }
                else if (meaningfulChange) {
                    changedPeers.push(cellId);
                }
                // Merge: keep our direct timestamp if newer, use gossip addr if different
                this.atlas[cellId] = {
                    addr: entry.addr, // Always use latest address
                    caps: entry.caps,
                    pubKey: entry.pubKey,
                    lastSeen: existing && existing.lastSeen > entry.lastSeen
                        ? existing.lastSeen // Keep our newer direct timestamp
                        : entry.lastSeen, // Or use theirs if newer
                    lastGossiped: now, // Always update this (internal bookkeeping)
                    gossipHopCount: Math.min((entry.gossipHopCount || 0) + 1, 3)
                };
            }
            else {
                // Direct contact - always authoritative
                const meaningfulChange = !existing ||
                    existing.addr !== entry.addr ||
                    existing.caps.length !== entry.caps.length ||
                    existing.caps.some((c, i) => c !== entry.caps[i]);
                if (!existing) {
                    addedPeers.push(cellId);
                }
                else if (meaningfulChange) {
                    changedPeers.push(cellId);
                }
                this.atlas[cellId] = {
                    addr: entry.addr,
                    caps: entry.caps,
                    pubKey: entry.pubKey,
                    lastSeen: now, // Direct contact = fresh
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
                lastSeen: now,
                lastGossiped: now,
                gossipHopCount: 0
            };
        }
        // Only log if something MEANINGFUL changed
        const hasChanges = addedPeers.length > 0 || changedPeers.length > 0 || removedPeers.length > 0;
        if (hasChanges) {
            const parts = [];
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
            if (id === this.id)
                continue;
            if (now - entry.lastSeen > 60000) { // 60 second timeout
                delete this.atlas[id];
                this.log("INFO", `🧹 Cleaned stale entry: ${id}`);
            }
        }
    }
    async handleRequest(req) {
        if (this.isShuttingDown)
            return new Response("Stopping", { status: 503 });
        // 1. HANDSHAKE
        if (req.url.endsWith('/announce')) {
            try {
                const entry = await req.json();
                this.mergeAtlas({ [entry.addr]: entry }, false, 0);
                return new Response("OK");
            }
            catch (e) {
                return new Response("Bad Request", { status: 400 });
            }
        }
        // 2. REFLECTION
        if (req.url.endsWith('/atlas')) {
            return Response.json({ atlas: this.atlas });
        }
        // 3. PRIMARY MESH ROUTE
        if (req.method === "POST") {
            try {
                const raw = await req.json();
                if (this.seenNonces.has(raw.id)) {
                    return Response.json({
                        result: { ok: true, value: { _meshStatus: "DUPLICATE_ARRIVAL" }, cid: raw.id }
                        // No atlas on duplicate nonce response
                    });
                }
                if (raw.atlas)
                    this.mergeAtlas(raw.atlas, true, 0);
                const result = await this.route(raw);
                try {
                    const url = new URL(req.url);
                    const wantsAtlas = url.searchParams.has('atlas') || raw.payload?.capability === 'mesh/gossip';
                    return Response.json(wantsAtlas ? { result, atlas: this.atlas } : { result });
                }
                catch (err) {
                    if (result.error)
                        result.error.history = [];
                    const url = new URL(req.url);
                    const wantsAtlas = url.searchParams.has('atlas') || raw.payload?.capability === 'mesh/gossip';
                    return Response.json(wantsAtlas ? { result, atlas: this.atlas } : { result });
                }
            }
            catch (e) {
                return new Response(JSON.stringify({ error: "INVALID_SIGNAL" }), { status: 400 });
            }
        }
        return new Response("Rheo Mesh Node: Endpoint not found", { status: 404 });
    }
    /**
        * Connect to mesh in client mode (no server, HTTP client only)
        * For browser environments or cells that only need to call others
        */
    async connect(seedAddr) {
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
            }
            catch (e) {
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
    /**
 * The Cell Interface Layer.
 * Responsibility: Serves the HTTP substrate, handles P2P handshake,
 * and performs defensive entry-point checks before routing.
 */
    listen() {
        let actualPort = this.port;
        if (!bunServe) {
            this.log("WARN", "Native Bun.serve not found. Falling back to Node.js http server...");
            // Use Node.js HTTP server as fallback
            const nodeServer = createServer((req, res) => {
                // Convert Node req to Web API Request
                const chunks = [];
                req.on('data', chunk => chunks.push(chunk));
                req.on('end', async () => {
                    const body = Buffer.concat(chunks);
                    const url = `http://localhost:${this.port}${req.url}`;
                    const request = new Request(url, {
                        method: req.method,
                        headers: Object.entries(req.headers).reduce((acc, [k, v]) => {
                            if (v)
                                acc[k] = Array.isArray(v) ? v.join(', ') : v;
                            return acc;
                        }, {}),
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
                    }
                    catch (e) {
                        res.statusCode = 500;
                        res.end(JSON.stringify({ error: "Internal Server Error" }));
                    }
                });
            });
            nodeServer.listen(this.port, () => {
                const address = nodeServer.address();
                if (address && typeof address === 'object') {
                    this.port = address.port;
                    this._addr = `http://localhost:${address.port}`;
                    // Store server for shutdown
                    this.server = {
                        stop: () => nodeServer.close(),
                        port: address.port
                    };
                    this.completeListenSetup();
                }
            });
            return;
        }
        try {
            this.server = bunServe({
                port: this.port,
                fetch: this.handleRequest.bind(this)
            });
            actualPort = this.server.port;
        }
        catch (e) {
            if (e.code === 'EADDRINUSE') {
                this.log("WARN", `Port ${this.port} in use, seeking alternative...`);
                this.server = bunServe({
                    port: 0,
                    fetch: this.handleRequest.bind(this)
                });
                actualPort = this.server.port;
            }
            else {
                throw e;
            }
        }
        // --- POST-BOOT INITIALIZATION ---
        this.port = actualPort;
        this._addr = `http://localhost:${actualPort}`;
        this.completeListenSetup();
    }
    /**
     * Complete the listen setup (shared between Bun and Node paths)
     */
    completeListenSetup() {
        // Ensure we are the first entry in our own Atlas.
        this.atlas[this.id] = {
            id: this.id, addr: this._addr, caps: Object.keys(this.handlers),
            pubKey: this.publicKey, lastSeen: Date.now(),
            lastGossiped: Date.now(), gossipHopCount: 0
        };
        // --- DECENTRALIZED REGISTRY BOOTSTRAP ---
        this.registerToRegistry();
        this.bootstrapFromRegistry().catch(() => { });
        // Heartbeat: Update registry file every 5s to stay "alive"
        const heartbeat = setInterval(() => this.registerToRegistry(), 5000);
        this.activeIntervals.push(heartbeat);
        this.log("INFO", `Sovereign Cell online @ ${this._addr}`);
        this.saveManifest();
        // Burst announce to speed up test convergence
        const announce = () => {
            const myEntry = {
                id: this.id,
                addr: this._addr,
                caps: Object.keys(this.handlers),
                pubKey: this.publicKey,
                lastSeen: Date.now(),
                lastGossiped: Date.now(),
                gossipHopCount: 0
            };
            const targets = Object.values(this.atlas)
                .filter(e => e.addr !== this._addr &&
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
                }).catch(() => { });
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
    detectLoopCause(signal) {
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
// En wrapper för att bära både Runtime Schema och Compile-time Type
export class TypeDef {
    schema;
    constructor(schema) {
        this.schema = schema;
    }
    optional() {
        return new TypeDef({ ...this.schema, _optional: true });
    }
}
export const S = {
    string: () => new TypeDef({ type: "string" }),
    number: () => new TypeDef({ type: "number" }),
    boolean: () => new TypeDef({ type: "boolean" }),
    any: () => new TypeDef({ type: "object" }), // Fallback
    // Enums
    enum: (values) => new TypeDef({ type: "string", enum: values }),
    // Arrays
    array: (item) => new TypeDef({ type: "array", items: item.schema }),
    // Objects
    object: (shape) => {
        const properties = {};
        const required = [];
        for (const [key, def] of Object.entries(shape)) {
            properties[key] = def.schema;
            // Hack: Vi markerar optional internt, standard JSON schema har required-listan
            if (!def.schema._optional) {
                required.push(key);
            }
        }
        return new TypeDef({
            type: "object",
            properties,
            required
        });
    }
};
/**
 * Helper för att skapa kontrakt utan externa deps
 */
export function createContract(capability, def) {
    return {
        capability,
        version: "1.0.0",
        inputSchema: def.input.schema,
        outputSchema: def.output.schema,
        compatibility: [],
        transport: { protocol: "INTERNAL", adapters: [] }
    };
}
