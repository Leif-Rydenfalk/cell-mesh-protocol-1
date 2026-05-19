// gossip.ts — SWIM-inspired membership gossip state machine.
// Replaces ~/.rheo/registry/*.json as the authoritative source of cell membership.
//
// Protocol:
//   PROBE  : every PROBE_INTERVAL ms, direct-probe a random live peer.
//   SUSPECT: if direct probe fails, ask K random helpers to probe indirectly.
//            if all helpers fail, mark target SUSPECT.
//   DEAD   : after SUSPECT_TIMEOUT ms without refutation, declare DEAD.
//   REFUTE : if we hear we are SUSPECT/DEAD, bump incarnation + re-announce.
//   SYNC   : every SYNC_INTERVAL ms, push-pull full state with a random peer
//            (anti-entropy — guarantees eventual convergence across partitions).

// ============================================================================
// JUMP CONSISTENT HASH  (Karger et al., 2014)
// Maps an arbitrary string key to one of `buckets` shards in O(log n),
// with minimal remapping when the bucket count changes.
// ============================================================================

export function jumpHash(key: string, buckets: number): number {
    if (buckets <= 0) return 0;
    // FNV-1a 64-bit to get a stable numeric seed from the string key
    let h = 14695981039346656037n;
    for (let i = 0; i < key.length; i++) {
        h ^= BigInt(key.charCodeAt(i));
        h = BigInt.asUintN(64, h * 1099511628211n);
    }
    // Jump hash core loop
    let b = 0n, j = 0n;
    const n = BigInt(buckets);
    while (j < n) {
        b = j;
        h = BigInt.asUintN(64, h * 2862933555777941757n + 1n);
        j = BigInt(Math.floor(
            (Number(b) + 1) * (Number(1n << 31n) / Number((h >> 33n) + 1n))
        ));
    }
    return Number(b);
}

// ============================================================================
// CONSISTENT HASH RING
// Each cell gets VNODES virtual positions on the ring.
// getOwners(key) returns the replicas closest to that key — so when a node
// dies, the next node clockwise picks up its "responsibility".
// ============================================================================

export class ConsistentHashRing {
    private ring: Array<{ hash: bigint; nodeId: string }> = [];
    private readonly VNODES = 150;

    add(nodeId: string): void {
        for (let i = 0; i < this.VNODES; i++) {
            this.ring.push({ hash: this._fnv64(`${nodeId}#${i}`), nodeId });
        }
        this.ring.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
    }

    remove(nodeId: string): void {
        this.ring = this.ring.filter(v => v.nodeId !== nodeId);
    }

    /** Returns up to `replicas` distinct node IDs responsible for `key`. */
    owners(key: string, replicas = 2): string[] {
        if (this.ring.length === 0) return [];
        const h = this._fnv64(key);
        let idx = this.ring.findIndex(v => v.hash >= h);
        if (idx < 0) idx = 0;
        const out: string[] = [];
        const seen = new Set<string>();
        const total = new Set(this.ring.map(v => v.nodeId)).size;
        for (let i = 0; out.length < Math.min(replicas, total); i++) {
            const id = this.ring[(idx + i) % this.ring.length].nodeId;
            if (!seen.has(id)) { seen.add(id); out.push(id); }
        }
        return out;
    }

    nodeCount(): number {
        return new Set(this.ring.map(v => v.nodeId)).size;
    }

    private _fnv64(s: string): bigint {
        let h = 14695981039346656037n;
        for (let i = 0; i < s.length; i++) {
            h ^= BigInt(s.charCodeAt(i));
            h = BigInt.asUintN(64, h * 1099511628211n);
        }
        return h;
    }
}

// ============================================================================
// GOSSIP STATE MACHINE
// ============================================================================

export type MemberStatus = 'alive' | 'suspect' | 'dead';

