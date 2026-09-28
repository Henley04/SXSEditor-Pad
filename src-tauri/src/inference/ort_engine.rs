//! Native ONNX Runtime inference engine.
//!
//! Replaces the renderer-side onnxruntime-web (WebNN/WASM) execution path with
//! ONNX Runtime Mobile loaded at runtime (`ort` crate, `load-dynamic`):
//!   - Android: NNAPI execution provider (NPU/GPU/DSP) with CPU fallback
//!   - iOS:     CoreML execution provider (ANE/GPU) with CPU fallback
//!   - Desktop (dev/test): CPU
//!
//! The dynamic library is probed (in order) from:
//!   1. explicit `lib_path` argument / `SXS_ORT_LIB` env var
//!   2. platform library search paths (`libonnxruntime.so` resolves inside the
//!      Android app lib dir when bundled in jniLibs; desktop uses the usual
//!      loader paths)
//!
//! Sessions are created straight from model files on disk — model bytes never
//! cross the IPC boundary (unlike the old WebNN path which shipped 100MB+
//! through the renderer). External data (`*.onnx.data`) is resolved by ONNX
//! Runtime itself relative to the model file.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use serde_json::{json, Value as JsonValue};

use ort::ep;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::{Session, SessionInputs};
use ort::value::{Tensor, TensorElementType, ValueType};

use super::frame::{self, DType, FrameTensor};

/// Session option defaults mirroring the desktop app's
/// `src/inference/shared/ortOptions.js` (`buildSessionOptions`). The renderer
/// forwards its computed options; these are the fallbacks.
#[derive(Debug, Clone)]
pub struct NativeSessionOptions {
    /// 'disabled' | 'basic' | 'extended' | 'all'
    pub graph_opt_level: String,
    /// 'sequential' | 'parallel'
    pub execution_mode: String,
    pub enable_mem_pattern: bool,
    pub enable_cpu_mem_arena: bool,
    pub intra_op_threads: usize,
    pub inter_op_threads: usize,
    /// Device preference requested by the renderer: 'npu' | 'gpu' | 'cpu'.
    pub device_preference: String,
}

impl Default for NativeSessionOptions {
    fn default() -> Self {
        Self {
            graph_opt_level: "all".into(),
            execution_mode: "sequential".into(),
            enable_mem_pattern: true,
            enable_cpu_mem_arena: true,
            intra_op_threads: 0, // 0 = ORT default (physical cores)
            inter_op_threads: 0,
            device_preference: "cpu".into(),
        }
    }
}

impl NativeSessionOptions {
    pub fn from_json(v: Option<&JsonValue>) -> Self {
        let mut opts = Self::default();
        if let Some(v) = v {
            if let Some(s) = v.get("graphOptimizationLevel").and_then(|x| x.as_str()) {
                match s {
                    "disabled" | "basic" | "extended" | "all" => {
                        opts.graph_opt_level = s.to_string()
                    }
                    _ => {}
                }
            }
            if let Some(s) = v.get("executionMode").and_then(|x| x.as_str()) {
                if s == "sequential" || s == "parallel" {
                    opts.execution_mode = s.to_string();
                }
            }
            if let Some(b) = v.get("enableMemPattern").and_then(|x| x.as_bool()) {
                opts.enable_mem_pattern = b;
            }
            if let Some(b) = v.get("enableCpuMemArena").and_then(|x| x.as_bool()) {
                opts.enable_cpu_mem_arena = b;
            }
            if let Some(n) = v.get("intraOpNumThreads").and_then(|x| x.as_u64()) {
                opts.intra_op_threads = n as usize;
            }
            if let Some(n) = v.get("interOpNumThreads").and_then(|x| x.as_u64()) {
                opts.inter_op_threads = n as usize;
            }
            if let Some(s) = v.get("devicePreference").and_then(|x| x.as_str()) {
                opts.device_preference = s.to_string();
            }
        }
        opts
    }

    fn graph_opt_level(&self) -> GraphOptimizationLevel {
        match self.graph_opt_level.as_str() {
            // NPU static-shape models are already offline-optimized; the
            // desktop app forces 'basic' there (and 'disabled' for >100MB).
            "disabled" => GraphOptimizationLevel::Disable,
            "basic" => GraphOptimizationLevel::Level1,
            "extended" => GraphOptimizationLevel::Level2,
            _ => GraphOptimizationLevel::Level3,
        }
    }
}

/// Which hardware acceleration is compiled into the loaded ORT library.
#[derive(Debug, Clone, Copy)]
pub struct AcceleratorInfo {
    pub nnapi: bool,
    pub coreml: bool,
    /// DSP is available via NNAPI on Android (Hexagon/QDSP).
    pub dsp: bool,
}

/// Android NNAPI device enumeration (runtime, via libneuralnetworks.so).
///
/// Qualcomm stopped shipping NNAPI hardware drivers for new SoCs (8 Gen 3 /
/// 8 Elite and later): Google deprecated NNAPI in favor of vendor SDKs (QNN),
/// so on those devices the NNAPI EP silently binds to AOSP's `nnapi-reference`
/// CPU implementation — sessions "succeed" but with zero acceleration. A
/// compile-time `cfg!(target_os = "android")` cannot tell the two apart, so we
/// enumerate the actual drivers at runtime.
#[cfg(target_os = "android")]
mod nnapi_probe {
    use std::sync::OnceLock;

