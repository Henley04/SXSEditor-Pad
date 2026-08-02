/**
 * Basic Pitch MIDI 提取 — 渲染器原生路径（LiteRT 优先，TF.js 回退）。
 *
 * 执行路径选择：
 *   1. LiteRT（首选）：模型目录存在 basic_pitch_model/basic_pitch.tflite
 *      且原生 libtensorflowlite_c 可用 → Rust 侧解释执行
 *     （Android 可用 NNAPI delegate / iOS CoreML delegate）。
 *   2. TF.js（回退）：basic_pitch_model/model.json 经 tf.io.fromMemory
 *      加载（无需 Node HTTP 服务器，纯 WebView 可运行），WASM 后端
 *      失败回退 CPU 后端。
 *
 * 后处理（帧输出 → 音符/F0）与 Electron 主进程版完全一致，见
 * inference/basicPitchPostprocess.js。
 *
 * 暴露给 tauri-bridge：extractBasicPitchNative({audioData, sampleRate, bpm})
 *   → { success, notes, f0Array } —— 与旧 extract_f0_basic_pitch IPC 同构。
 */

import pp from '../basicPitchPostprocess.js';
import { resampleAudio } from '../../utils/resampleAudio.js';

const SR = pp.BASIC_PITCH_SAMPLE_RATE; // 22050
const AUDIO_N_SAMPLES = pp.AUDIO_N_SAMPLES; // 43844
const HOP_SIZE = pp.HOP_SIZE;
const OVERLAP_LENGTH_FRAMES = pp.OVERLAP_LENGTH_FRAMES;
const N_OVERLAP_OVER_2 = pp.N_OVERLAP_OVER_2;
const N_CONTOUR_BINS = 264;

const TFLITE_MODEL_REL = 'basic_pitch_model/basic_pitch.tflite';
const TFJS_MODEL_JSON_REL = 'basic_pitch_model/model.json';
const TFJS_MODEL_BIN_REL = 'basic_pitch_model/group1-shard1of1.bin';

/**
 * LiteRT 输出顺序假设（与 TF.js execute 输出顺序一致）：
 * [0]=note [1]=onset [2]=contour。若转换出的 .tflite 顺序不同，
 * 只需调整本数组 —— contour 始终按 last-dim=264 形状校验。
 */
const TFLITE_OUTPUT_ORDER = ['note', 'onset', 'contour'];

let _modelDir = null;
async function resolveModelDir() {
    if (_modelDir) return _modelDir;
    _modelDir = (await window.electronAPI.getModelDir()).replace(/\\/g, '/');
    return _modelDir;
}

/** 测试注入 */
export function __setModelDirForTests(dir) { _modelDir = dir; }

async function fileExists(path) {
    try {
        return await window.electronAPI.fileExists(path);
    } catch (_) {
        return false;
    }
}

// ------------------------------ 音频分帧 ------------------------------

/**
 * 与 BasicPitchDetector.extractF0AndNotes 的分帧逻辑一致：
 * 前补 OVERLAP_LENGTH_FRAMES/2 零，按 AUDIO_N_SAMPLES 窗 / HOP_SIZE 跳切分。
 * @returns {{frames: Float32Array[], nOutputFramesOriginal: number}}
 */
export function frameAudio(resampledAudio) {
    const padLen = Math.floor(OVERLAP_LENGTH_FRAMES / 2);
    const padded = new Float32Array(padLen + resampledAudio.length);
    padded.set(resampledAudio, padLen);

    const nOutputFramesOriginal = Math.floor(resampledAudio.length * (pp.ANNOTATIONS_FPS / SR));
    const frames = [];
    for (let start = 0; start + AUDIO_N_SAMPLES <= padded.length; start += HOP_SIZE) {
        frames.push(padded.subarray(start, start + AUDIO_N_SAMPLES));
    }
    if (frames.length === 0) {
        // 音频不足一窗：零填充到一窗（TF.js 路径 tf.signal.frame 不会产生
        // 空批次，这里对齐其行为的最简处理）
        const win = new Float32Array(AUDIO_N_SAMPLES);
        win.set(padded.subarray(0, Math.min(padded.length, AUDIO_N_SAMPLES)));
        frames.push(win);
    }
    return { frames, nOutputFramesOriginal };
}

/**
 * 对输出 [T_total, C] 行数组做 overlap 裁剪（对应 unwrapOutput）。
 */
function unwrapRows(flat, totalC) {
    // flat: Float32Array of shape [1, T, C] → rows T = T_total
    const T = Math.floor(flat.length / totalC);
    const startRow = Math.min(N_OVERLAP_OVER_2, Math.max(0, T - 1));
    const endRow = Math.max(startRow, T - N_OVERLAP_OVER_2);
    return flat.subarray(startRow * totalC, endRow * totalC);
}

