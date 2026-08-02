/**
 * 原生 ONNX Runtime 客户端 — onnxruntime-web 兼容外观。
 *
 * 暴露与 onnxruntime-web 相同的 Tensor / InferenceSession 接口，使
 * src/inference/webnn 下的管线（preprocessing/diffusion/postprocessing）
 * 无需修改即可在原生引擎上运行。推理实际在 Rust 侧执行
 *（src-tauri/src/inference/ort_engine.rs）：
 *   Android → NNAPI EP（NPU/GPU/DSP）+ CPU 回退
 *   iOS     → CoreML EP（ANE/GPU）+ CPU 回退
 *   桌面    → CPU（开发/测试）
 *
 * 传输路径：
 *   桌面/iOS → invoke(cmd, Uint8Array) 原始字节（application/octet-stream）
 *   Android  → base64 JSON（invoke 参数在 Android 走 JSON 序列化，
 *              base64 字符串比同字节的数字数组解析快约 3 倍）
 */

import {
    encodeRunFrame,
    decodeRunFrame,
    bytesToBase64,
    base64ToBytes,
} from './tensorCodec.js';

/** 轻量 Tensor：与 onnxruntime-web Tensor 构造签名一致 */
export class NativeTensor {
    constructor(type, data, dims) {
        this.type = type;
        this.data = data;
        this.dims = Array.from(dims || []);
        this.size = this.dims.reduce((a, b) => a * b, 1);
    }
    dispose() { /* 原生侧无 JS 堆外资源 */ }
}

let _platformInfo = null;
async function getPlatform() {
    if (_platformInfo) return _platformInfo;
    try {
        _platformInfo = await window.electronAPI?.getPlatformInfo?.() || { platform: 'unknown', isMobile: false };
    } catch (_) {
        _platformInfo = { platform: 'unknown', isMobile: false };
    }
    return _platformInfo;
}

/** 测试注入用 */
export function __setPlatformForTests(info) { _platformInfo = info; }
export function __resetPlatformForTests() { _platformInfo = null; }

let _anonCounter = 0;

/**
 * InferenceSession 兼容类。静态 create() 与 onnxruntime-web 一致；
 * 模型经 __modelPath 直读磁盘（字节不过 IPC）。
 */
export class NativeInferenceSession {
    constructor(modelId, meta) {
        this._modelId = modelId;
        this._released = false;
        // onnxruntime-web 兼容元数据（_warmupSession 使用）
        this.inputMetadata = (meta.inputs || []).map((i) => ({
            name: i.name,
            type: i.dtype === 'unknown' ? 'float32' : i.dtype,
            shape: undefined,
        }));
        this.outputMetadata = (meta.outputs || []).map((o) => ({
            name: o.name,
            type: o.dtype === 'unknown' ? 'float32' : o.dtype,
            shape: undefined,
        }));
        this.inputNames = this.inputMetadata.map((i) => i.name);
        this.outputNames = this.outputMetadata.map((o) => o.name);
        this.ep = meta.ep || 'native';
    }

    /**
     * @param {ArrayBuffer|Uint8Array} _modelBytes 占位（onnxruntime-web 兼容；
     *    原生后端从 __modelPath 读盘，忽略此参数）
     * @param {object} options - sessionOptions + __modelPath/__modelId
     */
    static async create(_modelBytes, options = {}) {
        const modelPath = options.__modelPath;
        if (!modelPath) {
            throw new Error('native backend requires __modelPath in session options');
        }
        const modelId = options.__modelId || `anon-${Date.now()}-${++_anonCounter}`;
        const sessionOptions = {
            graphOptimizationLevel: options.graphOptimizationLevel,
            executionMode: options.executionMode,
            enableMemPattern: options.enableMemPattern,
            enableCpuMemArena: options.enableCpuMemArena,
            intraOpNumThreads: options.intraOpNumThreads,
            interOpNumThreads: options.interOpNumThreads,
            devicePreference: epToDevicePreference(options.executionProviders),
        };
        const result = await window.electronAPI.nativeOrtLoadModel(modelId, modelPath, sessionOptions);
        if (!result || result.success !== true) {
            throw new Error((result && result.error) || 'native session creation failed');
        }
        return new NativeInferenceSession(modelId, result);
    }