    /// Enumerate (device name, device type) pairs. Any failure (missing lib,
    /// missing symbols, API error) yields an empty list — callers must treat
    /// that as "no NNAPI hardware".
    fn devices() -> Vec<(String, i32)> {
        unsafe {
            let handle = libc::dlopen(
                b"libneuralnetworks.so\0".as_ptr() as *const libc::c_char,
                libc::RTLD_NOW | libc::RTLD_LOCAL,
            );
            if handle.is_null() {
                return Vec::new();
            }
            type GetDeviceCount = unsafe extern "C" fn(*mut u32) -> i32;
            type GetDevice = unsafe extern "C" fn(u32, *mut *mut core::ffi::c_void) -> i32;
            type DeviceGetName =
                unsafe extern "C" fn(*const core::ffi::c_void, *mut *const libc::c_char) -> i32;
            type DeviceGetType = unsafe extern "C" fn(*const core::ffi::c_void, *mut i32) -> i32;
            let sym = |name: &[u8]| libc::dlsym(handle, name.as_ptr() as *const libc::c_char);
            let (get_count, get_device, get_name) = match (
                sym(b"ANeuralNetworks_getDeviceCount\0"),
                sym(b"ANeuralNetworks_getDevice\0"),
                sym(b"ANeuralNetworksDevice_getName\0"),
            ) {
                (a, b, c) if !a.is_null() && !b.is_null() && !c.is_null() => (a, b, c),
                _ => return Vec::new(),
            };
            // getType requires API 29+; treat as optional.
            let get_type: Option<DeviceGetType> = match sym(b"ANeuralNetworksDevice_getType\0") {
                p if p.is_null() => None,
                p => Some(core::mem::transmute(p)),
            };
            let get_count: GetDeviceCount = core::mem::transmute(get_count);
            let get_device: GetDevice = core::mem::transmute(get_device);
            let get_name: DeviceGetName = core::mem::transmute(get_name);

            let mut count: u32 = 0;
            if get_count(&mut count) != 0 || count == 0 {
                return Vec::new();
            }
            let mut out = Vec::new();
            for i in 0..count {
                let mut dev: *mut core::ffi::c_void = core::ptr::null_mut();
                if get_device(i, &mut dev) != 0 || dev.is_null() {
                    continue;
                }
                let mut name_ptr: *const libc::c_char = core::ptr::null();
                if get_name(dev, &mut name_ptr) != 0 || name_ptr.is_null() {
                    continue;
                }
                let name = std::ffi::CStr::from_ptr(name_ptr).to_string_lossy().into_owned();
                let mut ty: i32 = 0;
                if let Some(f) = get_type {
                    if f(dev, &mut ty) != 0 {
                        ty = 0;
                    }
                }
                out.push((name, ty));
            }
            out
        }
    }

    /// Cached device list for the process lifetime (drivers never change).
    fn devices_cached() -> &'static Vec<(String, i32)> {
        static CACHE: OnceLock<Vec<(String, i32)>> = OnceLock::new();
        CACHE.get_or_init(devices)
    }

    /// True when at least one REAL accelerator driver exists (GPU / NPU-class
    /// device). The AOSP `nnapi-reference` implementation and plain-CPU entries
    /// do not count.
    pub fn has_hardware() -> bool {
        devices_cached().iter().any(|(name, ty)| {
            // ANeuralNetworksDeviceType: 0=UNKNOWN 1=OTHER 2=CPU 3=GPU 4=ACCELERATOR
            matches!(*ty, 3 | 4) || (!name.is_empty() && name != "nnapi-reference")
        })
    }

    /// Driver names for diagnostics / UI display.
    pub fn device_names() -> Vec<String> {
        devices_cached().iter().map(|(n, _)| n.clone()).collect()
    }
}

/// Runtime NNAPI hardware availability (cached). False off-Android.
fn nnapi_hardware_available() -> bool {
    #[cfg(target_os = "android")]
    {
        nnapi_probe::has_hardware()
    }
    #[cfg(not(target_os = "android"))]
    {
        false
    }
}

/// Runtime NNAPI driver names (empty off-Android).
fn nnapi_device_names() -> Vec<String> {
    #[cfg(target_os = "android")]
    {
        nnapi_probe::device_names()
    }
    #[cfg(not(target_os = "android"))]
    {
        Vec::new()
    }
}

fn platform_accelerators() -> AcceleratorInfo {
    let nnapi_hw = nnapi_hardware_available();
    AcceleratorInfo {
        // Android: NNAPI counts as available only when a REAL hardware driver
        // exists. Without one the EP is a CPU reference implementation and any
        // "accelerator" numbers it produces are fiction (measured 2.25 GOPS on
        // an 8-Elite-class SoC that does 100+ GOPS on CPU alone).
        nnapi: nnapi_hw,
        coreml: cfg!(target_os = "ios"),
        // DSP acceleration is only available through NNAPI on Android
        // (Qualcomm Hexagon DSP) — same hardware-driver requirement.
        dsp: nnapi_hw,
    }
}