/**
 * 累积三组输出直至达到原始帧数（对应 extractF0AndNotes 的截断逻辑）。
 */
class OutputAccumulator {
    constructor(nOutputFramesOriginal) {
        this.limit = nOutputFramesOriginal;
        this.collected = 0;
        this.note = [];
        this.onset = [];
        this.contour = [];
    }

    /**
     * @returns {boolean} true 表示后续批次可全部跳过
     */
    push(noteFlat, onsetFlat, contourFlat) {
        if (this.collected >= this.limit) return true;
        const rows = Math.floor(noteFlat.length / 88);
        let take = rows;
        if (this.collected + rows >= this.limit) {
            take = Math.max(0, this.limit - this.collected);
        }
        if (take > 0) {
            this.note.push(noteFlat.subarray(0, take * 88));
            this.onset.push(onsetFlat.subarray(0, take * 88));
            this.contour.push(contourFlat.subarray(0, take * N_CONTOUR_BINS));
        }
        this.collected += rows;
        return this.collected >= this.limit;
    }

    rows() {
        const concat = (parts, cols) => {
            const total = parts.reduce((a, p) => a + p.length, 0);
            const out = new Float32Array(total);
            let off = 0;
            for (const p of parts) { out.set(p, off); off += p.length; }
            return pp.flatTo2DRows(out, cols);
        };
        return {
            frames: concat(this.note, 88),
            onsets: concat(this.onset, 88),
            contours: concat(this.contour, N_CONTOUR_BINS),
        };
    }
}

// ------------------------------ LiteRT 路径 ------------------------------

let _tfliteState = null; // null=未探测, 'ready', 'unavailable'

async function tryInitTflite(modelDir) {
    if (_tfliteState === 'unavailable') return false;
    if (_tfliteState === 'ready') return true;
    try {
        if (!window.electronAPI?.nativeTfliteInit) {
            _tfliteState = 'unavailable';
            return false;
        }
        const modelPath = `${modelDir}/${TFLITE_MODEL_REL}`;
        if (!(await fileExists(modelPath))) {
            _tfliteState = 'unavailable';
            return false;
        }
        const initRes = await window.electronAPI.nativeTfliteInit(null);
        if (!initRes?.available) {
            _tfliteState = 'unavailable';
            return false;
        }
        const loadRes = await window.electronAPI.nativeTfliteLoadModel('basicPitch', modelPath, 4, true);
        if (!loadRes?.success) {
            _tfliteState = 'unavailable';
            return false;
        }
        console.log('[BasicPitch/LiteRT] model loaded:', JSON.stringify(loadRes.inputShapes), '→', JSON.stringify(loadRes.outputShapes), loadRes.accelerated ? '(accelerated)' : '(cpu)');
        _tfliteState = 'ready';
        return true;
    } catch (e) {
        console.warn('[BasicPitch/LiteRT] init failed:', e?.message || e);
        _tfliteState = 'unavailable';
        return false;
    }
}

function f32ToB64(f32) {
    const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

function b64ToF32(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer);
}

async function runTfliteWindow(windowSamples) {
    const res = await window.electronAPI.nativeTfliteRun('basicPitch', [{
        index: 0,
        shape: [1, AUDIO_N_SAMPLES, 1],
        dataB64: f32ToB64(windowSamples),
    }]);
    const outs = res?.outputs || [];
    // 按形状校验 contour（last-dim 264）；其余按 TFLITE_OUTPUT_ORDER。
    const byShape = { note: null, onset: null, contour: null };
    const sorted = [...outs].sort((a, b) => a.index - b.index);
    let orderIdx = 0;
    for (const o of sorted) {
        const shape = o.shape || [];
        const lastDim = shape[shape.length - 1];
        const kind = lastDim === N_CONTOUR_BINS ? 'contour' : TFLITE_OUTPUT_ORDER[orderIdx] || 'note';
        if (kind !== 'contour') orderIdx++;
        byShape[kind] = b64ToF32(o.dataB64);
    }
    if (!byShape.note || !byShape.onset || !byShape.contour) {
        throw new Error('LiteRT outputs incomplete');
    }
    return byShape;
}

// ------------------------------ TF.js 路径 ------------------------------

let _tfModule = null;
let _tfModel = null;
let _tfModelDir = null;

