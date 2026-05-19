/**
 * cell-mesh-protocol-1 — dependency resolution & self-healing cell discovery.
 *
 * Types, pure helpers, and the Cell.toml loader. Runtime wiring into
 * RheoCell happens in core.ts. Full design rationale: DEPENDENCIES.md.
 *
 * Scope: single-tenant mesh, share-by-default. Workspace/tenant scoping is
 * deliberately deferred — see the "Future work" section of DEPENDENCIES.md.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AtlasEntry } from "./core";

// ---------------------------------------------------------------------------
// Reference parsing
// ---------------------------------------------------------------------------

export type DependencyRefKind = "github" | "local";

export interface ParsedDependencyRef {
    kind: DependencyRefKind;
    /** "owner/repo" for github; absolute path for local. */
    target: string;
    /** Branch, tag, or sha. Only meaningful for github refs. */
    gitRef?: string;
    /** Canonical normalized form, suitable for AtlasEntry.repo. */
    canonical: string;
}

/**
 * Parse a dependency ref string.
 *
 *   github:owner/repo            → { kind: "github", target: "owner/repo" }
 *   github:owner/repo#main       → { kind: "github", target: "owner/repo", gitRef: "main" }
 *   local:/abs/path              → { kind: "local",  target: "/abs/path" }
 *
 * Throws on malformed input. Returns canonical form sans gitRef for comparison
 * against AtlasEntry.repo (which never carries a gitRef — running instances are
 * a single commit, not a range).
 */
export function parseDependencyRef(ref: string): ParsedDependencyRef {
    if (ref.startsWith("github:")) {
        const body = ref.slice("github:".length);
        const [target, gitRef] = body.split("#", 2);
        if (!/^[^\/\s]+\/[^\/\s]+$/.test(target)) {
            throw new Error(`Invalid github ref "${ref}": expected github:OWNER/REPO[#REF]`);
        }
        return {
            kind: "github",
            target,
            gitRef,
            canonical: `github:${target}`,
        };
    }
    if (ref.startsWith("local:")) {
        const path = ref.slice("local:".length);
        if (!path.startsWith("/")) {
            throw new Error(`Invalid local ref "${ref}": path must be absolute`);
        }
        return { kind: "local", target: path, canonical: `local:${path}` };
    }
    throw new Error(`Unknown dependency ref scheme in "${ref}"`);
}

// ---------------------------------------------------------------------------
// Manifest schema
// ---------------------------------------------------------------------------

/**
 * The parsed `[meta]` table from Cell.toml. Distinct from CellManifest, which
 * is the *runtime* manifest written to `.rheo/manifests/{id}.cell.json`.
 */
export interface CellSourceMeta {
    repo?: string;
    version?: string;
    description?: string;
}

export interface CellDependencyDeclaration {
    ref: string;
    version?: string;
    alias?: string;
    optional?: boolean;
}

/**
 * Full parsed Cell.toml. Existing top-level fields (id, command, critical,
 * scalable) are intentionally kept loose to avoid coupling this module to
 * the runtime loader's evolving shape.
 */