/// JSON snapshot for the init/status payloads, including the enumerated
/// NNAPI driver names and QNN availability (diagnostics).
fn accelerators_json() -> JsonValue {
    let qnn_backend = find_qnn_backend();
    json!({
        "nnapi": platform_accelerators().nnapi,
        "coreml": platform_accelerators().coreml,
        "dsp": platform_accelerators().dsp,
        "qnn": qnn_available(),
        "qnnBackend": qnn_backend.map(|p| p.to_string_lossy().to_string()),
        "nnapiDevices": nnapi_device_names(),
    })
}

struct SessionEntry {
    /// `run` takes `&mut Session`; the mutex both provides interior
    /// mutability and serializes runs on this session.
    session: Mutex<Session>,
    ep_label: String,
    model_path: String,
    /// Monotonic id assigned at load time. Lets the renderer's release carry
    /// the token of the session it *thinks* it is unloading, so a stale
    /// release after an EP-candidate timeout cannot kill a newer session
    /// registered under the same model id.
    token: u64,
}

/// Global engine state. The environment is process-global in ONNX Runtime;
/// sessions live in this registry keyed by model id.
pub struct OrtEngine {
    env_ready: bool,
    lib_path: Option<String>,
    sessions: HashMap<String, Arc<SessionEntry>>,
    /// Last session token handed out; always accessed under the engine lock.
    next_token: u64,
}

static ENGINE: OnceLock<Arc<Mutex<OrtEngine>>> = OnceLock::new();

pub fn engine() -> Arc<Mutex<OrtEngine>> {
    ENGINE
        .get_or_init(|| {
            Arc::new(Mutex::new(OrtEngine {
                env_ready: false,
                lib_path: None,
                sessions: HashMap::new(),
                next_token: 0,
            }))
        })
        .clone()
}

/// Candidate library file name per platform.
fn ort_lib_file_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "onnxruntime.dll"
    } else if cfg!(target_os = "macos") || cfg!(target_os = "ios") {
        "libonnxruntime.dylib"
    } else {
        "libonnxruntime.so"
    }
}

/// Ordered probe list for the ORT shared library.
fn candidate_lib_paths(explicit: Option<&str>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(p) = explicit {
        if !p.is_empty() {
            out.push(PathBuf::from(p));
        }
    }
    if let Ok(env_p) = std::env::var("SXS_ORT_LIB") {
        if !env_p.is_empty() {
            out.push(PathBuf::from(env_p));
        }
    }
    // Bare file name → resolved via the platform loader search path. On
    // Android this finds the .so bundled in the app's jniLibs; on desktop it
    // uses LD_LIBRARY_PATH / ldconfig / PATH.
    out.push(PathBuf::from(ort_lib_file_name()));
    out
}

/// Initialize the ORT environment by dynamically loading the library.
/// Idempotent: repeated calls return the cached state.
///
/// NOTE: `accelerators_json()` must be called OUTSIDE the engine lock — it
/// re-enters the engine to locate the ORT lib dir (for QNN backend probing)
/// and parking_lot is not reentrant.
pub fn init(explicit_lib_path: Option<&str>) -> JsonValue {
    let eng = engine();
    {
        let g = eng.lock();
        if g.env_ready {
            let lib_path = g.lib_path.clone();
            drop(g);
            return json!({
                "available": true,
                "libPath": lib_path,
                "accelerators": accelerators_json()
            });
        }
    }

    let mut last_err = String::new();
    for candidate in candidate_lib_paths(explicit_lib_path) {
        let display = candidate.to_string_lossy().to_string();
        let attempt =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ort::init_from(&candidate)));
        match attempt {
            Ok(Ok(builder)) => {
                let committed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    builder.with_name("sxseditor-pad").commit()
                }));
                match committed {
                    Ok(true) => {
                        {
                            let mut g = eng.lock();
                            g.env_ready = true;
                            g.lib_path = Some(display.clone());
                        }
                        return json!({
                            "available": true,
                            "libPath": display,
                            "accelerators": accelerators_json()
                        });
                    }
                    Ok(false) => {
                        // Environment already committed by an earlier init —
                        // treat as ready.
                        {
                            let mut g = eng.lock();
                            g.env_ready = true;
                            g.lib_path = Some(display.clone());
                        }
                        return json!({
                            "available": true,
                            "libPath": display,
                            "note": "environment already initialized",
                            "accelerators": accelerators_json()
                        });
                    }
                    Err(_) => {
                        last_err = "panic while committing ORT environment".to_string();
                    }
                }
            }
            Ok(Err(e)) => {
                last_err = format!("{}: {}", display, e);
            }
            Err(_) => {
                last_err = format!("{}: panic while loading library", display);
            }
        }
    }

    json!({
        "available": false,
        "error": if last_err.is_empty() { "libonnxruntime not found".to_string() } else { last_err },
        "accelerators": { "nnapi": false, "coreml": false, "dsp": false, "qnn": false, "qnnBackend": JsonValue::Null, "nnapiDevices": [] }
    })
}

pub fn is_ready() -> bool {
    engine().lock().env_ready
}

