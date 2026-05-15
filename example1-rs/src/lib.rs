// example1-rs/src/lib.rs
// Cell example protocol 1
// Optimized for Trading Platforms: Low Latency, High Throughput, Zero-Copy

#![allow(dead_code)]

use std::{
    collections::HashMap,
    fmt,
    net::SocketAddr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, RwLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use dashmap::DashMap;
use ed25519_dalek::{SigningKey, VerifyingKey};
use futures::future::join_all;
use rand::rngs::OsRng;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use tokio::{
    net::TcpListener,
    sync::{mpsc, Mutex, RwLock as TokioRwLock},
    task::JoinHandle,
    time::{interval, sleep, timeout},
};
use tower_http::{compression::CompressionLayer, cors::CorsLayer, trace::TraceLayer};
use tracing::{debug, error, info, warn, Level};
use uuid::Uuid;

// Re-exports
pub use axum;
pub use serde_json;

// ============================================================================
// REGISTRY PATH HELPERS
// ============================================================================

/// Get the workspace root directory (parent of all cell directories)
/// This matches the TypeScript implementation in core.ts
pub fn get_workspace_root() -> PathBuf {
    std::env::current_dir()
        .expect("Failed to get current directory")
        .parent()
        .expect("Failed to get parent directory (workspace root)")
        .to_path_buf()
}

/// Get the protocols directory (where TypeScript cells live)
/// This matches the TypeScript implementation in core.ts
pub fn get_protocols_dir() -> PathBuf {
    let current = std::env::current_dir().expect("Failed to get current directory");

    // Check if we're already in protocols/
    if current.ends_with("protocols") {
        return current;
    }

    // Check if protocols/ is a sibling directory
    let sibling_protocols = current
        .parent()
        .expect("Failed to get parent directory")
        .join("protocols");

    if sibling_protocols.exists() {
        return sibling_protocols;
    }

    // Fallback: search upward for protocols/
    let mut search_path = current.clone();
    for _ in 0..5 {
        // Search up to 5 levels
        let protocols = search_path.join("protocols");
        if protocols.exists() {
            return protocols;
        }
        match search_path.parent() {
            Some(parent) => search_path = parent.to_path_buf(),
            None => break,
        }
    }

    panic!("Could not find protocols/ directory. Is the workspace structure correct?");
}

/// Get the standard registry directory path
/// Returns: <protocols>/.rheo/registry (matching TypeScript cells)
pub fn get_registry_dir() -> String {
    get_protocols_dir()
        .join(".rheo")
        .join("registry")
        .to_string_lossy()
        .to_string()
}

// ============================================================================
// ERROR SYSTEM
// ============================================================================

/// Rich error type for mesh failures with full provenance
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshError {
    pub code: ErrorCode,
    pub message: String,
    pub from: String,
    pub trace: Vec<String>,
    pub timestamp: u64,
    pub history: Option<Vec<NarrativeStep>>,
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ErrorCode {
    NotFound,
    Timeout,
    LoopDetected,
    HandlerError,
    RpcFail,
    RpcUnreachable,
    RpcTimeout,
    CircuitOpen,
    NotReady,
    ValidationFailed,
    Unauthorized,
    RateLimited,
    Internal,
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ErrorCode::NotFound => write!(f, "NOT_FOUND"),
            ErrorCode::Timeout => write!(f, "TIMEOUT"),
            ErrorCode::LoopDetected => write!(f, "LOOP_DETECTED"),
            ErrorCode::HandlerError => write!(f, "HANDLER_ERROR"),
            ErrorCode::RpcFail => write!(f, "RPC_FAIL"),
            ErrorCode::RpcUnreachable => write!(f, "RPC_UNREACHABLE"),
            ErrorCode::RpcTimeout => write!(f, "RPC_TIMEOUT"),
            ErrorCode::CircuitOpen => write!(f, "CIRCUIT_OPEN"),
            ErrorCode::NotReady => write!(f, "NOT_READY"),
            ErrorCode::ValidationFailed => write!(f, "VALIDATION_FAILED"),
            ErrorCode::Unauthorized => write!(f, "UNAUTHORIZED"),
            ErrorCode::RateLimited => write!(f, "RATE_LIMITED"),
            ErrorCode::Internal => write!(f, "INTERNAL"),
        }
    }
}

impl MeshError {
    pub fn new(code: ErrorCode, message: impl Into<String>, from: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            from: from.into(),
            trace: Vec::new(),
            timestamp: now_millis(),
            history: None,
            details: None,
        }
    }

    pub fn with_trace(mut self, trace: Vec<String>) -> Self {
        self.trace = trace;
        self
    }

    pub fn with_history(mut self, history: Vec<NarrativeStep>) -> Self {
        self.history = Some(history);
        self
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    /// Generate forensic report for debugging
    pub fn forensic_report(&self) -> String {
        let mut lines = vec![
            format!("╔══════════════════════════════════════════════════════════════════╗"),
            format!("║ MESH FAILURE: {} {:>48} ║", self.code, ""),
            format!("╠══════════════════════════════════════════════════════════════════╣"),
            format!("║ Time: {} ║", chrono::Utc::now().to_rfc3339()),
            format!("║ Source: {} ║", self.from),
            format!("║ Message: {} ║", self.message),
        ];

        if !self.trace.is_empty() {
            lines.push(format!(
                "╠══════════════════════════════════════════════════════════════════╣"
            ));
            lines.push(format!("║ SIGNAL PATH ({} hops):", self.trace.len()));
            for (i, hop) in self.trace.iter().enumerate() {
                lines.push(format!("║ {}. {}", i + 1, hop));
            }
        }

        if let Some(history) = &self.history {
            lines.push(format!(
                "╠══════════════════════════════════════════════════════════════════╣"
            ));
            lines.push(format!("║ NARRATIVE HISTORY ({} steps):", history.len()));
            for step in history.iter().take(20) {
                let ts = chrono::DateTime::from_timestamp_millis(step.timestamp as i64)
                    .map(|d| d.format("%H:%M:%S%.3f").to_string())
                    .unwrap_or_else(|| step.timestamp.to_string());
                lines.push(format!("║ [{}] {}: {}", ts, step.cell, step.action));
            }
            if history.len() > 20 {
                lines.push(format!("║ ... and {} more steps", history.len() - 20));
            }
        }

        if let Some(details) = &self.details {
            lines.push(format!(
                "╠══════════════════════════════════════════════════════════════════╣"
            ));
            lines.push(format!(
                "║ DETAILS: {}",
                serde_json::to_string_pretty(details)
                    .unwrap_or_default()
                    .lines()
                    .next()
                    .unwrap_or("")
            ));
        }

        lines.push(format!(
            "╚══════════════════════════════════════════════════════════════════╝"
        ));
        lines.join("\n")
    }
}

impl std::error::Error for MeshError {}

impl fmt::Display for MeshError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {} (from: {})", self.code, self.message, self.from)
    }
}

// ============================================================================
// CORE TYPES
// ============================================================================

/// Chronological causality marker for debugging
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NarrativeStep {
    pub cell: String,
    pub timestamp: u64,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_micros: Option<u64>,
}

impl NarrativeStep {
    pub fn new(cell: impl Into<String>, action: impl Into<String>) -> Self {
        Self {
            cell: cell.into(),
            timestamp: now_millis(),
            action: action.into(),
            data: None,
            duration_micros: None,
        }
    }

    pub fn with_data(mut self, data: impl Serialize) -> Self {
        self.data = serde_json::to_value(data).ok();
        self
    }

    pub fn with_duration(mut self, duration: Duration) -> Self {
        self.duration_micros = Some(duration.as_micros() as u64);
        self
    }
}

