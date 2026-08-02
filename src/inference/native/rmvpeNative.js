/**
 * RMVPE F0 提取 — 渲染器原生路径。
 *
 * 通过后端无关的会话层（sessionManager）执行 preprocess/rmvpe_model.onnx：
 * 原生 ORT 可用时在 Rust 侧运行（CPU EP），否则回退 onnxruntime-web WASM。
 * 解码逻辑（argmax → indexToF0 LUT → 24kHz/480 重采样插值）与
 * inference/rmvpePitchDetector.js（桌面 Electron 主进程版）保持一致。
 *
 * 暴露给 tauri-bridge：extractF0Native({audioData, sampleRate})
 *   → { success, f0Array: [{time, f0, confidence}] } —— 与旧
 *   extract_f0_onnx IPC 的返回结构一致，调用方（audioPreprocess/f0Extraction.js）
 *   无需改动。
 */

import { loadModel, runSession } from '../webnn/sessionManager.js';
import { ensureOrt, getOrt } from '../webnn/ortSetup.js';
import { resampleAudio } from '../../utils/resampleAudio.js';

export const RMVPE_SAMPLE_RATE = 16000;
const N_CLASS = 2560;
const F0_MIN = 30;
const F0_MAX = 7600;
const TARGET_SAMPLE_RATE = 24000;
const TARGET_HOP_SIZE = 480;
const MAX_DURATION = 300;

let _f0Lut = null;
let _modelPath = null;

async function resolveModelPath() {
    if (_modelPath) return _modelPath;
    const modelDir = await window.electronAPI.getModelDir();
    _modelPath = `${modelDir}/preprocess/rmvpe_model.onnx`.replace(/\\/g, '/');
    return _modelPath;
}

/** 供测试注入模型路径 */
export function __setModelPathForTests(p) { _modelPath = p; }
export function __resetForTests() { _modelPath = null; _f0Lut = null; }

function getF0Lut() {
    if (!_f0Lut) {
        _f0Lut = new Float32Array(N_CLASS);
        for (let i = 0; i < N_CLASS; i++) {
            _f0Lut[i] = F0_MIN * Math.pow(F0_MAX / F0_MIN, i / (N_CLASS - 1));
        }
    }
    return _f0Lut;
}

/**
 * F0 帧序列插值到目标采样率网格（与 RmvpePitchDetector.interpolateF0 一致）。
 */
export function interpolateF0(f0Data, originalLength, originalSr, targetSr, hopSize) {
    const rmvpeHop = 160;
    const rmvpeSr = 16000;

    const batchMaxLength = Math.floor(MAX_DURATION * targetSr / hopSize);
    const durationInSeconds = originalLength / originalSr;
    const effectiveTargetLength = Math.floor(durationInSeconds * targetSr);
    const originalFrames = Math.ceil(effectiveTargetLength / hopSize);
    const targetFrames = Math.min(originalFrames, batchMaxLength);

    const result = new Float32Array(targetFrames);
    if (f0Data.length === 0) return result;
    if (f0Data.length === 1) {
        result[0] = f0Data[0];
        return result;
    }

    const srcStep = rmvpeHop / rmvpeSr;
    const tgtStep = hopSize / targetSr;
    const tSrcMax = (f0Data.length - 1) * srcStep;

    for (let i = 0; i < targetFrames; i++) {
        const t = i * tgtStep;
        if (t > tSrcMax) {
            result[i] = 0;
            continue;
        }
        const srcFloatIdx = t / srcStep;
        const srcIdx = Math.floor(srcFloatIdx);
        if (srcIdx >= f0Data.length - 1) {
            result[i] = f0Data[f0Data.length - 1];
        } else {
            const frac = srcFloatIdx - srcIdx;
            result[i] = f0Data[srcIdx] * (1 - frac) + f0Data[srcIdx + 1] * frac;
        }
    }
    return result;
}

/**
 * 解码模型输出（[1, T, 2560] 音高分类）为 24kHz 网格 F0 序列。
 */
export function decodePitchOutput(pitchData, timeFrames, resampledLength) {
    const lut = getF0Lut();
    const rawF0 = new Float32Array(timeFrames);
    for (let t = 0; t < timeFrames; t++) {
        let maxProb = -Infinity;
        let maxIndex = 0;
        const rowOffset = t * N_CLASS;
        for (let c = 0; c < N_CLASS; c++) {
            const prob = pitchData[rowOffset + c];
            if (prob > maxProb) {
                maxProb = prob;
                maxIndex = c;
            }
        }
        rawF0[t] = lut[maxIndex];
    }
    return interpolateF0(rawF0, resampledLength, RMVPE_SAMPLE_RATE, TARGET_SAMPLE_RATE, TARGET_HOP_SIZE);
}

/**
 * 提取 F0。与旧 extract_f0_onnx IPC 同构的返回。
 * @param {{audioData: ArrayBuffer|Float32Array, sampleRate: number}} params
 * @returns {Promise<{success: boolean, f0Array?: Array, error?: string}>}
 */
export async function extractF0Native({ audioData, sampleRate }) {
    try {
        await ensureOrt();
        const ort = getOrt();
        const modelPath = await resolveModelPath();

        const loadResult = await loadModel('rmvpe', modelPath, { deviceType: 'cpu' });
        if (!loadResult.success) {
            return { success: false, error: `RMVPE model load failed: ${loadResult.error}` };
        }

        const f32 = audioData instanceof Float32Array ? audioData : new Float32Array(audioData);
        const resampled = sampleRate !== RMVPE_SAMPLE_RATE
            ? resampleAudio(f32, sampleRate, RMVPE_SAMPLE_RATE)
            : f32;

        const inputTensor = new ort.Tensor('float32', resampled, [1, resampled.length]);
        const outputs = await runSession('rmvpe', { audio: inputTensor });
        try { inputTensor.dispose?.(); } catch (_) { /* noop */ }

        const pitchOutput = outputs[Object.keys(outputs)[0]];
        const pitchData = pitchOutput.data instanceof Float32Array
            ? pitchOutput.data
            : new Float32Array(pitchOutput.data);
        const timeFrames = Number(pitchOutput.dims[1]);
        try { pitchOutput.dispose?.(); } catch (_) { /* noop */ }

        const interpolatedF0 = decodePitchOutput(pitchData, timeFrames, resampled.length);

        const frameDuration = TARGET_HOP_SIZE / TARGET_SAMPLE_RATE;
        const f0Array = new Array(interpolatedF0.length);
        for (let i = 0; i < interpolatedF0.length; i++) {
            f0Array[i] = { time: i * frameDuration, f0: interpolatedF0[i], confidence: 0 };
        }
        return { success: true, f0Array };
    } catch (e) {
        return { success: false, error: e?.message || String(e) };
    }
}