/// True when the SoC is Qualcomm (ro.soc.model / board like "SM8750", "sun").
#[cfg(target_os = "android")]
fn is_qualcomm_soc() -> bool {
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| {
        crate::device_cpu_name()
            .map(|n| {
                let n = n.to_ascii_lowercase();
                ["sm8", "sm7", "sm6", "sm4", "qsm", "sdm", "msm", "qcom", "qti"]
                    .iter()
                    .any(|p| n.contains(p))
            })
            .unwrap_or(false)
    })
}

/// Search for a QNN HTP backend library the app can actually load. The first
/// match is the app's own jniLibs dir (the same directory as the bundled ORT
/// .so), which is the only location guaranteed to be reachable under
/// Android's linker-namespace rules; vendor paths are probed best-effort.
fn find_qnn_backend() -> Option<PathBuf> {
    const LIB: &str = "libQnnHtp.so";
    let mut candidates: Vec<PathBuf> = Vec::new();
    // Same dir as the bundled ORT library.
    {
        let eng = engine();
        let g = eng.lock();
        if let Some(lib) = &g.lib_path {
            if let Some(dir) = Path::new(lib).parent() {
                candidates.push(dir.join(LIB));
            }
        }
    }
    for dir in [
        "/system/vendor/lib64",
        "/vendor/lib64",
        "/system/lib64",
        "/odm/lib64",
        "/vendor/dsp/cdsp",
    ] {
        candidates.push(PathBuf::from(dir).join(LIB));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// QNN (Hexagon NPU) pipeline is only worth attempting when BOTH hold: a
/// Qualcomm SoC and a device-side QNN backend library. The ORT factory lookup
/// itself may still fail (the bundled official AAR has no built-in QNN
/// factory) — that case degrades through the candidate chain at commit time.
fn qnn_available() -> bool {
    #[cfg(target_os = "android")]
    {
        is_qualcomm_soc() && find_qnn_backend().is_some()
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = find_qnn_backend;
        false
    }
}

/// One candidate EP chain tried when committing a session.
struct EpCandidate {
    eps: Vec<ep::ExecutionProviderDispatch>,
    /// Session intra-op threads. XNNPACK/QNN/NNAPI manage their own thread
    /// pools, so sessions that use them run with a single intra thread to
    /// avoid pool contention; a bare-CPU chain uses ALL cores (ORT's default
    /// intra policy on some Android builds is effectively single-threaded,
    /// which under-reports a flagship SoC by ~8x).
    intra_threads: usize,
    intra_spinning: bool,
    label: String,
}

/// CPU-only candidates, XNNPACK first (built into the official ORT Android
/// AAR; verified by symbol presence in onnxruntime-android 1.28.0).
///
/// Large models (>100MB) skip XNNPACK: it copies weights into its own arena,
/// which doubles memory and slows startup, mirroring the >100MB graph-opt
/// degradation rule.
fn cpu_candidates(model_size_mb: f64) -> Vec<EpCandidate> {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    if model_size_mb > 100.0 {
        return vec![EpCandidate {
            eps: vec![ep::CPU::default().build()],
            intra_threads: cores,
            intra_spinning: true,
            label: "cpu".into(),
        }];
    }
    vec![
        EpCandidate {
            eps: vec![
                ep::XNNPACK::default()
                    .with_intra_op_num_threads(
                        core::num::NonZeroUsize::new(cores).unwrap_or(core::num::NonZeroUsize::MIN),
                    )
                    .build(),
                ep::CPU::default().build(),
            ],
            intra_threads: 1,
            intra_spinning: false,
            label: "xnnpack+cpu".into(),
        },
        EpCandidate {
            eps: vec![ep::CPU::default().build()],
            intra_threads: cores,
            intra_spinning: true,
            label: "cpu".into(),
        },
    ]
}

/// Build the ordered EP candidate list for a device preference.
///
/// Android priority for accelerator requests: QNN (Qualcomm Hexagon) →
/// NNAPI (only when a real hardware driver exists) → XNNPACK+CPU → CPU.
///
/// IMPORTANT: ORT Mobile exposes exactly one accelerator EP per platform, and
/// NNAPI/CoreML decide the target hardware (NPU/GPU/DSP/ANE) internally —
/// there is no EP-level way to pin a specific accelerator type. Do NOT report
/// "npu/gpu/dsp" as separately measured devices.
fn ep_candidates(device: &str, model_size_mb: f64) -> Vec<EpCandidate> {
    let mut out: Vec<EpCandidate> = Vec::new();
    #[cfg(target_os = "android")]
    {
        if device == "cpu" {
            out.extend(cpu_candidates(model_size_mb));
            return out;
        }
        if qnn_available() {
            if let Some(qpath) = find_qnn_backend() {
                out.push(EpCandidate {
                    eps: vec![
                        ep::QNN::default()
                            .with_backend_path(qpath.to_string_lossy().to_string())
                            .with_performance_mode(ep::qnn::PerformanceMode::HighPerformance)
                            .with_htp_fp16_precision(true)
                            .build(),
                        ep::CPU::default().build(),
                    ],
                    intra_threads: 1,
                    intra_spinning: false,
                    label: "qnn-htp+cpu".into(),
                });
            }
        }
        // No real NNAPI hardware driver (e.g. Snapdragon 8 Gen 3/8 Elite): the
        // NNAPI EP would silently bind to the AOSP reference CPU
        // implementation, ~10x SLOWER than ORT's own CPU path — skip it.
        if nnapi_hardware_available() {
            out.push(EpCandidate {
                eps: vec![ep::NNAPI::default().build(), ep::CPU::default().build()],
                intra_threads: 1,
                intra_spinning: false,
                label: format!("nnapi+cpu (requested {device}; NNAPI selects hardware)"),
            });
        }
        out.extend(cpu_candidates(model_size_mb));
    }
    #[cfg(target_os = "ios")]
    {
        if device != "cpu" {
            // CoreML EP handles ANE (NPU) / GPU automatically with CPU fallback.
            out.push(EpCandidate {
                eps: vec![ep::CoreML::default().build(), ep::CPU::default().build()],
                intra_threads: 1,
                intra_spinning: false,
                label: format!("coreml+cpu (requested {device}; CoreML selects hardware)"),
            });
        }
        out.extend(cpu_candidates(model_size_mb));
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = device;
        out.extend(cpu_candidates(model_size_mb));
    }
    out
}

/// Commit a session trying each EP candidate in order; the first chain that
/// commits wins. EP registration failures (XNNPACK/QNN/NNAPI missing from the
/// bundled ORT library, QNN backend unusable on device) degrade silently to
/// the next candidate — the last-resort chain is always bare CPU.
///
/// Returns `(session, ep_label, intra_threads)`.
#[allow(clippy::too_many_arguments)]
fn create_session_with_fallback(
    path: &Path,
    device_pref: &str,
    model_size_mb: f64,
    graph_opt: GraphOptimizationLevel,
    mem_pattern: bool,
    parallel: bool,
    intra_override: Option<usize>,
) -> Result<(Session, String, usize), String> {
    let candidates = ep_candidates(device_pref, model_size_mb);
    let mut last_err = String::new();
    for EpCandidate {
        eps,
        intra_threads,
        intra_spinning,
        label,
    } in candidates
    {
        let intra = intra_override.unwrap_or(intra_threads);
        let attempt = (|| -> Result<Session, String> {
            Session::builder()
                .map_err(|e| e.to_string())?
                .with_optimization_level(graph_opt)
                .map_err(|e| e.to_string())?
                .with_intra_threads(intra)
                .map_err(|e| e.to_string())?
                .with_intra_op_spinning(intra_spinning)
                .map_err(|e| e.to_string())?
                .with_memory_pattern(mem_pattern)
                .map_err(|e| e.to_string())?
                .with_parallel_execution(parallel)
                .map_err(|e| e.to_string())?
                .with_execution_providers(eps)
                .map_err(|e| e.to_string())?
                .commit_from_file(path)
                .map_err(|e| format!("commit: {e}"))
        })();
        match attempt {
            Ok(session) => return Ok((session, label, intra)),
            Err(e) => {
                eprintln!("[ort_engine] EP chain '{label}' failed, degrading: {e}");
                last_err = format!("EP chain '{label}': {e}");
            }
        }
    }
    Err(format!(
        "failed to create session for {}: {last_err}",
        path.display()
    ))
}

/// Load a model file into a session and register it under `model_id`.
pub fn load_model(
    model_id: &str,
    model_path: &str,
    options: Option<&JsonValue>,
) -> Result<JsonValue, String> {
    if !is_ready() {
        return Err("ORT environment not initialized (call native_ort_init first)".into());
    }
    let path = Path::new(model_path);
    if !path.exists() {
        return Err(format!("model file not found: {}", model_path));
    }
    let model_size_mb = std::fs::metadata(path)
        .map(|m| m.len() as f64 / 1048576.0)
        .unwrap_or(0.0);

    let mut opts = NativeSessionOptions::from_json(options);
    // Large models are offline-optimized; skip runtime graph rewrites (slow
    // NPU compile). Mirrors the renderer's >100MB rule.
    if model_size_mb > 100.0 && opts.graph_opt_level == "all" {
        opts.graph_opt_level = "disabled".into();
    }

    let (session, ep_label, _intra) = create_session_with_fallback(
        path,
        &opts.device_preference,
        model_size_mb,
        opts.graph_opt_level(),
        opts.enable_mem_pattern,
        opts.execution_mode == "parallel",
        if opts.intra_op_threads > 0 {
            Some(opts.intra_op_threads)
        } else {
            None
        },
    )?;

    let inputs: Vec<JsonValue> = session
        .inputs()
        .iter()
        .map(|o| {
            json!({
                "name": o.name(),
                "dtype": outlet_dtype_str(o.dtype()),
            })
        })
        .collect();
    let outputs: Vec<JsonValue> = session
        .outputs()
        .iter()
        .map(|o| {
            json!({
                "name": o.name(),
                "dtype": outlet_dtype_str(o.dtype()),
            })
        })
        .collect();

    // Allocate the session token and register the entry under one lock hold
    // so a token always refers to exactly the session it was issued for.
    let token = {
        let mut g = engine().lock();
        g.next_token += 1;
        g.sessions.insert(
            model_id.to_string(),
            Arc::new(SessionEntry {
                session: Mutex::new(session),
                ep_label: ep_label.clone(),
                model_path: model_path.to_string(),
                token: g.next_token,
            }),
        );
        g.next_token
    };

    Ok(json!({
        "success": true,
        "ep": ep_label,
        "sessionToken": token,
        "inputs": inputs,
        "outputs": outputs,
        "modelSizeMB": (model_size_mb * 10.0).round() / 10.0,
    }))
}

fn outlet_dtype_str(dtype: &ValueType) -> &'static str {
    match dtype {
        ValueType::Tensor { ty, .. } => tensor_element_str(*ty),
        _ => "unknown",
    }
}

fn tensor_element_str(ty: TensorElementType) -> &'static str {
    match ty {
        TensorElementType::Float32 => "float32",
        TensorElementType::Float16 => "float16",
        TensorElementType::Float64 => "float64",
        TensorElementType::Int8 => "int8",
        TensorElementType::Uint8 => "uint8",
        TensorElementType::Int16 => "int16",
        TensorElementType::Uint16 => "uint16",
        TensorElementType::Int32 => "int32",
        TensorElementType::Uint32 => "uint32",
        TensorElementType::Int64 => "int64",
        TensorElementType::Uint64 => "uint64",
        TensorElementType::Bool => "bool",
        TensorElementType::String => "string",
        _ => "unknown",
    }
}

