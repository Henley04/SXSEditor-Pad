//! LiteRT (TensorFlow Lite) runner for Basic Pitch MIDI extraction.
//!
//! Dynamically binds `libtensorflowlite_c` at runtime (same load-dynamic
//! pattern as the ORT engine) so the crate compiles and tests without the
//! native library. On Android the .so ships in jniLibs; on iOS the
//! TensorFlowLiteC xcframework is linked by the Xcode project.
//!
//! Only the small C-API surface Basic Pitch needs is bound: model create,
//! interpreter create/invoke, tensor resize/copy, plus optional NNAPI /
//! CoreML delegates resolved weakly (absent symbols are skipped).

use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_void, CString};
use std::path::Path;
use std::sync::OnceLock;

use libloading::{Library, Symbol};
use parking_lot::Mutex;
use serde_json::{json, Value as JsonValue};

// Opaque C types.
enum TfLiteModel {}
enum TfLiteInterpreter {}
enum TfLiteInterpreterOptions {}
enum TfLiteTensor {}
enum TfLiteDelegate {}

type TfLiteStatus = c_int;
const TFLITE_OK: TfLiteStatus = 0;

/// Resolved C API symbols.
struct TfLiteApi {
    _lib: Library,
    model_create_from_file: unsafe extern "C" fn(*const c_char) -> *mut TfLiteModel,
    model_delete: unsafe extern "C" fn(*mut TfLiteModel),
    options_create: unsafe extern "C" fn() -> *mut TfLiteInterpreterOptions,
    options_set_num_threads: unsafe extern "C" fn(*mut TfLiteInterpreterOptions, i32),
    options_delete: unsafe extern "C" fn(*mut TfLiteInterpreterOptions),
    options_add_delegate: Option<unsafe extern "C" fn(*mut TfLiteInterpreterOptions, *mut TfLiteDelegate)>,
    interpreter_create: unsafe extern "C" fn(*const TfLiteModel, *const TfLiteInterpreterOptions) -> *mut TfLiteInterpreter,
    interpreter_delete: unsafe extern "C" fn(*mut TfLiteInterpreter),
    interpreter_get_input_tensor_count: unsafe extern "C" fn(*const TfLiteInterpreter) -> i32,
    interpreter_get_output_tensor_count: unsafe extern "C" fn(*const TfLiteInterpreter) -> i32,
    interpreter_get_input_tensor: unsafe extern "C" fn(*mut TfLiteInterpreter, i32) -> *mut TfLiteTensor,
    interpreter_get_output_tensor: unsafe extern "C" fn(*mut TfLiteInterpreter, i32) -> *mut TfLiteTensor,
    interpreter_resize_input_tensor: unsafe extern "C" fn(*mut TfLiteInterpreter, i32, *const c_int, i32) -> TfLiteStatus,
    interpreter_allocate_tensors: unsafe extern "C" fn(*mut TfLiteInterpreter) -> TfLiteStatus,
    interpreter_invoke: unsafe extern "C" fn(*mut TfLiteInterpreter) -> TfLiteStatus,
    tensor_copy_from_buffer: unsafe extern "C" fn(*mut TfLiteTensor, *const c_void, usize) -> TfLiteStatus,
    tensor_copy_to_buffer: unsafe extern "C" fn(*const TfLiteTensor, *mut c_void, usize) -> TfLiteStatus,
    tensor_byte_size: unsafe extern "C" fn(*const TfLiteTensor) -> usize,
    tensor_num_dims: unsafe extern "C" fn(*const TfLiteTensor) -> c_int,
    tensor_dim: unsafe extern "C" fn(*const TfLiteTensor, c_int) -> c_int,
    // Delegates (optional).
    nnapi_delegate_create: Option<unsafe extern "C" fn(*const c_void) -> *mut TfLiteDelegate>,
    nnapi_delegate_delete: Option<unsafe extern "C" fn(*mut TfLiteDelegate)>,
    coreml_delegate_create: Option<unsafe extern "C" fn(*const c_void) -> *mut TfLiteDelegate>,
    coreml_delegate_delete: Option<unsafe extern "C" fn(*mut TfLiteDelegate)>,
}