export interface CellSourceManifest {
    id: string;
    command?: string;
    critical?: boolean;
    scalable?: boolean;
    meta?: CellSourceMeta;
    dependencies?: CellDependencyDeclaration[];
    [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Resolution outputs
// ---------------------------------------------------------------------------

export interface ResolvedDependency {
    /** The original alias from the manifest (or the derived default). */
    alias: string;
    /** The original ref string as written in Cell.toml. */
    ref: string;
    /** id of the live cell satisfying this dep. */
    id: string;
    /** addr of the live cell. */
    addr: string;
    /** version reported by the live cell, if any. */
    version?: string;
    /** Was this dep satisfied by reusing an existing instance, freshly spawned, or a local-dev load? */
    source: "reused" | "spawned" | "local";
}

export interface UnresolvedDependency {
    alias: string;
    ref: string;
    version?: string;
    reason: "no-match" | "spawn-timeout" | "spawn-rejected" | "policy" | "local-on-remote";
    detail?: string;
}

// ---------------------------------------------------------------------------
// Spawn coordination messages
// ---------------------------------------------------------------------------

export interface SpawnRequest {
    kind: "spawn-request";
    ref: string;
    version?: string;
    requestedBy: string;
    cid: string;
    expiresAt: number;
}

export interface SpawnClaim {
    kind: "spawn-claim";
    cid: string;
    spawnerId: string;
    at: number;
}

export interface SpawnFulfilled {
    kind: "spawn-fulfilled";
    cid: string;
    spawnerId: string;
    spawnedId: string;
    spawnedAddr: string;
}

export interface SpawnRejected {
    kind: "spawn-rejected";
    cid: string;
    spawnerId: string;
    reason: "no-capacity" | "ref-unreachable" | "policy-denied" | string;
}

export type SpawnMessage =
    | SpawnRequest
    | SpawnClaim
    | SpawnFulfilled
    | SpawnRejected;

// ---------------------------------------------------------------------------
// Pure resolution helpers
// ---------------------------------------------------------------------------

/**
 * Does `version` satisfy `range`?
 *
 * Initial draft uses minimal semver: "*" matches anything; an exact version
 * string matches itself. A real implementation should plug in `semver.satisfies`
 * but we keep this dependency-free for now to avoid bloating the protocol pkg.
 */
export function satisfiesVersion(version: string | undefined, range: string | undefined): boolean {
    if (!range || range === "*") return true;
    if (!version) return false;
    // TODO: replace with full semver range matching when integrated.
    return version === range;
}

/**
 * Search a gossip atlas for live entries that satisfy a dependency declaration.
 * Pure function — callers pass in whatever live snapshot they want to search.
 *
 * Returns matches sorted by id ascending (deterministic tie-breaking).
 */
export function findCandidates(
    dep: CellDependencyDeclaration,
    atlas: Record<string, AtlasEntry>,
): Array<{ id: string; entry: AtlasEntry }> {
    const parsed = parseDependencyRef(dep.ref);
    if (parsed.kind === "local") return [];

    const wantRepo = parsed.canonical;
    const out: Array<{ id: string; entry: AtlasEntry }> = [];

    for (const [id, entry] of Object.entries(atlas)) {
        if (entry.repo !== wantRepo) continue;
        if (!satisfiesVersion(entry.repoVersion, dep.version)) continue;
        out.push({ id, entry });
    }

    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
}

/**
 * Default alias derivation: slugified last path segment of the ref.
 *   github:Leif-Rydenfalk/cell-mesh-protocol-1-supabase-cell → "cell-mesh-protocol-1-supabase-cell"
 *   local:/home/foo/bar-cell                                  → "bar-cell"
 */
export function defaultAlias(ref: string): string {
    const parsed = parseDependencyRef(ref);
    const tail = parsed.target.split("/").pop() ?? parsed.target;
    return tail.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/**
 * Assert that aliases within a manifest don't collide. Throws on conflict.
 * Surfaces config errors before any network calls happen.
 */
export function validateAliases(manifest: CellSourceManifest): void {
    const deps = manifest.dependencies ?? [];
    const seen = new Set<string>();
    for (const d of deps) {
        const alias = d.alias ?? defaultAlias(d.ref);
        if (seen.has(alias)) {
            throw new Error(
                `Duplicate dependency alias "${alias}" in ${manifest.id}. ` +
                `Set "alias = ..." on one of the colliding [[dependencies]].`,
            );
        }
        seen.add(alias);
    }
}

// ---------------------------------------------------------------------------
// Public resolver surface (implementation lives in core.ts)
// ---------------------------------------------------------------------------

/**
 * Options controlling how RheoCell resolves dependencies at startup.
 * Wire into the constructor when implementing.
 */
export interface DependencyResolverOptions {
    /** Max time to wait for a single dep to resolve before failing. */
    maxWaitMs?: number;
    /** Max time to wait for a spawn claim window to close. */
    spawnClaimWindowMs?: number;
    /** Disable network resolution entirely; useful for unit tests. */
    offline?: boolean;
}

/**
 * Event hook invoked when a previously-resolved dep dies in gossip and the
 * cell begins re-resolving it. Lets dependents pause work, drain queues, etc.
 */
export type DependencyDeathHook = (
    alias: string,
    prior: ResolvedDependency,
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Cell.toml loader
// ---------------------------------------------------------------------------

/**
 * Parse a value literal from Cell.toml RHS. Supports strings (single/double
 * quoted), bools, integers, floats. Unquoted strings are returned as-is.
 * Arrays / inline tables are not supported — they aren't used by Cell.toml.
 */
function parseTomlValue(raw: string): unknown {
    const s = raw.trim();
    if (s.length === 0) return "";
    const first = s[0];
    if (first === '"' || first === "'") {
        const end = s.lastIndexOf(first);
        if (end > 0) return s.slice(1, end);
    }
    if (s === "true") return true;
    if (s === "false") return false;
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
    return s;
}

/**
 * Parse a TOML subset sufficient for Cell.toml: top-level scalars,
 * `[table]` sections, and `[[array.of.tables]]` arrays. Single quotes, double
 * quotes, bools, ints, floats. No nested tables, no inline tables, no arrays
 * of values. Comments after `#` are stripped except inside quoted strings.
 *
 * Returns a plain object. Errors out only on truly malformed input
 * (unterminated section headers); silently ignores unparseable lines so a
 * mistake in one cell's manifest doesn't crash startup elsewhere.
 */
export function parseCellToml(content: string): Record<string, unknown> {
    const root: Record<string, any> = {};
    let cursor: Record<string, any> = root;

    for (const rawLine of content.split(/\r?\n/)) {
        // Strip comments, but not inside quoted strings.
        let line = "";
        let inQuote: false | "'" | '"' = false;
        for (let i = 0; i < rawLine.length; i++) {
            const ch = rawLine[i];
            if (inQuote) {
                line += ch;
                if (ch === inQuote) inQuote = false;
            } else if (ch === '"' || ch === "'") {
                inQuote = ch;
                line += ch;
            } else if (ch === "#") {
                break;
            } else {
                line += ch;
            }
        }
        line = line.trim();
        if (!line) continue;

        // Array of tables: [[name]]
        if (line.startsWith("[[") && line.endsWith("]]")) {
            const name = line.slice(2, -2).trim();
            if (!name) continue;
            if (!Array.isArray(root[name])) root[name] = [];
            const next: Record<string, any> = {};
            root[name].push(next);
            cursor = next;
            continue;
        }

        // Table: [name]
        if (line.startsWith("[") && line.endsWith("]")) {
            const name = line.slice(1, -1).trim();
            if (!name) continue;
            if (typeof root[name] !== "object" || root[name] === null || Array.isArray(root[name])) {
                root[name] = {};
            }
            cursor = root[name];
            continue;
        }

        // Key = value
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        const value = parseTomlValue(line.slice(eq + 1));
        if (key) cursor[key] = value;
    }

    return root;
}

/**
 * Load and parse Cell.toml from `cwd` (defaults to process.cwd()).
 * Returns null if no Cell.toml exists. Throws only on truly broken file IO;
 * a missing or malformed Cell.toml that we can still read yields a partial
 * manifest so a cell can declare deps incrementally.
 */
export function loadCellSourceManifest(cwd: string = process.cwd()): CellSourceManifest | null {
    const path = join(cwd, "Cell.toml");
    if (!existsSync(path)) return null;
    let content: string;
    try {
        content = readFileSync(path, "utf8");
    } catch {
        return null;
    }
    const parsed = parseCellToml(content) as CellSourceManifest;
    if (parsed.dependencies && !Array.isArray(parsed.dependencies)) {
        // Defensive: if someone wrote a single `[dependencies]` table rather than
        // `[[dependencies]]`, normalise so downstream code can assume an array.
        parsed.dependencies = [parsed.dependencies as unknown as CellDependencyDeclaration];
    }
    return parsed;
}