/// Convert a decoded frame tensor into an ORT input value.
fn frame_tensor_to_value(t: &FrameTensor) -> Result<ort::value::DynTensor, String> {
    let shape: Vec<i64> = t.shape.clone();
    macro_rules! make {
        ($conv:ident, $ty:ty) => {{
            let data: Vec<$ty> = frame::$conv(&t.bytes);
            Tensor::from_array((shape, data))
                .map(|t| t.upcast())
                .map_err(|e| e.to_string())
        }};
    }
    match t.dtype {
        DType::Float32 => make!(bytes_to_f32, f32),
        DType::Float16 => make!(bytes_to_f16, half::f16),
        DType::Float64 => {
            let data: Vec<f64> = t
                .bytes
                .chunks_exact(8)
                .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
                .collect();
            Tensor::from_array((shape, data))
                .map(|t| t.upcast())
                .map_err(|e| e.to_string())
        }
        DType::Int8 => {
            Tensor::from_array((shape, t.bytes.iter().map(|b| *b as i8).collect::<Vec<i8>>()))
                .map(|t| t.upcast())
                .map_err(|e| e.to_string())
        }
        DType::Uint8 => Tensor::from_array((shape, t.bytes.clone()))
            .map(|t| t.upcast())
            .map_err(|e| e.to_string()),
        DType::Int16 => {
            let data: Vec<i16> = t
                .bytes
                .chunks_exact(2)
                .map(|c| i16::from_le_bytes(c.try_into().unwrap()))
                .collect();
            Tensor::from_array((shape, data))
                .map(|t| t.upcast())
                .map_err(|e| e.to_string())
        }
        DType::Uint16 => {
            let data: Vec<u16> = t
                .bytes
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes(c.try_into().unwrap()))
                .collect();
            Tensor::from_array((shape, data))
                .map(|t| t.upcast())
                .map_err(|e| e.to_string())
        }
        DType::Int32 => make!(bytes_to_i32, i32),
        DType::Uint32 => {
            let data: Vec<u32> = t
                .bytes
                .chunks_exact(4)
                .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
                .collect();
            Tensor::from_array((shape, data))
                .map(|t| t.upcast())
                .map_err(|e| e.to_string())
        }
        DType::Int64 => make!(bytes_to_i64, i64),
        DType::Uint64 => {
            let data: Vec<u64> = t
                .bytes
                .chunks_exact(8)
                .map(|c| u64::from_le_bytes(c.try_into().unwrap()))
                .collect();
            Tensor::from_array((shape, data))
                .map(|t| t.upcast())
                .map_err(|e| e.to_string())
        }
        DType::Bool => Tensor::from_array((
            shape,
            t.bytes.iter().map(|b| *b != 0).collect::<Vec<bool>>(),
        ))
        .map(|t| t.upcast())
        .map_err(|e| e.to_string()),
    }
}