/// Entry in the mesh atlas (directory)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtlasEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>, // ← CHANGED FROM String TO Option<String>
    pub addr: String,
    pub caps: Vec<String>,
    pub pub_key: String,
    pub last_seen: u64,
    pub last_gossiped: u64,
    pub gossip_hop_count: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
}

impl AtlasEntry {
    pub fn new(id: impl Into<String>, addr: impl Into<String>, caps: Vec<String>) -> Self {
        let now = now_millis();
        Self {
            id: Some(id.into()),
            addr: addr.into(),
            caps,
            pub_key: String::new(),
            last_seen: now,
            last_gossiped: now,
            gossip_hop_count: 0,
            metadata: None,
            latency_ms: None,
        }
    }

    pub fn with_pub_key(mut self, key: impl Into<String>) -> Self {
        self.pub_key = key.into();
        self
    }
}

/// Signal envelope - the universal message format
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signal {
    pub id: String,
    pub from: String,
    pub intent: Intent,
    pub payload: Payload,
    #[serde(default)]
    pub proofs: HashMap<String, String>,
    #[serde(default)]
    pub atlas: HashMap<String, AtlasEntry>,
    #[serde(default)]
    pub trace: Vec<String>,
    #[serde(rename = "_steps", default)]
    pub steps: Vec<NarrativeStep>,
    #[serde(rename = "_visitedCellIds", default)] // TS expects camelCase here
    pub visited_cell_ids: Vec<String>,
    #[serde(rename = "_visitedAddrs", default)]
    pub visited_addrs: Vec<String>,
    #[serde(rename = "_hops", default)]
    pub hops: u8,
    #[serde(rename = "_floodAttempted", default)]
    pub flood_attempted: bool,
    #[serde(rename = "_registryScanned", default)]
    pub registry_scanned: bool,
    #[serde(rename = "_deadlineMs", default)]
    pub deadline_ms: Option<u64>,
    #[serde(flatten)]
    pub extensions: HashMap<String, Value>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum Intent {
    Ask,
    Tell,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Payload {
    pub capability: String,
    #[serde(default)]
    pub args: Value,
}

impl Signal {
    pub fn new(
        from: impl Into<String>,
        capability: impl Into<String>,
        args: impl Serialize,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            from: from.into(),
            intent: Intent::Ask,
            payload: Payload {
                capability: capability.into(),
                args: serde_json::to_value(args).unwrap_or_default(),
            },
            proofs: HashMap::new(),
            atlas: HashMap::new(),
            trace: Vec::new(),
            steps: Vec::new(),
            visited_cell_ids: Vec::new(),
            visited_addrs: Vec::new(),
            hops: 0,
            flood_attempted: false,
            registry_scanned: false,
            deadline_ms: None,
            extensions: HashMap::new(),
        }
    }

    pub fn with_deadline(mut self, duration: Duration) -> Self {
        self.deadline_ms = Some(now_millis() + duration.as_millis() as u64);
        self
    }

    pub fn with_proof(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.proofs.insert(key.into(), value.into());
        self
    }

    pub fn is_expired(&self) -> bool {
        self.deadline_ms.map(|d| now_millis() > d).unwrap_or(false)
    }

    /// Record a step in the narrative
    pub fn record_step(&mut self, cell: impl Into<String>, action: impl Into<String>) {
        self.steps.push(NarrativeStep::new(cell, action));
    }

    /// Mark cell as visited
    pub fn mark_visited(&mut self, cell_id: impl Into<String>, addr: impl Into<String>) {
        let id = cell_id.into();
        let addr = addr.into();
        if !self.visited_cell_ids.contains(&id) {
            self.visited_cell_ids.push(id);
        }
        if !self.visited_addrs.contains(&addr) {
            self.visited_addrs.push(addr);
        }
    }
}

/// Result of a mesh operation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceResult {
    pub ok: bool,
    pub value: Option<Value>,
    pub error: Option<MeshError>,
    pub cid: String,
    #[serde(rename = "latencyMicros")] // Match TS naming exactly
    pub latency_micros: Option<u64>,
}

impl TraceResult {
    pub fn success(cid: impl Into<String>, value: impl Serialize) -> Self {
        Self {
            ok: true,
            value: serde_json::to_value(value).ok(),
            error: None,
            cid: cid.into(),
            latency_micros: None,
        }
    }

    pub fn failure(cid: impl Into<String>, error: MeshError) -> Self {
        Self {
            ok: false,
            value: None,
            error: Some(error),
            cid: cid.into(),
            latency_micros: None,
        }
    }

    pub fn with_latency(mut self, duration: Duration) -> Self {
        self.latency_micros = Some(duration.as_micros() as u64);
        self
    }

    /// Extract typed value
    pub fn into_value<T: DeserializeOwned>(self) -> Result<T, MeshError> {
        if !self.ok {
            return Err(self.error.unwrap_or_else(|| {
                MeshError::new(ErrorCode::Internal, "Unknown error", "system")
            }));
        }
        match self.value {
            Some(v) => serde_json::from_value(v).map_err(|e| {
                MeshError::new(
                    ErrorCode::ValidationFailed,
                    format!("Deserialization failed: {}", e),
                    "system",
                )
            }),
            None => Err(MeshError::new(
                ErrorCode::Internal,
                "No value in success result",
                "system",
            )),
        }
    }
}

// ============================================================================
// CIRCUIT BREAKER
// ============================================================================

/// Circuit breaker for fault tolerance
pub struct CircuitBreaker {
    failures: AtomicU64,
    last_failure: AtomicU64,
    threshold: u64,
    recovery_ms: u64,
}

impl CircuitBreaker {
    pub fn new(threshold: u64, recovery_ms: u64) -> Self {
        Self {
            failures: AtomicU64::new(0),
            last_failure: AtomicU64::new(0),
            threshold,
            recovery_ms,
        }
    }

    pub fn record_success(&self) {
        self.failures.store(0, Ordering::SeqCst);
    }

    pub fn record_failure(&self) {
        self.failures.fetch_add(1, Ordering::SeqCst);
        self.last_failure.store(now_millis(), Ordering::SeqCst);
    }

    pub fn is_open(&self) -> bool {
        let failures = self.failures.load(Ordering::SeqCst);
        if failures < self.threshold {
            return false;
        }
        let last = self.last_failure.load(Ordering::SeqCst);
        let elapsed = now_millis().saturating_sub(last);
        elapsed < self.recovery_ms
    }