// One record per cell. Mirrors AtlasEntry fields so core.ts can cast directly.
// Gossip-specific metadata (_gossip*) is kept separate from mesh routing fields.
export interface GossipRecord {
    id: string;
    addr: string;
    caps: string[];
    pubKey: string;
    firstSeen: number;
    lastSeen: number;
    lastGossiped: number;
    gossipHopCount: number;
    status: 'online' | 'offline';
    // SWIM membership overlay
    memberStatus: MemberStatus;
    version: number;        // Monotonic timestamp; higher = more recent knowledge
    incarnation: number;    // Self-incremented on refutation; higher always wins
    suspectSince?: number;
}

export type GossipSnapshot = GossipRecord[];

export type MemberEvent = 'joined' | 'updated' | 'suspect' | 'dead';

export type MemberCallback = (
    id: string,
    record: GossipRecord | null,   // null when declared dead
    event: MemberEvent
) => void;

// Thin transport abstraction — caller provides the actual fetch implementation
export type GossipSend = (
    addr: string,
    path: string,
    body: unknown
) => Promise<{ ok: boolean; data?: unknown } | null>;

export class GossipRegistry {
    private _state = new Map<string, GossipRecord>();
    private _callbacks = new Set<MemberCallback>();
    private _probeTimer?: ReturnType<typeof setInterval>;
    private _syncTimer?: ReturnType<typeof setInterval>;
    private _suspectTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private _send?: GossipSend;

    readonly myId: string;

    // SWIM timing parameters — can be overridden before calling start()
    static PROBE_INTERVAL_MS  = 1500;
    static PROBE_TIMEOUT_MS   =  600;
    static INDIRECT_K         =    2;
    static SUSPECT_TIMEOUT_MS = 8000;
    static DEAD_TTL_MS        = 120_000;
    static SYNC_INTERVAL_MS   = 30_000;
    static PUSH_FANOUT        =    3;

    constructor(myId: string) {
        this.myId = myId;
    }

    // ── Bootstrap ────────────────────────────────────────────────────────────