// The library handle must be Send+Sync to live in a static. libloading::Library
// is Send+Sync on all platforms we target (dlopen/LoadLibrary handles).
unsafe impl Send for TfLiteApi {}
unsafe impl Sync for TfLiteApi {}

static API: OnceLock<Result<TfLiteApi, String>> = OnceLock::new();

fn tflite_lib_file_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "tensorflowlite_c.dll"
    } else if cfg!(target_os = "macos") || cfg!(target_os = "ios") {
        "libtensorflowlite_c.dylib"
    } else {
        "libtensorflowlite_c.so"
    }
}

fn load_api(explicit: Option<&str>) -> Result<TfLiteApi, String> {
    let mut candidates: Vec<String> = Vec::new();
    if let Some(p) = explicit {
        if !p.is_empty() {
            candidates.push(p.to_string());
        }
    }
    if let Ok(env_p) = std::env::var("SXS_TFLITE_LIB") {
        if !env_p.is_empty() {
            candidates.push(env_p);
        }
    }
    candidates.push(tflite_lib_file_name().to_string());

    let mut last_err = String::new();
    for cand in &candidates {
        let lib = unsafe { Library::new(cand) };
        let lib = match lib {
            Ok(l) => l,
            Err(e) => {
                last_err = format!("{}: {}", cand, e);
                continue;
            }
        };
        macro_rules! sym {
            ($lib:expr, $name:literal, $ty:ty) => {{
                let s: Symbol<$ty> = unsafe { $lib.get($name) }.map_err(|e| {
                    format!("missing symbol {}: {}", String::from_utf8_lossy($name), e)
                })?;
                *s
            }};
        }
        macro_rules! opt_sym {
            ($lib:expr, $name:literal, $ty:ty) => {{
                let s: Result<Symbol<$ty>, _> = unsafe { $lib.get($name) };
                s.ok().map(|s| *s)
            }};
        }
        return (|| {
            Ok(TfLiteApi {
                model_create_from_file: sym!(lib, b"TfLiteModelCreateFromFile\0", unsafe extern "C" fn(*const c_char) -> *mut TfLiteModel),
                model_delete: sym!(lib, b"TfLiteModelDelete\0", unsafe extern "C" fn(*mut TfLiteModel)),
                options_create: sym!(lib, b"TfLiteInterpreterOptionsCreate\0", unsafe extern "C" fn() -> *mut TfLiteInterpreterOptions),
                options_set_num_threads: sym!(lib, b"TfLiteInterpreterOptionsSetNumThreads\0", unsafe extern "C" fn(*mut TfLiteInterpreterOptions, i32)),
                options_delete: sym!(lib, b"TfLiteInterpreterOptionsDelete\0", unsafe extern "C" fn(*mut TfLiteInterpreterOptions)),
                options_add_delegate: opt_sym!(lib, b"TfLiteInterpreterOptionsAddDelegate\0", unsafe extern "C" fn(*mut TfLiteInterpreterOptions, *mut TfLiteDelegate)),
                interpreter_create: sym!(lib, b"TfLiteInterpreterCreate\0", unsafe extern "C" fn(*const TfLiteModel, *const TfLiteInterpreterOptions) -> *mut TfLiteInterpreter),
                interpreter_delete: sym!(lib, b"TfLiteInterpreterDelete\0", unsafe extern "C" fn(*mut TfLiteInterpreter)),
                interpreter_get_input_tensor_count: sym!(lib, b"TfLiteInterpreterGetInputTensorCount\0", unsafe extern "C" fn(*const TfLiteInterpreter) -> i32),
                interpreter_get_output_tensor_count: sym!(lib, b"TfLiteInterpreterGetOutputTensorCount\0", unsafe extern "C" fn(*const TfLiteInterpreter) -> i32),
                interpreter_get_input_tensor: sym!(lib, b"TfLiteInterpreterGetInputTensor\0", unsafe extern "C" fn(*mut TfLiteInterpreter, i32) -> *mut TfLiteTensor),
                interpreter_get_output_tensor: sym!(lib, b"TfLiteInterpreterGetOutputTensor\0", unsafe extern "C" fn(*mut TfLiteInterpreter, i32) -> *mut TfLiteTensor),
                interpreter_resize_input_tensor: sym!(lib, b"TfLiteInterpreterResizeInputTensor\0", unsafe extern "C" fn(*mut TfLiteInterpreter, i32, *const c_int, i32) -> TfLiteStatus),
                interpreter_allocate_tensors: sym!(lib, b"TfLiteInterpreterAllocateTensors\0", unsafe extern "C" fn(*mut TfLiteInterpreter) -> TfLiteStatus),
                interpreter_invoke: sym!(lib, b"TfLiteInterpreterInvoke\0", unsafe extern "C" fn(*mut TfLiteInterpreter) -> TfLiteStatus),
                tensor_copy_from_buffer: sym!(lib, b"TfLiteTensorCopyFromBuffer\0", unsafe extern "C" fn(*mut TfLiteTensor, *const c_void, usize) -> TfLiteStatus),
                tensor_copy_to_buffer: sym!(lib, b"TfLiteTensorCopyToBuffer\0", unsafe extern "C" fn(*const TfLiteTensor, *mut c_void, usize) -> TfLiteStatus),
                tensor_byte_size: sym!(lib, b"TfLiteTensorByteSize\0", unsafe extern "C" fn(*const TfLiteTensor) -> usize),
                tensor_num_dims: sym!(lib, b"TfLiteTensorNumDims\0", unsafe extern "C" fn(*const TfLiteTensor) -> c_int),
                tensor_dim: sym!(lib, b"TfLiteTensorDim\0", unsafe extern "C" fn(*const TfLiteTensor, c_int) -> c_int),
                nnapi_delegate_create: opt_sym!(lib, b"TfLiteNnapiDelegateCreate\0", unsafe extern "C" fn(*const c_void) -> *mut TfLiteDelegate),
                nnapi_delegate_delete: opt_sym!(lib, b"TfLiteNnapiDelegateDelete\0", unsafe extern "C" fn(*mut TfLiteDelegate)),
                coreml_delegate_create: opt_sym!(lib, b"TfLiteCoreMlDelegateCreate\0", unsafe extern "C" fn(*const c_void) -> *mut TfLiteDelegate),
                coreml_delegate_delete: opt_sym!(lib, b"TfLiteCoreMlDelegateDelete\0", unsafe extern "C" fn(*mut TfLiteDelegate)),
                _lib: lib,
            })
        })();
    }
    Err(if last_err.is_empty() {
        "libtensorflowlite_c not found".to_string()
    } else {
        last_err
    })
}