    pub fn state(&self) -> CircuitState {
        if self.is_open() {
            CircuitState::Open
        } else if self.failures.load(Ordering::SeqCst) > 0 {
            CircuitState::HalfOpen
        } else {
            CircuitState::Closed
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CircuitState {
    Closed,
    HalfOpen,
    Open,
}

// ============================================================================
// HANDLER TRAITS
// ============================================================================

/// Type-erased handler for capabilities
pub type BoxedHandler =
    Box<dyn Fn(Value, Signal) -> futures::future::BoxFuture<'static, TraceResult> + Send + Sync>;

/// Handler trait for typed capabilities
#[async_trait::async_trait]
pub trait CapabilityHandler<I, O>: Send + Sync + 'static
where
    I: DeserializeOwned + Send + 'static,
    O: Serialize + Send + 'static,
{
    async fn handle(&self, input: I, signal: Signal) -> Result<O, MeshError>;
}

// Helper to create boxed handlers - FIXED: Added Clone bound
pub fn handler<I, O, F, Fut>(f: F) -> BoxedHandler
where
    I: DeserializeOwned + Send + 'static,
    O: Serialize + Send + 'static,
    F: Fn(I, Signal) -> Fut + Send + Sync + Clone + 'static,
    Fut: std::future::Future<Output = Result<O, MeshError>> + Send + 'static,
{
    Box::new(move |args, signal| {
        let f = f.clone(); // Clone the handler
        let signal_id = signal.id.clone(); // Clone signal.id before moving
        Box::pin(async move {
            let input: I = match serde_json::from_value(args) {
                Ok(i) => i,
                Err(e) => {
                    return TraceResult::failure(
                        signal_id,
                        MeshError::new(
                            ErrorCode::ValidationFailed,
                            format!("Input validation failed: {}", e),
                            "handler",
                        ),
                    );
                }
            };
            let start = Instant::now();
            match f(input, signal).await {
                Ok(output) => TraceResult::success(signal_id, output).with_latency(start.elapsed()),
                Err(e) => TraceResult::failure(signal_id, e),
            }
        })
    })
}

// ============================================================================
// CORE CELL IMPLEMENTATION
// ============================================================================

/// Configuration for a RheoCell
#[derive(Debug, Clone)]
pub struct CellConfig {
    pub id: String,
    pub port: u16,
    pub seed: Option<String>,
    pub registry_dir: Option<String>,
    pub max_concurrent: usize,
    pub rpc_timeout_ms: u64,
    pub gossip_interval_ms: u64,
    pub atlas_ttl_ms: u64,
    pub enable_compression: bool,
    pub enable_tls: bool,
    pub log_level: Level,
}

impl Default for CellConfig {
    fn default() -> Self {
        Self {
            id: format!(
                "cell_{}",
                Uuid::new_v4().to_string().split('-').next().unwrap()
            ),
            port: 0,
            seed: None,
            registry_dir: Some(get_registry_dir()),
            max_concurrent: 1000,
            rpc_timeout_ms: 5000,
            gossip_interval_ms: 15000,
            atlas_ttl_ms: 60000,
            enable_compression: true,
            enable_tls: false,
            log_level: Level::INFO,
        }
    }
}

/// The core distributed cell - sovereign compute node
pub struct RheoCell {
    pub id: String,
    pub addr: Arc<TokioRwLock<String>>,
    pub port: u16,
    pub config: CellConfig,

    // Cryptographic identity
    signing_key: SigningKey,
    pub verifying_key: VerifyingKey,
    pub pub_key_hex: String,

    // State
    atlas: Arc<DashMap<String, AtlasEntry>>,
    handlers: Arc<DashMap<String, BoxedHandler>>,
    circuits: Arc<DashMap<String, CircuitBreaker>>,

    // Request deduplication
    seen_nonces: Arc<DashMap<String, Instant>>,
    active_executions: Arc<DashMap<String, Arc<tokio::sync::Mutex<Option<TraceResult>>>>>,
    result_cache: Arc<DashMap<String, (TraceResult, Instant)>>,

    // Metrics
    metrics: Arc<Metrics>,

    // Lifecycle
    shutdown_tx: Option<mpsc::Sender<()>>,
    is_shutting_down: Arc<AtomicU64>, // 0 = running, 1 = shutting down, 2 = shut down
    tasks: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

#[derive(Default)]
struct Metrics {
    requests_total: AtomicU64,
    requests_success: AtomicU64,
    requests_failed: AtomicU64,
    latency_sum_micros: AtomicU64,
}

impl RheoCell {
    /// Create a new cell with the given configuration
    pub fn new(config: CellConfig) -> Arc<Self> {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = VerifyingKey::from(&signing_key);
        let pub_key_hex = hex::encode(verifying_key.to_bytes());

        let id = if config.id.is_empty() {
            format!("cell_{}", &pub_key_hex[..16])
        } else {
            config.id.clone()
        };

        let cell = Arc::new(Self {
            id: id.clone(),
            addr: Arc::new(TokioRwLock::new(String::new())),
            port: config.port,
            config: config.clone(),
            signing_key,
            verifying_key,
            pub_key_hex,
            atlas: Arc::new(DashMap::new()),
            handlers: Arc::new(DashMap::new()),
            circuits: Arc::new(DashMap::new()),
            seen_nonces: Arc::new(DashMap::new()),
            active_executions: Arc::new(DashMap::new()),
            result_cache: Arc::new(DashMap::new()),
            metrics: Arc::new(Metrics::default()),
            shutdown_tx: None,
            is_shutting_down: Arc::new(AtomicU64::new(0)),
            tasks: Arc::new(Mutex::new(Vec::new())),
        });

        // Register default handlers
        cell.register_default_handlers();
        cell
    }

    /// Parse atlas from gossip args - handles multiple formats
    fn parse_atlas_from_gossip(args: &Value) -> Result<HashMap<String, AtlasEntry>, String> {
        // Format 1: Direct HashMap (Rust peer)
        if let Ok(entries) = serde_json::from_value::<HashMap<String, AtlasEntry>>(args.clone()) {
            debug!("Parsed gossip atlas using Format 1 (direct)");
            return Ok(entries);
        }

        // Format 2: Wrapped { "atlas": {...} } (TypeScript peer)
        if let Some(atlas_obj) = args.get("atlas") {
            if let Ok(entries) =
                serde_json::from_value::<HashMap<String, AtlasEntry>>(atlas_obj.clone())
            {
                debug!("Parsed gossip atlas using Format 2 (atlas field)");
                return Ok(entries);
            } else {
                return Err(format!(
                    "Gossip has 'atlas' field but it's not a valid HashMap. Value: {}",
                    serde_json::to_string(atlas_obj).unwrap_or_else(|_| "unparseable".to_string())
                ));
            }
        }

        Err(format!(
            "Gossip args don't match expected format. Keys: {:?}",
            args.as_object().map(|o| o.keys().collect::<Vec<_>>())
        ))
    }

    fn register_default_handlers(self: &Arc<Self>) {
        let _cell = Arc::clone(self);
        self.handlers.insert(
            "mesh/ping".to_string(),
            Box::new(move |_args, signal| {
                let signal_id = signal.id.clone();
                Box::pin(async move { TraceResult::success(signal_id, "PONG") })
            }),
        );

        let cell = Arc::clone(self);
        self.handlers.insert(
            "mesh/health".to_string(),
            Box::new(move |_args, signal| {
                let cell = Arc::clone(&cell);
                let signal_id = signal.id.clone();
                Box::pin(async move {
                    let total_cells = cell.atlas.len() + 1;
                    let hot_spots: Vec<String> =
                        cell.atlas.iter().map(|e| e.key().clone()).take(5).collect();
                    let health = serde_json::json!({
                        "total_cells": total_cells,
                        "avg_load": 0.0,
                        "status": "NOMINAL",
                        "hot_spots": hot_spots,
                        "timestamp": now_millis(),
                    });
                    TraceResult::success(signal_id, health)
                })
            }),
        );

        let cell = Arc::clone(self);
        self.handlers.insert(
            "mesh/gossip".to_string(),
            Box::new(move |args, signal| {
                let cell = Arc::clone(&cell);
                let signal_id = signal.id.clone();
                Box::pin(async move {
                    debug!(
                        "Received gossip request. Raw args: {}",
                        serde_json::to_string(&args).unwrap_or_else(|_| "unparseable".to_string())
                    );

                    // Flexible parsing for incoming atlas
                    let incoming_atlas = match Self::parse_atlas_from_gossip(&args) {
                        Ok(atlas) => atlas,
                        Err(e) => {
                            warn!("Failed to parse incoming gossip atlas: {}", e);
                            HashMap::new()
                        }
                    };

                    if !incoming_atlas.is_empty() {
                        cell.merge_atlas(incoming_atlas, true);
                    }

                    // Return our atlas in TypeScript-compatible format
                    let our_atlas: HashMap<String, AtlasEntry> = cell
                        .atlas
                        .iter()
                        .map(|e| (e.key().clone(), e.value().clone()))
                        .collect();

                    debug!("Sending gossip response with {} entries", our_atlas.len());

                    TraceResult::success(
                        signal_id,
                        serde_json::json!({
                            "atlas": our_atlas
                        }),
                    )
                })
            }),
        );

        let cell = Arc::clone(self);
        self.handlers.insert(
            "cell/shutdown".to_string(),
            Box::new(move |_args, signal| {
                let cell = Arc::clone(&cell);
                let signal_id = signal.id.clone();
                Box::pin(async move {
                    tokio::spawn(async move {
                        sleep(Duration::from_millis(100)).await;
                        cell.shutdown().await;
                    });
                    TraceResult::success(
                        signal_id,
                        serde_json::json!({ "status": "shutting_down" }),
                    )
                })
            }),
        );

        let cell = Arc::clone(self);
        self.handlers.insert(
            "cell/inspect".to_string(),
            Box::new(move |_args, signal| {
                let cell = Arc::clone(&cell);
                let signal_id = signal.id.clone();
                Box::pin(async move {
                    let info = serde_json::json!({
                        "id": cell.id,
                        "addr": *cell.addr.read().await,
                        "capabilities": cell.handlers.iter().map(|e| e.key().clone()).collect::<Vec<_>>(),
                        "atlas_size": cell.atlas.len(),
                        "metrics": {
                            "requests_total": cell.metrics.requests_total.load(Ordering::SeqCst),
                            "requests_success": cell.metrics.requests_success.load(Ordering::SeqCst),
                        }
                    });
                    TraceResult::success(signal_id, info)
                })
            }),
        );
    }

    /// Register a capability handler - FIXED: Added Clone bound
    pub fn provide<F, I, O>(&self, capability: impl Into<String>, handler: F)
    where
        F: Fn(I, Signal) -> futures::future::BoxFuture<'static, Result<O, MeshError>>
            + Send
            + Sync
            + Clone
            + 'static,
        I: DeserializeOwned + Send + 'static,
        O: Serialize + Send + 'static,
    {
        let cap = capability.into();
        let boxed: BoxedHandler = Box::new(move |args, signal| {
            let handler = handler.clone(); // Clone the handler
            let signal_id = signal.id.clone(); // Clone signal.id before moving
            Box::pin(async move {
                let input: I = match serde_json::from_value(args) {
                    Ok(i) => i,
                    Err(e) => {
                        return TraceResult::failure(
                            signal_id,
                            MeshError::new(
                                ErrorCode::ValidationFailed,
                                format!("Input validation: {}", e),
                                "handler",
                            ),
                        );
                    }
                };

                match handler(input, signal).await {
                    Ok(output) => TraceResult::success(signal_id, output),
                    Err(e) => TraceResult::failure(signal_id, e),
                }
            })
        });

        self.handlers.insert(cap, boxed);
        debug!(cell_id = %self.id, "Registered capability");
    }

    /// Start the cell and begin listening
    pub async fn listen(self: Arc<Self>) -> Result<SocketAddr, std::io::Error> {
        // Try to bind to the configured port, or find an available one
        let listener = if self.port == 0 {
            TcpListener::bind("0.0.0.0:0").await?
        } else {
            match TcpListener::bind(format!("0.0.0.0:{}", self.port)).await {
                Ok(l) => l,
                Err(_) => {
                    warn!(port = self.port, "Port in use, finding alternative");
                    TcpListener::bind("0.0.0.0:0").await?
                }
            }
        };

        let addr = listener.local_addr()?;
        let port = addr.port();
        let addr_str = format!("http://127.0.0.1:{}", port);

        {
            let mut addr_lock = self.addr.write().await;
            *addr_lock = addr_str.clone();
        }

        info!(cell_id = %self.id, addr = %addr_str, "🟢 Rheo Cell online");

        // Add self to atlas
        let self_entry = AtlasEntry::new(
            self.id.clone(),
            addr_str.clone(),
            self.handlers.iter().map(|e| e.key().clone()).collect(),
        )
        .with_pub_key(self.pub_key_hex.clone());
        self.atlas.insert(self.id.clone(), self_entry);

        // Start background tasks
        self.start_background_tasks().await;

        // Build and serve the HTTP router
        let app = self.build_router();

        // Store server handle for graceful shutdown
        let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);
        unsafe {
            // This is safe because we control the Arc lifetime
            let cell_ptr = Arc::into_raw(self.clone()) as *mut RheoCell;
            (*cell_ptr).shutdown_tx = Some(shutdown_tx);
        }

        let server = axum::serve(listener, app).with_graceful_shutdown(async move {
            let _ = shutdown_rx.recv().await;
            info!("Received shutdown signal, stopping server");
        });

        let server_handle = tokio::spawn(async move {
            if let Err(e) = server.await {
                error!(error = %e, "Server error");
            }
        });

        self.tasks.lock().await.push(server_handle);

        Ok(addr)
    }

    fn build_router(self: &Arc<Self>) -> Router {
        let cell = Arc::clone(self);

        let mut router = Router::new()
            .route("/", post(handle_signal))
            .route("/atlas", get(handle_atlas).post(handle_atlas)) // <-- CHANGED: added .get()
            .route("/health", get(handle_health))
            .with_state(cell);

        if self.config.enable_compression {
            router = router.layer(CompressionLayer::new());
        }

        router = router
            .layer(CorsLayer::permissive())
            .layer(TraceLayer::new_for_http());

        router
    }

    async fn start_background_tasks(self: &Arc<Self>) {
        // Gossip task
        let cell = Arc::clone(self);
        let gossip_handle = tokio::spawn(async move {
            let mut interval = interval(Duration::from_millis(cell.config.gossip_interval_ms));
            loop {
                interval.tick().await;
                if cell.is_shutting_down.load(Ordering::SeqCst) > 0 {
                    break;
                }
                cell.gossip().await;
            }
        });
        self.tasks.lock().await.push(gossip_handle);

        // Cleanup task
        let cell = Arc::clone(self);
        let cleanup_handle = tokio::spawn(async move {
            let mut interval = interval(Duration::from_secs(30));
            loop {
                interval.tick().await;
                if cell.is_shutting_down.load(Ordering::SeqCst) > 0 {
                    break;
                }
                cell.cleanup().await;
            }
        });
        self.tasks.lock().await.push(cleanup_handle);

        // Bootstrap from seed if provided
        if let Some(seed) = &self.config.seed {
            let cell = Arc::clone(self);
            let seed = seed.clone();
            tokio::spawn(async move {
                sleep(Duration::from_millis(100)).await;
                cell.bootstrap_from_seed(&seed).await;
            });
        }
    }

    async fn gossip(&self) {
        let peers: Vec<AtlasEntry> = self
            .atlas
            .iter()
            .filter(|e| e.key() != &self.id && !e.value().addr.starts_with("client://"))
            .map(|e| e.value().clone())
            .collect();

        if peers.is_empty() {
            return;
        }

        let our_atlas: HashMap<String, AtlasEntry> = self
            .atlas
            .iter()
            .map(|e| (e.key().clone(), e.value().clone()))
            .collect();

        // Wrap atlas in proper structure matching TypeScript CDK
        let gossip_args = serde_json::json!({
            "atlas": our_atlas
        });
        let signal = Signal::new(&self.id, "mesh/gossip", gossip_args);

        // Send to 2 random peers
        let targets: Vec<_> = peers
            .into_iter()
            .filter(|e| e.id.as_ref() != Some(&self.id)) // Compare Option with Some(String)
            .take(2)
            .collect();

        for peer in targets {
            let cell = Arc::new(self.clone());
            let signal = signal.clone();
            tokio::spawn(async move {
                let _ = cell.rpc(&peer.addr, signal).await;
            });
        }
    }

    async fn cleanup(&self) {
        let now = Instant::now();
        let _ttl = Duration::from_millis(self.config.atlas_ttl_ms);

        // Clean old atlas entries
        let to_remove: Vec<String> = self
            .atlas
            .iter()
            .filter(|e| {
                e.key() != &self.id
                    && now.duration_since(Instant::now()).as_millis() as u64 + e.value().last_seen
                        < now_millis()
            })
            .map(|e| e.key().clone())
            .collect();

        for id in to_remove {
            self.atlas.remove(&id);
        }

        // Clean old nonces
        self.seen_nonces
            .retain(|_, v| now.duration_since(*v) < Duration::from_secs(60));

        // Clean old cache entries
        self.result_cache
            .retain(|_, (r, t)| r.ok || now.duration_since(*t) < Duration::from_secs(10));
    }

    async fn bootstrap_from_seed(&self, seed: &str) {
        info!("Attempting to bootstrap from seed: {}", seed);

        // Prepare our own entry to announce ourselves immediately
        let mut initial_atlas = HashMap::new();
        if let Some(self_entry) = self.atlas.get(&self.id) {
            initial_atlas.insert(self.id.clone(), self_entry.value().clone());
        }

        for attempt in 0..10 {
            let gossip_args = serde_json::json!({
                "atlas": initial_atlas
            });

            debug!("Bootstrap attempt {} to {}", attempt + 1, seed);
            let result = self
                .rpc_raw(seed, Signal::new(&self.id, "mesh/gossip", gossip_args))
                .await;

            if result.ok {
                if let Some(ref value) = result.value {
                    let parsed_atlas = Self::parse_atlas_flexible(value);
                    match parsed_atlas {
                        Ok(entries) => {
                            if !entries.is_empty() {
                                self.merge_atlas(entries, false);
                                info!(
                                    "✅ Bootstrapped {} peers from seed",
                                    self.atlas.len().saturating_sub(1)
                                );
                                return;
                            }
                        }
                        Err(e) => error!("Failed to parse atlas: {}", e),
                    }
                }
            }
            sleep(Duration::from_millis(100 * (attempt + 1))).await;
        }
        warn!("⚠️  Bootstrap failed - waiting for gossip convergence");
    }

    /// Flexible atlas parser that handles multiple JSON formats
    fn parse_atlas_flexible(value: &Value) -> Result<HashMap<String, AtlasEntry>, String> {
        // Strategy 1: Direct HashMap (Rust → Rust)
        if let Ok(entries) = serde_json::from_value::<HashMap<String, AtlasEntry>>(value.clone()) {
            debug!("Parsed atlas using Strategy 1 (direct HashMap)");
            return Ok(entries);
        }

        // Strategy 2: Wrapped in { "atlas": {...} } (TypeScript → Rust)
        if let Some(atlas_obj) = value.get("atlas") {
            if let Ok(entries) =
                serde_json::from_value::<HashMap<String, AtlasEntry>>(atlas_obj.clone())
            {
                debug!("Parsed atlas using Strategy 2 (wrapped atlas field)");
                return Ok(entries);
            } else {
                return Err(format!(
                    "Atlas field exists but failed to parse as HashMap<String, AtlasEntry>. Type: {:?}", 
                    atlas_obj
                ));
            }
        }

        // Strategy 3: Check if it's a bare result wrapper
        if let Some(result_obj) = value.get("result") {
            if let Some(atlas_obj) = result_obj.get("atlas") {
                if let Ok(entries) =
                    serde_json::from_value::<HashMap<String, AtlasEntry>>(atlas_obj.clone())
                {
                    debug!("Parsed atlas using Strategy 3 (result.atlas wrapper)");
                    return Ok(entries);
                }
            }
        }

        Err(format!(
            "Could not parse atlas using any strategy. Top-level keys: {:?}",
            value.as_object().map(|o| o.keys().collect::<Vec<_>>())
        ))
    }

    /// The core routing logic
    pub async fn route(self: &Arc<Self>, mut signal: Signal) -> TraceResult {
        let start = Instant::now();
        let _cid = signal.id.clone();

        // Check deadline
        if signal.is_expired() {
            return TraceResult::failure(
                signal.id.clone(),
                MeshError::new(ErrorCode::Timeout, "Signal deadline exceeded", &self.id)
                    .with_trace(signal.trace.clone()),
            );
        }

        // Check for shutdown
        if self.is_shutting_down.load(Ordering::SeqCst) > 0 {
            return TraceResult::failure(
                signal.id.clone(),
                MeshError::new(ErrorCode::NotReady, "Cell is shutting down", &self.id),
            );
        }

        // Deduplication check
        if self.seen_nonces.contains_key(&signal.id) {
            return TraceResult::success(
                signal.id.clone(),
                serde_json::json!({"_meshStatus": "DUPLICATE_ARRIVAL"}),
            );
        }
        self.seen_nonces.insert(signal.id.clone(), Instant::now());

        // Loop prevention
        if signal.visited_cell_ids.contains(&self.id) {
            return TraceResult::failure(
                signal.id.clone(),
                MeshError::new(ErrorCode::LoopDetected, "Signal loop detected", &self.id)
                    .with_trace(signal.trace.clone())
                    .with_history(signal.steps.clone()),
            );
        }

        // Record narrative
        signal.record_step(&self.id, "RECEIVED");
        signal.mark_visited(&self.id, &*self.addr.read().await);
        signal.hops += 1;
        signal.trace.push(format!("{}:{}", self.id, now_millis()));

        // Request joining - check if already executing
        let execution_key = format!("{}:{}", signal.id, signal.payload.capability);
        if let Some(existing) = self.active_executions.get(&execution_key) {
            let guard = existing.lock().await;
            if let Some(result) = guard.as_ref() {
                return result.clone();
            }
        }

        // Create execution slot
        let execution_slot = Arc::new(tokio::sync::Mutex::new(None));
        self.active_executions
            .insert(execution_key.clone(), Arc::clone(&execution_slot));

        // Execute
        let result = self.execute(signal).await;

        // Store result
        {
            let mut guard = execution_slot.lock().await;
            *guard = Some(result.clone());
        }
        self.active_executions.remove(&execution_key);

        // Cache successful results briefly
        if result.ok {
            self.result_cache
                .insert(result.cid.clone(), (result.clone(), Instant::now()));
        }

        // Update metrics
        self.metrics.requests_total.fetch_add(1, Ordering::SeqCst);
        if result.ok {
            self.metrics.requests_success.fetch_add(1, Ordering::SeqCst);
        } else {
            self.metrics.requests_failed.fetch_add(1, Ordering::SeqCst);
        }
        self.metrics
            .latency_sum_micros
            .fetch_add(start.elapsed().as_micros() as u64, Ordering::SeqCst);

        result.with_latency(start.elapsed())
    }

    async fn execute(self: &Arc<Self>, mut signal: Signal) -> TraceResult {
        let cap = &signal.payload.capability;
        let _cid = signal.id.clone();

        // Check local handlers
        if let Some(handler) = self.handlers.get(cap) {
            signal.record_step(&self.id, "LOCAL_HANDLER");
            let args = signal.payload.args.clone();
            let result = handler(args, signal).await;
            return result;
        }

        // Forward to peer
        self.forward_to_peer(signal).await
    }

    async fn forward_to_peer(self: &Arc<Self>, mut signal: Signal) -> TraceResult {
        let cap = signal.payload.capability.clone();
        let cid = signal.id.clone();
        let my_addr = self.addr.read().await.clone();

        // Find providers - FIXED: Use &String for contains
        let providers: Vec<AtlasEntry> = self
            .atlas
            .iter()
            .filter(|e| {
                let entry = e.value();
                entry.caps.contains(&cap) &&
                entry.addr != my_addr &&
                // Check Option<String> against Vec<String>
                entry.id.as_ref().map_or(true, |id| !signal.visited_cell_ids.contains(id)) &&
                !entry.addr.starts_with("client://")
            })
            .map(|e| e.value().clone())
            .collect();

        // Try direct routing first
        for (i, provider) in providers.iter().take(3).enumerate() {
            signal.record_step(&self.id, if i == 0 { "P2P_ROUTE" } else { "P2P_FAILOVER" });

            let result = self.rpc(&provider.addr, signal.clone()).await;

            if result.ok
                || result
                    .error
                    .as_ref()
                    .map(|e| e.code == ErrorCode::LoopDetected)
                    .unwrap_or(false)
            {
                return result;
            }

            // Record circuit failure
            self.circuits
                .entry(provider.addr.clone())
                .or_insert_with(|| CircuitBreaker::new(3, 30000))
                .record_failure();
        }

        // Try flooding if not attempted
        if !signal.flood_attempted {
            signal.flood_attempted = true;

            let neighbors: Vec<AtlasEntry> = self
                .atlas
                .iter()
                .filter(|e| {
                    let entry = e.value();
                    entry.addr != my_addr &&
                    // Check Option<String> against Vec<String>
                    entry.id.as_ref().map_or(true, |id| !signal.visited_cell_ids.contains(id)) &&
                    !providers.iter().any(|p| p.id == entry.id)
                })
                .map(|e| e.value().clone())
                .take(2)
                .collect();

            let flood_futures: Vec<_> = neighbors
                .into_iter()
                .map(|n| {
                    let cell = Arc::clone(self);
                    let signal = signal.clone();
                    async move { (n.id.clone(), cell.rpc(&n.addr, signal).await) }
                })
                .collect();

            let results = join_all(flood_futures).await;

            for (_id, result) in results {
                if result.ok {
                    return result;
                }
            }
        }

        // Try seed as last resort
        if let Some(seed) = &self.config.seed {
            if !signal.visited_addrs.contains(seed) {
                signal.record_step(&self.id, "SEED_FALLBACK");
                return self.rpc(seed, signal).await;
            }
        }

        // Not found
        let atlas_count = self.atlas.len();
        let known_caps: Vec<String> = self
            .atlas
            .iter()
            .flat_map(|e| e.value().caps.clone())
            .take(20)
            .collect();

        TraceResult::failure(
            cid,
            MeshError::new(
                ErrorCode::NotFound,
                format!(
            "Routing Failed: Cap '{}' not found. Atlas has {} peers. Known caps nearby: {:?}",
            cap, atlas_count, known_caps
        ),
                &self.id,
            )
            .with_trace(signal.trace)
            .with_history(signal.steps),
        )
    }

    /// RPC to another cell
    pub async fn rpc(self: &Arc<Self>, addr: &str, signal: Signal) -> TraceResult {
        // Check circuit breaker
        if let Some(circuit) = self.circuits.get(addr) {
            if circuit.is_open() {
                return TraceResult::failure(
                    signal.id,
                    MeshError::new(ErrorCode::CircuitOpen, "Circuit breaker open", addr),
                );
            }
        }

        let start = Instant::now();
        let result = self.rpc_raw(addr, signal).await;

        // Update circuit breaker
        if let Some(circuit) = self.circuits.get(addr) {
            if result.ok {
                circuit.record_success();
            } else {
                circuit.record_failure();
            }
        }

        result.with_latency(start.elapsed())
    }

    async fn rpc_raw(&self, addr: &str, signal: Signal) -> TraceResult {
        let cid = signal.id.clone();

        let client = match reqwest::Client::builder()
            .timeout(Duration::from_millis(self.config.rpc_timeout_ms))
            .pool_max_idle_per_host(100)
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                return TraceResult::failure(
                    cid,
                    MeshError::new(
                        ErrorCode::RpcFail,
                        format!("Client build failed: {}", e),
                        addr,
                    ),
                );
            }
        };

        let response = match client.post(addr).json(&signal).send().await {
            Ok(r) => r,
            Err(e) if e.is_timeout() => {
                return TraceResult::failure(
                    cid,
                    MeshError::new(ErrorCode::RpcTimeout, format!("RPC timeout: {}", e), addr),
                );
            }
            Err(e) if e.is_connect() => {
                return TraceResult::failure(
                    cid,
                    MeshError::new(
                        ErrorCode::RpcUnreachable,
                        format!("Unreachable: {}", e),
                        addr,
                    ),
                );
            }
            Err(e) => {
                return TraceResult::failure(
                    cid,
                    MeshError::new(ErrorCode::RpcFail, format!("RPC failed: {}", e), addr),
                );
            }
        };

        let _status = response.status();
        let body = match response.json::<Value>().await {
            Ok(b) => b,
            Err(e) => {
                return TraceResult::failure(
                    cid,
                    MeshError::new(ErrorCode::RpcFail, format!("Parse failed: {}", e), addr),
                );
            }
        };

        // Extract result from response envelope
        let result = body.get("result").cloned().unwrap_or(body);

        match serde_json::from_value::<TraceResult>(result) {
            Ok(r) => r,
            Err(e) => TraceResult::failure(
                cid,
                MeshError::new(
                    ErrorCode::RpcFail,
                    format!("Result parse failed: {}", e),
                    addr,
                ),
            ),
        }
    }

    /// Ask mesh with exponential backoff retry
    pub async fn ask_mesh(
        self: &Arc<Self>,
        capability: impl Into<String>,
        args: impl Serialize,
    ) -> TraceResult {
        let capability = capability.into();
        let start = Instant::now();
        let max_wait = Duration::from_secs(30);
        let mut delay = Duration::from_millis(100);

        loop {
            let signal =
                Signal::new(&self.id, &capability, &args).with_deadline(Duration::from_secs(10));

            let result = self.route(signal).await;

            if result.ok
                || result
                    .error
                    .as_ref()
                    .map(|e| e.code != ErrorCode::NotFound)
                    .unwrap_or(false)
            {
                return result;
            }

            if start.elapsed() >= max_wait {
                return result;
            }

            sleep(delay).await;
            delay = std::cmp::min(delay * 2, Duration::from_secs(5));

            // Refresh atlas periodically
            if delay.as_millis() % 1000 == 0 {
                self.merge_atlas(HashMap::new(), false);
            }
        }
    }

    /// Multicast to all providers of a capability - FIXED: Corrected timeout result handling
    pub async fn ask_all(
        self: &Arc<Self>,
        capability: impl Into<String>,
        args: impl Serialize,
        timeout_ms: u64,
    ) -> MulticastResult {
        let capability = capability.into();

        let providers: Vec<AtlasEntry> = self
            .atlas
            .iter()
            .filter(|e| e.value().caps.contains(&capability))
            .map(|e| e.value().clone())
            .collect();

        let futures: Vec<_> = providers
            .into_iter()
            .map(|provider| {
                let cell = Arc::clone(self);
                let capability = capability.clone();
                let args = &args;
                async move {
                    let start = Instant::now();
                    let signal = Signal::new(&cell.id, &capability, args);
                    let provider_id = provider.id.clone(); // Clone before moving

                    // FIXED: Handle timeout properly
                    match timeout(
                        Duration::from_millis(timeout_ms),
                        cell.rpc(&provider.addr, signal),
                    )
                    .await
                    {
                        Ok(result) => {
                            let cell_id =
                                provider_id.clone().unwrap_or_else(|| "unknown".to_string());
                            if result.ok {
                                MulticastItem {
                                    cell_id,
                                    result: result.value,
                                    latency_ms: start.elapsed().as_millis() as u64,
                                    error: None,
                                }
                            } else {
                                MulticastItem {
                                    cell_id,
                                    result: None,
                                    latency_ms: start.elapsed().as_millis() as u64,
                                    error: result.error,
                                }
                            }
                        }
                        Err(_) => {
                            let cell_id =
                                provider_id.clone().unwrap_or_else(|| "unknown".to_string());
                            MulticastItem {
                                cell_id: cell_id.clone(),
                                result: None,
                                latency_ms: timeout_ms,
                                error: Some(MeshError::new(
                                    ErrorCode::Timeout,
                                    "Multicast timeout",
                                    cell_id,
                                )),
                            }
                        }
                    }
                }
            })
            .collect();

        let results = join_all(futures).await;

        MulticastResult {
            results: results
                .iter()
                .filter(|r| r.error.is_none())
                .cloned()
                .collect(),
            failures: results
                .iter()
                .filter(|r| r.error.is_some())
                .cloned()
                .collect(),
        }
    }

    pub fn merge_atlas(&self, incoming: HashMap<String, AtlasEntry>, via_gossip: bool) {
        let now = now_millis();

        for (key_id, mut entry) in incoming {
            if key_id == self.id {
                continue;
            }

            // IMPORTANT: If the entry inside the JSON didn't have an ID,
            // use the Key from the Map.
            if entry.id.is_none() {
                entry.id = Some(key_id.clone());
            }

            // Skip stale entries
            if now.saturating_sub(entry.last_seen) > self.config.atlas_ttl_ms
                && !self.atlas.contains_key(&key_id)
            {
                continue;
            }

            entry.last_gossiped = now;
            if via_gossip {
                entry.gossip_hop_count = std::cmp::min(entry.gossip_hop_count + 1, 3);
            } else {
                entry.gossip_hop_count = 0;
                entry.last_seen = now;
            }

            match self.atlas.get(&key_id) {
                Some(existing) if entry.last_seen <= existing.last_seen && !via_gossip => {}
                _ => {
                    self.atlas.insert(key_id, entry);
                }
            }
        }
    }

    /// Graceful shutdown
    pub async fn shutdown(&self) {
        if self.is_shutting_down.swap(1, Ordering::SeqCst) > 0 {
            return; // Already shutting down
        }

        info!(cell_id = %self.id, "Initiating graceful shutdown...");

        // Signal server to stop
        if let Some(tx) = &self.shutdown_tx {
            let _ = tx.send(()).await;
        }

        // Wait for tasks with timeout
        let mut tasks = self.tasks.lock().await;
        for task in tasks.drain(..) {
            match timeout(Duration::from_secs(5), task).await {
                Ok(_) => {}
                Err(_) => {
                    warn!(cell_id = %self.id, "Task did not shutdown within timeout, force closing");
                }
            }
        }

        self.is_shutting_down.store(2, Ordering::SeqCst);
        info!(cell_id = %self.id, "Shutdown complete");
    }

    /// Create a type-safe mesh proxy
    pub fn mesh_proxy(self: &Arc<Self>) -> MeshProxy {
        MeshProxy {
            cell: Arc::clone(self),
        }
    }
}

/// Result of a multicast operation
#[derive(Debug, Clone)]
pub struct MulticastResult {
    pub results: Vec<MulticastItem>,
    pub failures: Vec<MulticastItem>,
}

#[derive(Debug, Clone)]
pub struct MulticastItem {
    pub cell_id: String,
    pub result: Option<Value>,
    pub latency_ms: u64,
    pub error: Option<MeshError>,
}

/// Type-safe mesh proxy for ergonomic API usage
pub struct MeshProxy {
    cell: Arc<RheoCell>,
}

impl MeshProxy {
    pub async fn call<T: DeserializeOwned>(
        &self,
        capability: impl Into<String>,
        args: impl Serialize,
    ) -> Result<T, MeshError> {
        let result = self.cell.ask_mesh(capability, args).await;
        if !result.ok {
            return Err(result
                .error
                .unwrap_or_else(|| MeshError::new(ErrorCode::Internal, "Unknown error", "proxy")));
        }
        result.into_value()
    }
}

// HTTP Handlers
async fn handle_signal(
    State(cell): State<Arc<RheoCell>>,
    Json(signal): Json<Signal>,
) -> impl IntoResponse {
    // Helpful for debugging unreachable issues
    debug!(
        capability = %signal.payload.capability,
        from = %signal.from,
        "Incoming signal"
    );

    let result = cell.route(signal).await;

    // WRAP the result in a "result" key for TS compatibility
    (
        StatusCode::OK,
        Json(serde_json::json!({ "result": result })),
    )
}

async fn handle_atlas(State(cell): State<Arc<RheoCell>>) -> impl IntoResponse {
    let atlas: HashMap<String, AtlasEntry> = cell
        .atlas
        .iter()
        .map(|e| (e.key().clone(), e.value().clone()))
        .collect();

    // Match TypeScript format: { atlas: {...} }
    (StatusCode::OK, Json(serde_json::json!({ "atlas": atlas })))
}

async fn handle_health(State(cell): State<Arc<RheoCell>>) -> impl IntoResponse {
    let health = serde_json::json!({
        "status": if cell.is_shutting_down.load(Ordering::SeqCst) == 0 { "healthy" } else { "shutting_down" },
        "cell_id": cell.id,
        "atlas_size": cell.atlas.len(),
        "capabilities": cell.handlers.len(),
    });
    (StatusCode::OK, Json(health))
}

// Utility functions
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// Clone implementation for RheoCell (partial)
impl Clone for RheoCell {
    fn clone(&self) -> Self {
        Self {
            id: self.id.clone(),
            addr: Arc::clone(&self.addr),
            port: self.port,
            config: self.config.clone(),
            signing_key: SigningKey::from_bytes(&self.signing_key.to_bytes()),
            verifying_key: self.verifying_key,
            pub_key_hex: self.pub_key_hex.clone(),
            atlas: Arc::clone(&self.atlas),
            handlers: Arc::clone(&self.handlers),
            circuits: Arc::clone(&self.circuits),
            seen_nonces: Arc::clone(&self.seen_nonces),
            active_executions: Arc::clone(&self.active_executions),
            result_cache: Arc::clone(&self.result_cache),
            metrics: Arc::clone(&self.metrics),
            shutdown_tx: None, // Don't clone sender
            is_shutting_down: Arc::clone(&self.is_shutting_down),
            tasks: Arc::clone(&self.tasks),
        }
    }
}

// ============================================================================
// TYPED ROUTER SYSTEM
// ============================================================================

pub mod router {
    use super::*;
    use std::marker::PhantomData;