    /**
     * 执行推理。feeds 值可为 onnxruntime-web Tensor、NativeTensor
     * 或 {data, dims, type} 普通对象。
     * @returns {Promise<Object<string, {data, dims, type, dispose}>>}
     */
    async run(feeds) {
        if (this._released) throw new Error(`session ${this._modelId} has been released`);
        const frame = encodeRunFrame(this._modelId, feeds);
        const platform = await getPlatform();
        let responseBytes;
        if (platform.platform === 'android') {
            const res = await window.electronAPI.nativeOrtRunB64(bytesToBase64(frame));
            if (!res || !res.frameB64) throw new Error('native_ort_run_b64: empty response');
            responseBytes = base64ToBytes(res.frameB64);
        } else {
            const res = await window.electronAPI.nativeOrtRun(frame);
            responseBytes = res instanceof ArrayBuffer ? new Uint8Array(res) : res;
        }
        return decodeRunFrame(responseBytes);
    }

    async release() {
        if (this._released) return;
        this._released = true;
        try {
            await window.electronAPI.nativeOrtUnloadModel(this._modelId);
        } catch (_) { /* 卸载失败不影响释放语义 */ }
    }
}

/** 把 onnxruntime-web 的 executionProviders 映射为原生设备偏好 */
export function epToDevicePreference(eps) {
    if (!eps || eps.length === 0) return 'cpu';
    const first = eps[0];
    if (typeof first === 'string') {
        // 'wasm' / 'cpu' → CPU
        return 'cpu';
    }
    if (first && first.name === 'webnn') {
        return first.deviceType === 'npu' ? 'npu' : 'gpu';
    }
    return 'cpu';
}

// ------------------------------- 外观（facade） -------------------------------

let _nativeAvailable = null; // null=未探测, true/false=结果

/**
 * 探测并初始化原生后端。仅在 Tauri 环境（window.electronAPI 存在且
 * 暴露 nativeOrtInit）下尝试；结果缓存。
 * @returns {Promise<object|null>} ort 兼容外观；不可用返回 null
 */
export async function tryInitNativeBackend() {
    if (_nativeAvailable === false) return null;
    if (_nativeAvailable === true) return buildFacade();
    if (typeof window === 'undefined' || !window.electronAPI?.nativeOrtInit) {
        _nativeAvailable = false;
        return null;
    }
    try {
        const res = await window.electronAPI.nativeOrtInit(null);
        if (!res || res.available !== true) {
            console.log('[NativeORT] native backend unavailable:', res?.error || 'unknown');
            _nativeAvailable = false;
            return null;
        }
        console.log('[NativeORT] native backend ready:', res.libPath, JSON.stringify(res.accelerators || {}));
        _nativeAvailable = true;
        return buildFacade();
    } catch (e) {
        console.warn('[NativeORT] init failed:', e?.message || e);
        _nativeAvailable = false;
        return null;
    }
}

/** 测试重置 */
export function __resetNativeBackendForTests() { _nativeAvailable = null; }
/** 测试注入 */
export function __setNativeAvailableForTests(v) { _nativeAvailable = v; }

function buildFacade() {
    return {
        __isNativeFacade: true,
        Tensor: NativeTensor,
        InferenceSession: NativeInferenceSession,
        env: {
            wasm: {},
            versions: { web: 'native-ort' },
            logLevel: 'warning',
        },
    };
}

/** 查询原生后端状态（资源管理器/设置页诊断用） */
export async function getNativeStatus() {
    if (!window.electronAPI?.nativeOrtStatus) return { available: false, sessions: [] };
    try {
        return await window.electronAPI.nativeOrtStatus();
    } catch (e) {
        return { available: false, error: e?.message || String(e), sessions: [] };
    }
}

/** 原生加速器探测（替代 navigator.ml 的 WebNN 检测） */
export async function detectNativeAccelerators() {
    if (!window.electronAPI?.nativeOrtDetectAccelerators) {
        return { npu: false, gpu: false, cpu: true };
    }
    try {
        const acc = await window.electronAPI.nativeOrtDetectAccelerators();
        return {
            npu: Boolean(acc?.nnapi || acc?.coreml),
            gpu: Boolean(acc?.nnapi || acc?.coreml),
            cpu: true,
            raw: acc,
        };
    } catch (_) {
        return { npu: false, gpu: false, cpu: true };
    }
}