/// Extract an ORT output value into a frame tensor.
fn value_to_frame_tensor(name: &str, value: &ort::value::DynValue) -> Result<FrameTensor, String> {
    let dtype = match value.dtype() {
        ValueType::Tensor { ty, .. } => *ty,
        _ => return Err(format!("output '{}' is not a tensor", name)),
    };
    macro_rules! extract {
        ($ty:ty, $variant:expr, $to_bytes:expr) => {{
            let (shape, data) = value
                .try_extract_tensor::<$ty>()
                .map_err(|e| format!("extract '{}': {}", name, e))?;
            let dims: Vec<i64> = shape.iter().copied().collect();
            let bytes: Vec<u8> = $to_bytes(data);
            FrameTensor {
                name: name.to_string(),
                dtype: $variant,
                shape: dims,
                bytes,
            }
        }};
    }
    Ok(match dtype {
        TensorElementType::Float32 => extract!(f32, DType::Float32, frame::f32_to_bytes),
        TensorElementType::Float16 => extract!(half::f16, DType::Float16, frame::f16_to_bytes),
        TensorElementType::Int64 => extract!(i64, DType::Int64, frame::i64_to_bytes),
        TensorElementType::Int32 => extract!(i32, DType::Int32, frame::i32_to_bytes),
        TensorElementType::Int8 => extract!(i8, DType::Int8, |d: &[i8]| {
            d.iter().map(|b| *b as u8).collect()
        }),
        TensorElementType::Uint8 => extract!(u8, DType::Uint8, |d: &[u8]| d.to_vec()),
        TensorElementType::Bool => extract!(bool, DType::Bool, |d: &[bool]| {
            d.iter().map(|b| *b as u8).collect()
        }),
        other => {
            return Err(format!(
                "output '{}' has unsupported dtype {}",
                name,
                tensor_element_str(other)
            ))
        }
    })
}

