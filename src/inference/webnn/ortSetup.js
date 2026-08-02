/**
 * 推理后端初始化 — 原生 ORT（优先）或 onnxruntime-web（回退）
 *
 * 后端选择（ensureOrt）：
 *   1. 原生后端：Tauri 环境下经 src/inference/native/nativeOrtClient.js
 *      动态加载 libonnxruntime（Android NNAPI / iOS CoreML / 桌面 CPU）。
 *      推理在 Rust 侧执行，模型直读磁盘，张量走二进制帧。
 *   2. onnxruntime-web 回退：原生库不可用（如纯浏览器开发）时动态注入
 *      ort.all.min.js（WebNN NPU/GPU → WASM）。
 *
 * 两条路径暴露相同的 Tensor / InferenceSession 接口，管线代码无感知。
 */

import { tryInitNativeBackend } from '../native/nativeOrtClient.js';

// onnxruntime-web UMD bundle path (relative to the current page; the bundler
// copies ort assets next to each entry — see vite.config.js / publicDir).
const ORT_UMD_PATH = './ort.all.min.js';

// Cached ort reference once loaded.
let ort = null;

// In-flight loader promise so concurrent callers share the same script load.
let _loadPromise = null;

/**
 * Dynamically inject <script src="./ort.all.min.js"> into <head>.
 * Resolves with window.ort once the UMD bundle has executed.
 * Idempotent: concurrent callers share the same promise.
 */
function loadOrtScript() {
    if (window.ort) return Promise.resolve(window.ort);
    if (_loadPromise) return _loadPromise;
    _loadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = ORT_UMD_PATH;
        script.async = true;
        script.onload = () => {
            if (window.ort) {
                resolve(window.ort);
            } else {
                _loadPromise = null; // allow retry
                reject(new Error('ort.all.min.js loaded but window.ort is undefined'));
            }
        };
        script.onerror = () => {
            _loadPromise = null; // allow retry
            reject(new Error(`Failed to load ${ORT_UMD_PATH}`));
        };
        document.head.appendChild(script);
    });
    return _loadPromise;
}

/**
 * 确保 ort 全局变量已初始化，并配置 WASM 路径
 * @returns {object} ort 全局对象
 */
export async function ensureOrt() {
    if (ort) return ort;

    // Backend 1: native ORT (Tauri). Loaded from disk, executes in Rust.
    const native = await tryInitNativeBackend();
    if (native) {
        ort = native;
        console.log('[Inference] Using native ONNX Runtime backend (NNAPI/CoreML/CPU)');
        return ort;
    }

    // Backend 2: onnxruntime-web UMD (browser dev / fallback).
    if (typeof window === 'undefined' || !window.ort) {
        await loadOrtScript();
    }

    if (typeof window !== 'undefined' && window.ort) {
        ort = window.ort;
        console.log('[WebNN] onnxruntime-web loaded from global, version:', ort.env?.versions?.web || 'unknown');

        // Configure WASM paths — must point to directory containing .wasm files
        // In Electron dev mode, the HTML is served from http://localhost:9000/main_window/
        // and the WASM files are copied to the same directory by webpack CopyPlugin
        if (ort.env?.wasm) {
            ort.env.wasm.wasmPaths = './';
            // Enable multi-threaded WASM execution. Requires crossOriginIsolated (COOP/COEP),
            // which is set in main.js onHeadersReceived. Sandbox is disabled on all windows.
            const cpuCores = navigator.hardwareConcurrency || 4;
            ort.env.wasm.numThreads = Math.max(1, cpuCores - 1);
            ort.env.wasm.memoryLimit = 3584; // 3.5GB - 32-bit WASM max is ~4GB, leave some headroom
            console.log(`[WebNN] WASM paths configured: ${ort.env.wasm.wasmPaths}, numThreads: ${ort.env.wasm.numThreads} (cpu cores: ${cpuCores}), memoryLimit: ${ort.env.wasm.memoryLimit}MB (32-bit WASM), crossOriginIsolated: ${self.crossOriginIsolated}`);
        }
    } else {
        throw new Error('onnxruntime-web failed to load. ensureOrt() did not find window.ort.');
    }
    return ort;
}

/**
 * 获取当前 ort 引用（不触发初始化）
 * @returns {object|null}
 */
export function getOrt() {
    return ort;
}

/**
 * 当前后端是否为原生 ORT（true）或 onnxruntime-web（false）。
 * 未初始化时返回 false。
 */
export function isNativeBackend() {
    return Boolean(ort && ort.__isNativeFacade);
}

/** 测试重置：清空缓存的后端引用 */
export function __resetOrtForTests() {
    ort = null;
}