/// Probe + cache the API. Returns availability info for the renderer.
pub fn init(explicit: Option<&str>) -> JsonValue {
    let res = API.get_or_init(|| load_api(explicit));
    match res {
        Ok(api) => json!({
            "available": true,
            "delegates": {
                "nnapi": api.nnapi_delegate_create.is_some(),
                "coreml": api.coreml_delegate_create.is_some(),
            }
        }),
        Err(e) => json!({ "available": false, "error": e }),
    }
}

struct InterpreterEntry {
    interpreter: *mut TfLiteInterpreter,
    model: *mut TfLiteModel,
    delegate: Option<*mut TfLiteDelegate>,
}

// Raw pointers are only touched under the registry mutex from Tauri command
// threads; TFLite interpreters are documented as not thread-safe, and our
// per-model run_lock serializes all calls.
unsafe impl Send for InterpreterEntry {}

impl Drop for InterpreterEntry {
    fn drop(&mut self) {
        if let Some(Ok(api)) = API.get() {
            unsafe {
                if let Some(d) = self.delegate {
                    if let Some(del) = api.nnapi_delegate_delete {
                        del(d);
                    } else if let Some(del) = api.coreml_delegate_delete {
                        del(d);
                    }
                }
                (api.interpreter_delete)(self.interpreter);
                (api.model_delete)(self.model);
            }
        }
    }
}

pub struct TfliteRegistry {
    sessions: HashMap<String, (InterpreterEntry, parking_lot::Mutex<()>)>,
}