    /// Schema trait for validation
    pub trait Schema: Send + Sync {
        fn parse(&self, value: Value) -> Result<Value, MeshError>;
    }

    /// JSON schema validator
    pub struct JsonSchema<T> {
        _phantom: PhantomData<T>,
    }

    impl<T> Default for JsonSchema<T> {
        fn default() -> Self {
            Self {
                _phantom: PhantomData,
            }
        }
    }

    impl<T: DeserializeOwned + Send + Sync> Schema for JsonSchema<T> {
        fn parse(&self, value: Value) -> Result<Value, MeshError> {
            serde_json::from_value::<T>(value.clone()).map_err(|e| {
                MeshError::new(
                    ErrorCode::ValidationFailed,
                    format!("Schema validation: {}", e),
                    "schema",
                )
            })?;
            Ok(value)
        }
    }

    /// Procedure definition - FIXED: Added Clone bound
    pub struct Procedure<I, O> {
        input_schema: Option<Box<dyn Schema>>,
        output_schema: Option<Box<dyn Schema>>,
        handler: Box<
            dyn Fn(I, Signal) -> futures::future::BoxFuture<'static, Result<O, MeshError>>
                + Send
                + Sync,
        >,
        is_mutation: bool,
    }

    impl<I, O> Procedure<I, O>
    where
        I: DeserializeOwned + Send + 'static,
        O: Serialize + Send + 'static,
    {
        pub fn query<F, Fut>(handler: F) -> Self
        where
            F: Fn(I, Signal) -> Fut + Send + Sync + 'static,
            Fut: std::future::Future<Output = Result<O, MeshError>> + Send + 'static,
        {
            Self {
                input_schema: None,
                output_schema: None,
                handler: Box::new(move |i, s| Box::pin(handler(i, s))),
                is_mutation: false,
            }
        }

        pub fn mutation<F, Fut>(handler: F) -> Self
        where
            F: Fn(I, Signal) -> Fut + Send + Sync + 'static,
            Fut: std::future::Future<Output = Result<O, MeshError>> + Send + 'static,
        {
            Self {
                input_schema: None,
                output_schema: None,
                handler: Box::new(move |i, s| Box::pin(handler(i, s))),
                is_mutation: true,
            }
        }

        pub fn with_input_schema<S: Schema + 'static>(mut self, schema: S) -> Self {
            self.input_schema = Some(Box::new(schema));
            self
        }