async function loadTfModel(modelDir) {
    if (_tfModel && _tfModelDir === modelDir) return _tfModel;
    if (!_tfModule) {
        const tf = await import('@tensorflow/tfjs');
        _tfModule = tf;
        try {
            const wasmBackend = await import('@tensorflow/tfjs-backend-wasm');
            if (wasmBackend.setWasmPaths) {
                // vite 构建把 tfjs wasm 复制到 /tfjs-wasm/（见 vite.config.js）
                wasmBackend.setWasmPaths('/tfjs-wasm/');
            }
            await tf.setBackend('wasm');
            await tf.ready();
            console.log('[BasicPitch/TF.js] backend: wasm');
        } catch (e) {
            console.warn('[BasicPitch/TF.js] wasm backend failed, using cpu:', e?.message || e);
            await tf.setBackend('cpu');
            await tf.ready();
        }
    }
    const tf = _tfModule;
    const jsonPath = `${modelDir}/${TFJS_MODEL_JSON_REL}`;
    const binPath = `${modelDir}/${TFJS_MODEL_BIN_REL}`;
    const [jsonText, binBytes] = await Promise.all([
        window.electronAPI.readFile(jsonPath),
        window.electronAPI.readFileBuffer(binPath),
    ]);
    const modelJson = JSON.parse(jsonText);
    const weightSpecs = modelJson.weightsManifest?.[0]?.weights;
    if (!weightSpecs) throw new Error('basic_pitch model.json missing weightsManifest');
    const weightData = binBytes instanceof ArrayBuffer
        ? binBytes
        : (binBytes?.buffer || binBytes);
    const handler = tf.io.fromMemory(modelJson, weightSpecs, weightData);
    _tfModel = await tf.loadGraphModel(handler);
    _tfModelDir = modelDir;
    console.log('[BasicPitch/TF.js] model loaded from memory');
    return _tfModel;
}

async function runTfjsWindows(frames, nOutputFramesOriginal, onFrame) {
    const tf = _tfModule;
    const acc = new OutputAccumulator(nOutputFramesOriginal);
    for (let i = 0; i < frames.length; i++) {
        if (acc.collected >= acc.limit) break;
        const input = tf.tensor3d(frames[i], [1, AUDIO_N_SAMPLES, 1]);
        const results = _tfModel.execute(input, ['Identity_1', 'Identity_2', 'Identity']);
        const noteFlat = unwrapRows(results[0].dataSync(), 88);
        const onsetFlat = unwrapRows(results[1].dataSync(), 88);
        const contourFlat = unwrapRows(results[2].dataSync(), N_CONTOUR_BINS);
        acc.push(noteFlat, onsetFlat, contourFlat);
        input.dispose();
        results.forEach((t) => t.dispose());
        if (onFrame) onFrame(i + 1, frames.length);
    }
    return acc.rows();
}

// ------------------------------ 入口 ------------------------------

/**
 * 提取 MIDI 音符 + F0。
 * @param {{audioData: ArrayBuffer|Float32Array, sampleRate: number, bpm?: number}} params
 * @returns {Promise<{success: boolean, notes?: Array, f0Array?: Array, error?: string, backend?: string}>}
 */
export async function extractBasicPitchNative({ audioData, sampleRate, bpm = 120 }) {
    try {
        const modelDir = await resolveModelDir();
        const f32 = audioData instanceof Float32Array ? audioData : new Float32Array(audioData);
        const resampled = sampleRate !== SR ? resampleAudio(f32, sampleRate, SR) : f32;
        const { frames, nOutputFramesOriginal } = frameAudio(resampled);

        let rows;
        let backend;
        if (await tryInitTflite(modelDir)) {
            const acc = new OutputAccumulator(nOutputFramesOriginal);
            for (let i = 0; i < frames.length && acc.collected < acc.limit; i++) {
                const outs = await runTfliteWindow(frames[i]);
                acc.push(
                    unwrapRows(outs.note, 88),
                    unwrapRows(outs.onset, 88),
                    unwrapRows(outs.contour, N_CONTOUR_BINS),
                );
            }
            rows = acc.rows();
            backend = 'litert';
        } else {
            await loadTfModel(modelDir);
            rows = await runTfjsWindows(frames, nOutputFramesOriginal);
            backend = 'tfjs';
        }

        const result = pp.postprocessModelOutputs(rows.frames, rows.onsets, rows.contours, bpm);
        return { success: true, notes: result.notes, f0Array: result.f0Array, backend };
    } catch (e) {
        return { success: false, error: e?.message || String(e) };
    }
}

/** 测试重置 */
export function __resetForTests() {
    _modelDir = null;
    _tfliteState = null;
    _tfModule = null;
    _tfModel = null;
    _tfModelDir = null;
}