    /** Pull state from the first reachable address. No hardcoded seed needed. */
    async join(addrs: string[]): Promise<void> {
        for (const addr of addrs) {
            try {
                const res = await fetch(`${addr}/gossip/pull`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ from: this.myId }),
                    signal: AbortSignal.timeout(2500)
                });
                if (res.ok) {
                    const { state } = await res.json() as { state: GossipSnapshot };
                    if (Array.isArray(state)) this._merge(state);
                    return;
                }
            } catch { /* try next */ }
        }
    }

    // ── Announce ─────────────────────────────────────────────────────────────

    /** Register / refresh our own membership record. */
    announce(record: Omit<GossipRecord, 'memberStatus' | 'version' | 'incarnation' | 'suspectSince'>): void {
        const existing = this._state.get(this.myId);
        this._state.set(this.myId, {
            ...record,
            memberStatus: 'alive',
            version: Date.now(),
            incarnation: existing?.incarnation ?? 0,
        });
    }

    /** Declare ourselves offline and gossip the departure to a few peers. */
    announceOffline(record: Omit<GossipRecord, 'memberStatus' | 'version' | 'incarnation' | 'suspectSince'>): void {
        const existing = this._state.get(this.myId);
        this._state.set(this.myId, {
            ...record,
            status: 'offline',
            memberStatus: 'dead',
            version: Date.now(),
            incarnation: (existing?.incarnation ?? 0) + 1,
        });
        this._pushToRandomPeers(GossipRegistry.PUSH_FANOUT);
    }

    // ── Subscription ─────────────────────────────────────────────────────────

    subscribe(cb: MemberCallback): () => void {
        this._callbacks.add(cb);
        return () => this._callbacks.delete(cb);
    }

    // ── State access ──────────────────────────────────────────────────────────

    /** Full state snapshot for anti-entropy exchange. */
    snapshot(): GossipSnapshot {
        return Array.from(this._state.values());
    }

    /** All non-dead records, keyed by cell ID. Compatible with AtlasEntry shape. */
    liveAtlas(): Record<string, GossipRecord> {
        const out: Record<string, GossipRecord> = {};
        for (const [id, r] of this._state) {
            if (r.memberStatus !== 'dead') out[id] = r;
        }
        return out;
    }

    // ── HTTP endpoint handlers (called from RheoCell.handleRequest) ───────────

    /** /gossip/ping — liveness check. */
    handlePing(): { ok: boolean; id: string } {
        return { ok: true, id: this.myId };
    }

    /** /gossip/pull — anti-entropy state exchange. */
    handlePull(): GossipSnapshot {
        return this.snapshot();
    }

    /** /gossip/push — receive pushed state, return ours (push-pull). */
    receivePush(incoming: GossipSnapshot): GossipSnapshot {
        this._merge(incoming);
        return this.snapshot();
    }

    /** /gossip/probe — indirect probe on behalf of a peer. */
    async probeFor(targetAddr: string): Promise<boolean> {
        return this._directProbe(targetAddr);
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    /** Start SWIM probe loop + anti-entropy sync. */
    start(send: GossipSend): void {
        this._send = send;
        this._startProbeLoop();
        this._startSyncLoop();
    }

    stop(): void {
        if (this._probeTimer) clearInterval(this._probeTimer);
        if (this._syncTimer)  clearInterval(this._syncTimer);
        for (const t of this._suspectTimers.values()) clearTimeout(t);
        this._suspectTimers.clear();
    }

    // ── SWIM core ─────────────────────────────────────────────────────────────

    private _startProbeLoop(): void {
        this._probeTimer = setInterval(async () => {
            const peers = this._livePeers();
            if (peers.length === 0) return;

            // Pick a random target for this probe round
            const target = peers[Math.floor(Math.random() * peers.length)];
            const alive = await this._directProbe(target.addr);

            if (alive) {
                this._refreshLastSeen(target.id);
                return;
            }

            // Direct probe failed — ask K random helpers to probe indirectly
            const helpers = peers
                .filter(p => p.id !== target.id)
                .sort(() => 0.5 - Math.random())
                .slice(0, GossipRegistry.INDIRECT_K);

            const results = await Promise.all(
                helpers.map(h =>
                    this._send!(h.addr, '/gossip/probe', { target: target.addr })
                        .catch(() => null)
                )
            );
            if (!results.some(r => r?.ok)) {
                this._markSuspect(target.id);
            }
        }, GossipRegistry.PROBE_INTERVAL_MS);
    }

    private _startSyncLoop(): void {
        this._syncTimer = setInterval(async () => {
            const peers = this._livePeers();
            if (peers.length === 0) return;
            const peer = peers[Math.floor(Math.random() * peers.length)];
            try {
                const result = await this._send!(peer.addr, '/gossip/pull', { from: this.myId });
                const state = (result?.data as any)?.state;
                if (Array.isArray(state)) this._merge(state);
            } catch { }
        }, GossipRegistry.SYNC_INTERVAL_MS);
    }

    private async _directProbe(addr: string): Promise<boolean> {
        if (!this._send || addr.startsWith('client://')) return false;
        try {
            const result = await Promise.race<{ ok: boolean } | null>([
                this._send(addr, '/gossip/ping', {}),
                new Promise<null>(r =>
                    setTimeout(() => r(null), GossipRegistry.PROBE_TIMEOUT_MS)
                )
            ]);
            return result?.ok === true;
        } catch {
            return false;
        }
    }

    private _markSuspect(id: string): void {
        const r = this._state.get(id);
        if (!r || r.memberStatus !== 'alive') return;
        r.memberStatus = 'suspect';
        r.suspectSince = Date.now();
        r.version = Date.now();
        this._notify(id, r, 'suspect');
        this._pushToRandomPeers(GossipRegistry.PUSH_FANOUT);
        const t = setTimeout(() => this._markDead(id), GossipRegistry.SUSPECT_TIMEOUT_MS);
        this._suspectTimers.set(id, t);
    }

    _markDead(id: string): void {
        const r = this._state.get(id);
        if (!r || r.memberStatus === 'dead') return;
        this._clearSuspectTimer(id);
        r.memberStatus = 'dead';
        r.status = 'offline';
        r.version = Date.now();
        this._notify(id, null, 'dead');
        this._pushToRandomPeers(GossipRegistry.PUSH_FANOUT);
        setTimeout(() => this._state.delete(id), GossipRegistry.DEAD_TTL_MS);
    }

    // ── Merge ─────────────────────────────────────────────────────────────────

    private _merge(incoming: GossipSnapshot): void {
        for (const remote of incoming) {
            if (!remote?.id) continue;

            // If the network thinks we're suspect/dead, refute immediately
            if (remote.id === this.myId && remote.memberStatus !== 'alive') {
                this._refute();
                continue;
            }

            const local = this._state.get(remote.id);

            // Higher incarnation always wins (refutation guarantee)
            const incWins = !local || remote.incarnation > local.incarnation;
            // Tie-break on version (timestamp)
            const verWins = !!local
                && remote.incarnation === local.incarnation
                && remote.version > local.version;

            if (incWins || verWins) {
                this._applyRemote(remote);
            }
        }
    }

    private _applyRemote(remote: GossipRecord): void {
        const id = remote.id;
        const local = this._state.get(id);

        if (remote.memberStatus === 'dead') {
            if (!local || local.memberStatus !== 'dead') {
                this._clearSuspectTimer(id);
                this._state.set(id, { ...remote });
                this._notify(id, null, 'dead');
                setTimeout(() => this._state.delete(id), GossipRegistry.DEAD_TTL_MS);
            }
            return;
        }

        if (remote.memberStatus === 'suspect') {
            this._state.set(id, { ...remote });
            if (!local || local.memberStatus === 'alive') {
                this._notify(id, remote, 'suspect');
                if (!this._suspectTimers.has(id)) {
                    const t = setTimeout(
                        () => this._markDead(id),
                        GossipRegistry.SUSPECT_TIMEOUT_MS
                    );
                    this._suspectTimers.set(id, t);
                }
            }
            return;
        }

        // Alive — clear any lingering suspect state
        if (local?.memberStatus === 'suspect') this._clearSuspectTimer(id);
        const isNew = !local || local.memberStatus === 'dead';
        this._state.set(id, { ...remote, memberStatus: 'alive' });
        this._notify(id, remote, isNew ? 'joined' : 'updated');
    }

    private _refute(): void {
        const r = this._state.get(this.myId);
        if (!r) return;
        r.memberStatus = 'alive';
        r.status = 'online';
        r.incarnation += 1;
        r.version = Date.now();
        this._pushToRandomPeers(GossipRegistry.PUSH_FANOUT);
    }

    private async _pushToRandomPeers(n: number): Promise<void> {
        if (!this._send) return;
        const peers = this._livePeers().sort(() => 0.5 - Math.random()).slice(0, n);
        const snap = this.snapshot();
        await Promise.all(
            peers.map(p =>
                this._send!(p.addr, '/gossip/push', { state: snap }).catch(() => null)
            )
        );
    }

    private _refreshLastSeen(id: string): void {
        const r = this._state.get(id);
        if (!r || r.memberStatus === 'dead') return;
        r.lastSeen = Date.now();
        if (r.memberStatus === 'suspect') {
            this._clearSuspectTimer(id);
            r.memberStatus = 'alive';
            this._notify(id, r, 'updated');
        }
    }

    private _livePeers(): GossipRecord[] {
        const out: GossipRecord[] = [];
        for (const [id, r] of this._state) {
            if (id !== this.myId && r.memberStatus === 'alive' && !r.addr.startsWith('client://')) {
                out.push(r);
            }
        }
        return out;
    }

    private _notify(id: string, record: GossipRecord | null, event: MemberEvent): void {
        for (const cb of this._callbacks) {
            try { cb(id, record, event); } catch { }
        }
    }

    private _clearSuspectTimer(id: string): void {
        const t = this._suspectTimers.get(id);
        if (t) { clearTimeout(t); this._suspectTimers.delete(id); }
    }
}