        // FIXED: Share handler across calls
        pub fn into_boxed(self) -> BoxedHandler {
            let handler = Arc::new(self.handler);
            Box::new(move |args, signal| {
                let handler = Arc::clone(&handler);
                let signal_id = signal.id.clone();
                Box::pin(async move {
                    let input: I = match serde_json::from_value(args) {
                        Ok(i) => i,
                        Err(e) => {
                            return TraceResult::failure(
                                signal_id,
                                MeshError::new(
                                    ErrorCode::ValidationFailed,
                                    format!("Input: {}", e),
                                    "procedure",
                                ),
                            );
                        }
                    };

                    match handler(input, signal).await {
                        Ok(output) => TraceResult::success(signal_id, output),
                        Err(e) => TraceResult::failure(signal_id, e),
                    }
                })
            })
        }
    }

    /// Router builder for organizing capabilities
    pub struct Router {
        handlers: HashMap<String, BoxedHandler>,
    }

    impl Router {
        pub fn new() -> Self {
            Self {
                handlers: HashMap::new(),
            }
        }

        pub fn procedure<I, O>(mut self, path: impl Into<String>, proc: Procedure<I, O>) -> Self
        where
            I: DeserializeOwned + Send + 'static,
            O: Serialize + Send + 'static,
        {
            self.handlers.insert(path.into(), proc.into_boxed());
            self
        }