static REGISTRY: OnceLock<Mutex<TfliteRegistry>> = OnceLock::new();

fn registry() -> &'static Mutex<TfliteRegistry> {
    REGISTRY.get_or_init(|| {
        Mutex::new(TfliteRegistry {
            sessions: HashMap::new(),
        })
    })
}

/// Load a `.tflite` model and create an interpreter.
pub fn load_model(
    model_id: &str,
    path: &str,
    num_threads: Option<i32>,
    use_accelerator: bool,
) -> Result<JsonValue, String> {
    if !Path::new(path).exists() {
        return Err(format!("tflite model not found: {}", path));
    }
    let api = match API.get() {
        Some(Ok(a)) => a,
        Some(Err(e)) => return Err(format!("tflite unavailable: {}", e)),
        None => return Err("tflite not initialized (call native_tflite_init first)".into()),
    };

    let c_path = CString::new(path).map_err(|e| e.to_string())?;
    unsafe {
        let model = (api.model_create_from_file)(c_path.as_ptr());
        if model.is_null() {
            return Err(format!("TfLiteModelCreateFromFile failed for {}", path));
        }
        let options = (api.options_create)();
        if options.is_null() {
            (api.model_delete)(model);
            return Err("TfLiteInterpreterOptionsCreate failed".into());
        }
        if let Some(n) = num_threads {
            if n > 0 {
                (api.options_set_num_threads)(options, n);
            }
        }
        // Optional hardware delegate (NNAPI on Android / CoreML on iOS).
        let mut delegate: Option<*mut TfLiteDelegate> = None;
        if use_accelerator {
            if let Some(add_delegate) = api.options_add_delegate {
                #[cfg(target_os = "android")]
                let created = api.nnapi_delegate_create.map(|f| f(std::ptr::null()));
                #[cfg(target_os = "ios")]
                let created = api.coreml_delegate_create.map(|f| f(std::ptr::null()));
                #[cfg(not(any(target_os = "android", target_os = "ios")))]
                let created: Option<*mut TfLiteDelegate> = None;
                if let Some(d) = created {
                    if !d.is_null() {
                        add_delegate(options, d);
                        delegate = Some(d);
                    }
                }
            }
        }
        let interpreter = (api.interpreter_create)(model, options);
        (api.options_delete)(options);
        if interpreter.is_null() {
            if let Some(d) = delegate {
                if let Some(del) = api.nnapi_delegate_delete {
                    del(d);
                }
            }
            (api.model_delete)(model);
            return Err("TfLiteInterpreterCreate failed".into());
        }
        if (api.interpreter_allocate_tensors)(interpreter) != TFLITE_OK {
            (api.interpreter_delete)(interpreter);
            (api.model_delete)(model);
            return Err("TfLiteInterpreterAllocateTensors failed".into());
        }

        let in_count = (api.interpreter_get_input_tensor_count)(interpreter);
        let out_count = (api.interpreter_get_output_tensor_count)(interpreter);
        let mut input_shapes = Vec::new();
        for i in 0..in_count {
            let t = (api.interpreter_get_input_tensor)(interpreter, i);
            input_shapes.push(tensor_shape(api, t));
        }
        let mut output_shapes = Vec::new();
        for i in 0..out_count {
            let t = (api.interpreter_get_output_tensor)(interpreter, i);
            output_shapes.push(tensor_shape(api, t));
        }

        registry().lock().sessions.insert(
            model_id.to_string(),
            (
                InterpreterEntry {
                    interpreter,
                    model,
                    delegate,
                },
                parking_lot::Mutex::new(()),
            ),
        );

        Ok(json!({
            "success": true,
            "inputCount": in_count,
            "outputCount": out_count,
            "inputShapes": input_shapes,
            "outputShapes": output_shapes,
            "accelerated": delegate.is_some(),
        }))
    }
}

fn tensor_shape(api: &TfLiteApi, tensor: *const TfLiteTensor) -> Vec<i64> {
    unsafe {
        let n = (api.tensor_num_dims)(tensor);
        (0..n).map(|i| (api.tensor_dim)(tensor, i) as i64).collect()
    }
}

