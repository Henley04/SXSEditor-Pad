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
}

fn platform_accelerators() -> AcceleratorInfo {
    AcceleratorInfo {
        // The ORT Mobile build we bundle includes NNAPI on Android and
        // CoreML on iOS. Registration fails softly if the driver is absent,
        // so advertising the EP here only means "will be attempted".
        nnapi: cfg!(target_os = "android"),
        coreml: cfg!(target_os = "ios"),
    }
}

struct SessionEntry {
    /// `run` takes `&mut Session`; the mutex both provides interior
    /// mutability and serializes runs on this session.
    session: Mutex<Session>,
    ep_label: String,
    model_path: String,
}

/// Global engine state. The environment is process-global in ONNX Runtime;
/// sessions live in this registry keyed by model id.
pub struct OrtEngine {
    env_ready: bool,
    lib_path: Option<String>,
    sessions: HashMap<String, Arc<SessionEntry>>,
}

static ENGINE: OnceLock<Arc<Mutex<OrtEngine>>> = OnceLock::new();

pub fn engine() -> Arc<Mutex<OrtEngine>> {
    ENGINE
        .get_or_init(|| {
            Arc::new(Mutex::new(OrtEngine {
                env_ready: false,
                lib_path: None,
                sessions: HashMap::new(),
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
pub fn init(explicit_lib_path: Option<&str>) -> JsonValue {
    let eng = engine();
    {
        let g = eng.lock();
        if g.env_ready {
            return json!({
                "available": true,
                "libPath": g.lib_path,
                "accelerators": {
                    "nnapi": platform_accelerators().nnapi,
                    "coreml": platform_accelerators().coreml,
                }
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
                        let mut g = eng.lock();
                        g.env_ready = true;
                        g.lib_path = Some(display.clone());
                        return json!({
                            "available": true,
                            "libPath": display,
                            "accelerators": {
                                "nnapi": platform_accelerators().nnapi,
                                "coreml": platform_accelerators().coreml,
                            }
                        });
                    }
                    Ok(false) => {
                        // Environment already committed by an earlier init —
                        // treat as ready.
                        let mut g = eng.lock();
                        g.env_ready = true;
                        g.lib_path = Some(display.clone());
                        return json!({
                            "available": true,
                            "libPath": display,
                            "note": "environment already initialized",
                            "accelerators": {
                                "nnapi": platform_accelerators().nnapi,
                                "coreml": platform_accelerators().coreml,
                            }
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
        "accelerators": { "nnapi": false, "coreml": false }
    })
}

pub fn is_ready() -> bool {
    engine().lock().env_ready
}

/// Build the EP list for the requested device preference. Accelerators fail
/// softly (CPU fallback inside ORT) so a session always commits when the
/// model itself is valid.
fn execution_providers_for(device: &str) -> (Vec<ep::ExecutionProviderDispatch>, &'static str) {
    #[cfg(target_os = "android")]
    {
        match device {
            "npu" | "gpu" => (
                vec![ep::NNAPI::default().build(), ep::CPU::default().build()],
                "nnapi+cpu",
            ),
            _ => (vec![ep::CPU::default().build()], "cpu"),
        }
    }
    #[cfg(target_os = "ios")]
    {
        match device {
            "npu" | "gpu" => (
                vec![ep::CoreML::default().build(), ep::CPU::default().build()],
                "coreml+cpu",
            ),
            _ => (vec![ep::CPU::default().build()], "cpu"),
        }
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = device;
        (vec![ep::CPU::default().build()], "cpu")
    }
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

    let (eps, ep_label) = execution_providers_for(&opts.device_preference);

    let mut builder = Session::builder().map_err(|e| e.to_string())?;
    builder = builder
        .with_optimization_level(opts.graph_opt_level())
        .map_err(|e| e.to_string())?
        .with_parallel_execution(opts.execution_mode == "parallel")
        .map_err(|e| e.to_string())?
        .with_memory_pattern(opts.enable_mem_pattern)
        .map_err(|e| e.to_string())?
        .with_execution_providers(eps)
        .map_err(|e| e.to_string())?;
    if opts.intra_op_threads > 0 {
        builder = builder
            .with_intra_threads(opts.intra_op_threads)
            .map_err(|e| e.to_string())?;
    }
    if opts.inter_op_threads > 0 {
        builder = builder
            .with_inter_threads(opts.inter_op_threads)
            .map_err(|e| e.to_string())?;
    }

    let session = builder
        .commit_from_file(path)
        .map_err(|e| format!("failed to create session for {}: {}", model_path, e))?;

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

    let entry = Arc::new(SessionEntry {
        session: Mutex::new(session),
        ep_label: ep_label.to_string(),
        model_path: model_path.to_string(),
    });
    engine().lock().sessions.insert(model_id.to_string(), entry);

    Ok(json!({
        "success": true,
        "ep": ep_label,
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
pub fn unload_model(model_id: &str) -> bool {
    engine().lock().sessions.remove(model_id).is_some()
}

/// Status snapshot for diagnostics / the resource-manager UI.
pub fn status() -> JsonValue {
    let eng = engine();
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
    json!({
        "available": g.env_ready,
        "libPath": g.lib_path,
        "sessions": sessions,
        "accelerators": {
            "nnapi": platform_accelerators().nnapi,
            "coreml": platform_accelerators().coreml,
        }
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
    fn ep_label_and_chain_per_platform() {
        let (eps, label) = execution_providers_for("npu");
        assert!(!eps.is_empty());
        #[cfg(target_os = "android")]
        assert_eq!(label, "nnapi+cpu");
        #[cfg(target_os = "ios")]
        assert_eq!(label, "coreml+cpu");
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        assert_eq!(label, "cpu");
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
    }
}