        pub fn nest(mut self, prefix: impl Into<String>, router: Router) -> Self {
            let prefix = prefix.into();
            for (path, handler) in router.handlers {
                self.handlers
                    .insert(format!("{}/{}", prefix, path), handler);
            }
            self
        }

        pub fn into_handlers(self) -> HashMap<String, BoxedHandler> {
            self.handlers
        }
    }

    impl Default for Router {
        fn default() -> Self {
            Self::new()
        }
    }
}

// ============================================================================
// TRADING-SPECIFIC EXTENSIONS
// ============================================================================

pub mod trading {
    use super::*;
    use serde::{Deserialize, Serialize};

    /// High-performance order type
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct Order {
        pub id: String,
        pub symbol: String,
        pub side: Side,
        pub price: f64,
        pub quantity: f64,
        pub timestamp: u64,
        pub client_id: String,
    }

    #[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
    pub enum Side {
        Buy,
        Sell,
    }

    /// Market data tick
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct Tick {
        pub symbol: String,
        pub bid: f64,
        pub ask: f64,
        pub last: f64,
        pub volume: f64,
        pub timestamp: u64,
    }

    /// Position tracking
    #[derive(Debug, Clone, Serialize, Deserialize, Default)]
    pub struct Position {
        pub symbol: String,
        pub quantity: f64,
        pub avg_entry: f64,
        pub unrealized_pnl: f64,
        pub realized_pnl: f64,
    }