/// Run one invocation. `inputs` is a list of `{index, shape, dataB64}` (f32
/// little-endian). Returns `{outputs: [{index, shape, dataB64}]}`.
pub fn run(model_id: &str, inputs: &[JsonValue]) -> Result<JsonValue, String> {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;

    let api = match API.get() {
        Some(Ok(a)) => a,
        Some(Err(e)) => return Err(format!("tflite unavailable: {}", e)),
        None => return Err("tflite not initialized".into()),
    };

    // Hold the registry lock for the whole run — interpreters are not
    // thread-safe and we serialize per model.
    let reg = registry();
    let guard = reg.lock();
    let (entry, run_lock) = guard
        .sessions
        .get(model_id)
        .ok_or_else(|| format!("tflite model '{}' is not loaded", model_id))?;
    let _run_guard = run_lock.lock();

    unsafe {
        for input in inputs {
            let index = input.get("index").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let shape: Vec<i32> = input
                .get("shape")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|d| d.as_i64().map(|x| x as i32)).collect())
                .unwrap_or_default();
            let data_b64 = input
                .get("dataB64")
                .and_then(|v| v.as_str())
                .ok_or("input missing dataB64")?;
            let bytes = b64.decode(data_b64).map_err(|e| e.to_string())?;

            if !shape.is_empty() {
                if (api.interpreter_resize_input_tensor)(
                    entry.interpreter,
                    index,
                    shape.as_ptr(),
                    shape.len() as i32,
                ) != TFLITE_OK
                {
                    return Err(format!("ResizeInputTensor failed for input {}", index));
                }
                if (api.interpreter_allocate_tensors)(entry.interpreter) != TFLITE_OK {
                    return Err("AllocateTensors after resize failed".into());
                }
            }
            let tensor = (api.interpreter_get_input_tensor)(entry.interpreter, index);
            if tensor.is_null() {
                return Err(format!("input tensor {} is null", index));
            }
            if (api.tensor_copy_from_buffer)(tensor, bytes.as_ptr() as *const c_void, bytes.len())
                != TFLITE_OK
            {
                return Err(format!("CopyFromBuffer failed for input {}", index));
            }
        }

        if (api.interpreter_invoke)(entry.interpreter) != TFLITE_OK {
            return Err("TfLiteInterpreterInvoke failed".into());
        }

        let out_count = (api.interpreter_get_output_tensor_count)(entry.interpreter);
        let mut outputs = Vec::new();
        for i in 0..out_count {
            let tensor = (api.interpreter_get_output_tensor)(entry.interpreter, i);
            if tensor.is_null() {
                continue;
            }
            let byte_size = (api.tensor_byte_size)(tensor);
            let mut buf = vec![0u8; byte_size];
            if (api.tensor_copy_to_buffer)(tensor, buf.as_mut_ptr() as *mut c_void, byte_size)
                != TFLITE_OK
            {
                return Err(format!("CopyToBuffer failed for output {}", i));
            }
            outputs.push(json!({
                "index": i,
                "shape": tensor_shape(api, tensor),
                "dataB64": b64.encode(&buf),
            }));
        }
        Ok(json!({ "outputs": outputs }))
    }
}

pub fn unload(model_id: &str) -> bool {
    registry().lock().sessions.remove(model_id).is_some()
}

pub fn status() -> JsonValue {
    let available = matches!(API.get(), Some(Ok(_)));
    let reg = registry();
    let g = reg.lock();
    let ids: Vec<&String> = g.sessions.keys().collect();
    json!({ "available": available, "sessions": ids })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_without_lib_is_graceful() {
        // In CI there is no libtensorflowlite_c — init must report
        // unavailable instead of panicking. Use a bogus explicit path so the
        // probe is deterministic.
        let v = init(Some("/nonexistent/libtensorflowlite_c.so"));
        // Either unavailable (expected here) or available (dev machine with lib).
        assert!(v.get("available").is_some());
    }

    #[test]
    fn run_without_model_errors() {
        let r = run("nope", &[]);
        assert!(r.is_err());
    }

    #[test]
    fn status_reports_availability() {
        let s = status();
        assert!(s.get("available").is_some());
    }
}