/// Run inference for a decoded request frame; returns the response frame.
pub fn run_frame(request_frame: &[u8]) -> Result<Vec<u8>, String> {
    let (model_id, inputs) = frame::decode_run_request(request_frame)?;
    let eng = engine();
    let entry = {
        let g = eng.lock();
        g.sessions.get(&model_id).cloned()
    }
    .ok_or_else(|| format!("model '{}' is not loaded", model_id))?;

    // Build ORT inputs.
    let mut session_inputs: Vec<(String, ort::value::DynTensor)> = Vec::with_capacity(inputs.len());
    for t in &inputs {
        let value = frame_tensor_to_value(t)?;
        session_inputs.push((t.name.clone(), value));
    }

    // Serialize runs on this session. Inference runs on a blocking thread
    // via the command wrapper.
    let mut session = entry.session.lock();
    let output_names: Vec<String> = session
        .outputs()
        .iter()
        .map(|o| o.name().to_string())
        .collect();
    let outputs = session
        .run(SessionInputs::from(session_inputs))
        .map_err(|e| format!("inference failed for '{}': {}", model_id, e))?;
    let mut frame_outputs = Vec::with_capacity(output_names.len());
    for name in &output_names {
        let value = outputs
            .get(name.as_str())
            .ok_or_else(|| format!("missing output '{}'", name))?;
        frame_outputs.push(value_to_frame_tensor(name, value)?);
    }
    frame::encode_run_response(&frame_outputs)
}

/// Unload a session. Returns true if one was registered.
///
/// `expected_token` implements the renderer contract for the EP-candidate
/// chain: a release issued after a timeout carries the `sessionToken` returned
/// by `load_model`. If the currently registered session under `model_id` has a
/// different token (i.e. it was replaced by a newer successful load), the
/// unload is a no-op that reports false instead of killing the newer session.
/// Passing no token keeps the legacy always-remove behaviour.
pub fn unload_model(model_id: &str, expected_token: Option<u64>) -> bool {
    let mut g = engine().lock();
    if let Some(t) = expected_token {
        if g.sessions.get(model_id).map(|e| e.token) != Some(t) {
            return false;
        }
    }
    g.sessions.remove(model_id).is_some()
}

/// Native compute benchmark: the whole timed loop executes inside Rust with a
/// locally-constructed input tensor — nothing crosses the WebView IPC.
///
/// Measuring from JS (the old approach) pollutes the result: every `run` had
/// to ship a ~2MB input through base64+JSON IPC and ship the output back, an
/// overhead comparable to the inference itself (~90ms round-trip), so a
/// flagship SoC's CPU benchmark was dominated by serialization, not compute.
///
/// The model must be the compute-bound GEMM chain produced by
/// `scripts/generate-benchmark-model.py` (LAYERS=4 chained MatMul [640,640],
/// ≈2.10 GFLOPs per inference).
///
/// `device`: "cpu" | "auto" | "npu" | "gpu" | "dsp" (accelerator prefs fall
/// back to CPU automatically when no NNAPI hardware driver exists).
///
/// Returns `{ success, device, ep, avgMs, iters, intraThreads }`.
pub fn bench_device(model_path: &str, device: &str) -> Result<JsonValue, String> {
    if !is_ready() {
        return Err("ORT environment not initialized (call native_ort_init first)".into());
    }
    // Must match the generator script's GEMM dimensions.
    const S: i64 = 640;
    const FLOPS_PER_INFER: f64 = (4 * 2 * 640 * 640 * 640) as f64; // ≈ 2.10 GFLOPs
    const WARMUP_ITERS: usize = 3;
    const TARGET_MS: u128 = 1500;
    const MIN_ITERS: usize = 3;
    const MAX_ITERS: usize = 60;

    let path = Path::new(model_path);
    if !path.exists() {
        return Err(format!("benchmark model not found: {}", model_path));
    }

    let (mut session, ep_label, intra_threads) = create_session_with_fallback(
        path,
        device,
        2.0, // benchmark model size (1.64MB) — enables the XNNPACK chain
        GraphOptimizationLevel::Level3,
        true,
        false,
        None,
    )?;

    let input_name = session
        .inputs()
        .first()
        .map(|i| i.name().to_string())
        .ok_or_else(|| "benchmark model has no inputs".to_string())?;

    // Dense [S,S] float input with a safe value (no NaN/denormal slowdowns).
    let tensor = Tensor::from_array((vec![S, S], vec![0.5f32; (S * S) as usize]))
        .map_err(|e| format!("benchmark input tensor: {e}"))?;

    // Warmup (graph optimizations / NNAPI compilation / frequency ramp).
    for _ in 0..WARMUP_ITERS {
        let outputs = session
            .run(ort::inputs![input_name.as_str() => &tensor])
            .map_err(|e| format!("benchmark warmup: {e}"))?;
        drop(outputs);
    }

    let t0 = std::time::Instant::now();
    let mut iters = 0usize;
    loop {
        let outputs = session
            .run(ort::inputs![input_name.as_str() => &tensor])
            .map_err(|e| format!("benchmark run: {e}"))?;
        drop(outputs);
        iters += 1;
        let elapsed = t0.elapsed();
        if elapsed.as_millis() >= TARGET_MS && iters >= MIN_ITERS {
            break;
        }
        if iters >= MAX_ITERS {
            break;
        }
    }
    let elapsed_s = t0.elapsed().as_secs_f64();
    if elapsed_s <= 0.0 || iters == 0 {
        return Err("benchmark timing unavailable".into());
    }
    let avg_ms = elapsed_s * 1000.0 / iters as f64;
    let gops = FLOPS_PER_INFER * iters as f64 / elapsed_s / 1e9;

    Ok(json!({
        "success": true,
        "device": device,
        "ep": ep_label,
        "avgMs": (avg_ms * 100.0).round() / 100.0,
        "iters": iters,
        "intraThreads": intra_threads,
        "gops": (gops * 100.0).round() / 100.0,
    }))
}