    /// Risk limits
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct RiskLimits {
        pub max_position: f64,
        pub max_order_size: f64,
        pub max_daily_loss: f64,
        pub max_drawdown: f64,
    }

    /// Trading cell with specialized handlers
    pub struct TradingCell {
        cell: Arc<RheoCell>,
        orders: Arc<DashMap<String, Order>>,
        positions: Arc<DashMap<String, Position>>,
        risk_limits: Arc<RwLock<RiskLimits>>,
    }

    impl TradingCell {
        pub fn new(cell: Arc<RheoCell>, risk_limits: RiskLimits) -> Self {
            let trading = Self {
                cell: Arc::clone(&cell),
                orders: Arc::new(DashMap::new()),
                positions: Arc::new(DashMap::new()),
                risk_limits: Arc::new(RwLock::new(risk_limits)),
            };

            trading.register_handlers();
            trading
        }

        fn register_handlers(&self) {
            let orders = Arc::clone(&self.orders);
            self.cell
                .provide("trading/place_order", move |order: Order, _signal| {
                    let orders = Arc::clone(&orders);
                    Box::pin(async move {
                        // Validate order
                        if order.quantity <= 0.0 || order.price <= 0.0 {
                            return Err(MeshError::new(
                                ErrorCode::ValidationFailed,
                                "Invalid order parameters",
                                "trading",
                            ));
                        }

                        orders.insert(order.id.clone(), order.clone());
                        Ok(serde_json::json!({
                            "status": "accepted",
                            "order_id": order.id
                        }))
                    })
                });

            let positions = Arc::clone(&self.positions);
            self.cell
                .provide("trading/get_position", move |symbol: String, _signal| {
                    let positions = Arc::clone(&positions);
                    Box::pin(async move {
                        let pos = positions.get(&symbol).map(|p| p.clone());
                        Ok(pos.unwrap_or_default())
                    })
                });

            let cell = Arc::clone(&self.cell);
            self.cell
                .provide("trading/market_data", move |_args: (), _signal| {
                    let cell = Arc::clone(&cell);
                    Box::pin(async move {
                        // Multicast to all market data providers
                        let result = cell.ask_all("marketdata/tick", (), 100).await;
                        let ticks: Vec<Tick> = result
                            .results
                            .into_iter()
                            .filter_map(|item| {
                                item.result.and_then(|v| serde_json::from_value(v).ok())
                            })
                            .collect();
                        Ok(ticks)
                    })
                });
        }

        pub async fn place_order(&self, order: Order) -> Result<Value, MeshError> {
            self.cell
                .mesh_proxy()
                .call("trading/place_order", order)
                .await
        }

        pub async fn get_position(&self, symbol: impl Into<String>) -> Result<Position, MeshError> {
            self.cell
                .mesh_proxy()
                .call("trading/get_position", symbol.into())
                .await
        }
    }
}

// ============================================================================
// EXAMPLE USAGE
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_cell_creation() {
        let cell = RheoCell::new(CellConfig::default());
        let addr = cell.listen().await.unwrap();
        assert!(addr.port() > 0);

        // Test ping
        let result = cell.ask_mesh("mesh/ping", ()).await;
        assert!(result.ok);

        cell.shutdown().await;
    }

    #[tokio::test]
    async fn test_cell_communication() {
        let cell1 = RheoCell::new(CellConfig {
            id: "cell_1".to_string(),
            ..Default::default()
        });
        let addr1 = cell1.listen().await.unwrap();

        // Register custom handler
        cell1.provide("test/echo", |msg: String, _| {
            Box::pin(async move { Ok(format!("echo: {}", msg)) })
        });

        // Wait for convergence
        sleep(Duration::from_millis(100)).await;

        let cell2 = RheoCell::new(CellConfig {
            id: "cell_2".to_string(),
            seed: Some(format!("http://127.0.0.1:{}", addr1.port())),
            ..Default::default()
        });
        cell2.listen().await.unwrap();

        // Wait for bootstrap
        sleep(Duration::from_millis(500)).await;

        // Test cross-cell call
        let result: Result<String, MeshError> =
            cell2.mesh_proxy().call("test/echo", "hello world").await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "echo: hello world");

        cell1.shutdown().await;
        cell2.shutdown().await;
    }
}