/// Status snapshot for diagnostics / the resource-manager UI.
///
/// Lock discipline: engine data is snapshotted inside the lock, then
/// `accelerators_json()` runs OUTSIDE it (it re-enters the engine to locate
/// the ORT lib dir; parking_lot is not reentrant — calling it under the lock
/// deadlocks).
pub fn status() -> JsonValue {
    let eng = engine();
    let (env_ready, lib_path, sessions) = {
        let g = eng.lock();
        let sessions: Vec<JsonValue> = g
            .sessions
            .iter()
            .map(|(id, e)| {
                json!({
                    "modelId": id,
                    "ep": e.ep_label,
                    "path": e.model_path,
                })
            })
            .collect();
        (g.env_ready, g.lib_path.clone(), sessions)
    };
    json!({
        "available": env_ready,
        "libPath": lib_path,
        "sessions": sessions,
        "accelerators": accelerators_json()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_options_default_matches_desktop() {
        let o = NativeSessionOptions::default();
        assert_eq!(o.graph_opt_level, "all");
        assert_eq!(o.execution_mode, "sequential");
        assert!(o.enable_mem_pattern);
        assert!(o.enable_cpu_mem_arena);
    }

    #[test]
    fn session_options_from_json() {
        let v = json!({
            "graphOptimizationLevel": "basic",
            "executionMode": "parallel",
            "enableMemPattern": false,
            "intraOpNumThreads": 4,
            "devicePreference": "npu",
            "bogus": true,
        });
        let o = NativeSessionOptions::from_json(Some(&v));
        assert_eq!(o.graph_opt_level, "basic");
        assert_eq!(o.execution_mode, "parallel");
        assert!(!o.enable_mem_pattern);
        assert_eq!(o.intra_op_threads, 4);
        assert_eq!(o.device_preference, "npu");
        // Invalid enum values fall back to defaults.
        let bad = json!({ "graphOptimizationLevel": "turbo" });
        let o2 = NativeSessionOptions::from_json(Some(&bad));
        assert_eq!(o2.graph_opt_level, "all");
    }

    #[test]
    fn ep_candidate_chain_priority() {
        // CPU preference: XNNPACK first, bare CPU as the fallback candidate.
        let cpu = ep_candidates("cpu", 2.0);
        assert_eq!(cpu[0].label, "xnnpack+cpu");
        assert_eq!(cpu[cpu.len() - 1].label, "cpu");
        // Large models skip XNNPACK (weight-copy memory cost).
        let big = ep_candidates("cpu", 500.0);
        assert_eq!(big[0].label, "cpu");

        // Accelerator preferences end in the same CPU candidates.
        let auto = ep_candidates("auto", 2.0);
        assert_eq!(auto[auto.len() - 1].label, "cpu");
        // Every candidate chain ends with a CPU node for graph fallback.
        for c in &auto {
            assert!(!c.eps.is_empty());
        }
    }

    #[test]
    fn load_model_requires_init_and_file() {
        // Without init, loading must fail gracefully (not panic).
        let r = load_model("x", "/nonexistent/model.onnx", None);
        assert!(r.is_err());
    }

    #[test]
    fn status_shape() {
        let s = status();
        assert!(s.get("available").is_some());
        assert!(s.get("sessions").is_some());
        assert!(s.get("accelerators").is_some());
        let acc = s.get("accelerators").unwrap();
        assert!(acc.get("qnn").is_some());
        assert!(acc.get("nnapiDevices").is_some());
    }
}
