<!--
  OnboardingOverlay.vue — first-launch onboarding guide.

  Shows a 3-step modal on first launch:
  1. Welcome — concise intro (not a README repeat)
  2. Hardware check — real ONNX benchmark via ORT Web, testing CPU / NNAPI(NPU) /
     GPU execution providers, reporting device name + speed rating
  3. Model download prompt (navigate to model download page)

  Visibility: localStorage flag 'sxseditor.onboarding.completed'.
  Orientation: suggests landscape (CSS + orientation lock hint).
-->
<template>
  <div v-if="visible" class="onboarding-overlay">
    <div class="onboarding-dialog">
      <!-- Step progress dots -->
      <div class="onboarding-progress">
        <span v-for="i in 3" :key="i"
          class="onboarding-dot"
          :class="{ active: step >= i, done: step > i }"></span>
      </div>

      <!-- Step 1: Welcome -->
      <div v-if="step === 1" class="onboarding-step">
        <div class="onboarding-welcome-row">
          <div class="onboarding-emoji">{{ '\u{1F4F1}' }}</div>
          <div class="onboarding-welcome-text">
            <h2 class="onboarding-title">欢迎使用 SXSEditor</h2>
            <p class="onboarding-desc">使用 SXSEditor 在移动设备上充分利用您的 NPU 进行歌声推理，借助其强大的内置功能，让创意随处可及。</p>
          </div>
        </div>
        <div class="onboarding-nav">
          <button class="onboarding-btn-secondary" @click="complete">{{ skipLabel }}</button>
          <button class="onboarding-btn-primary" @click="step = 2">下一步</button>
        </div>
      </div>

      <!-- Step 2: Hardware Benchmark -->
      <div v-if="step === 2" class="onboarding-step">
        <h2 class="onboarding-title">硬件检测</h2>
        <p class="onboarding-desc">正在使用内置 ONNX 模型测试设备算力...</p>
        <div class="benchmark-results">
          <div v-if="benchLoading" class="bench-loading">
            <div class="bench-spinner"></div>
            <span>{{ benchStatus }}</span>
          </div>
          <div v-else class="bench-list">
            <div v-for="r in benchResults" :key="r.ep" class="bench-row">
              <div class="bench-ep">
                <span class="bench-ep-icon">{{ r.icon }}</span>
                <span class="bench-ep-name">{{ r.label }}</span>
                <span v-if="r.available" class="bench-device">{{ r.device }}</span>
                <span v-else class="bench-unavailable">不支持</span>
              </div>
              <div v-if="r.available" class="bench-metrics">
                <span v-if="r.avgMs > 0" class="bench-time">{{ r.avgMs.toFixed(2) }} ms</span>
                <span v-if="r.tops > 0" class="bench-tops">{{ formatTops(r.tops) }}</span>
                <span v-if="r.avgMs > 0" class="bench-speed" :class="r.speedClass">{{ r.speedLabel }}</span>
                <span v-if="r.avgMs === 0" class="bench-available-no-bench">可用</span>
              </div>
            </div>
          </div>
        </div>
        <div class="onboarding-nav">
          <button class="onboarding-btn-secondary" @click="step = 1">上一步</button>
          <button class="onboarding-btn-primary" :disabled="benchLoading" @click="step = 3">下一步</button>
        </div>
      </div>

      <!-- Step 3: Model Download -->
      <div v-if="step === 3" class="onboarding-step">
        <div class="onboarding-welcome-row">
          <div class="onboarding-emoji">{{ '\u{1F4E6}' }}</div>
          <div class="onboarding-welcome-text">
            <h2 class="onboarding-title">下载模型</h2>
            <p class="onboarding-desc">需要下载推理模型（约 500MB）才能开始使用。模型来自 ModelScope，建议在 Wi-Fi 环境下下载。</p>
          </div>
        </div>
        <div class="onboarding-nav">
          <button class="onboarding-btn-secondary" @click="step = 2">上一步</button>
          <button class="onboarding-btn-primary" @click="goToModelDownload">前往下载</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue';
import * as spa from '../../../spa/router.js';
import { BENCHMARK_MODEL_BASE64 } from '../../../assets/benchmark_model.js';
import { ensureOrt, isNativeBackend } from '../../../inference/webnn/ortSetup.js';
import { detectNativeAccelerators } from '../../../inference/native/nativeOrtClient.js';
import { getCPUName, getGPUName, acceleratorLabel } from '../../../utils/deviceNames.js';

const visible = ref(false);
const step = ref(1);
const skipLabel = '跳过引导';

// Benchmark state
const benchLoading = ref(true);
const benchStatus = ref('正在加载 ONNX Runtime...');
const benchResults = ref([]);
// Tracks whether the benchmark has been kicked off at least once. Used by the
// step watcher so re-entering step 2 (back/forward) never re-runs the
// benchmark, while still triggering it on the very first visit.
const benchStarted = ref(false);

onMounted(() => {
  const done = localStorage.getItem('sxseditor.onboarding.completed');
  if (!done) {
    visible.value = true;
  }
});

/**
 * Write the base64 benchmark model to a temporary file on disk.
 * The native ORT backend requires a file path (__modelPath) to create
 * sessions — it cannot create sessions from in-memory byte arrays.
 * Uses the Rust write_binary_file command (not the fs plugin, which
 * requires capabilities config that may not be set up).
 * Returns the file path or null if writing failed.
 */
async function writeBenchmarkModelToDisk(modelBytes) {
  try {
    // Write the temp model into the OS temp dir so it never pollutes the
    // user's model download directory.
    const tempDir = await window.electronAPI.getTempDir();
    if (!tempDir) {
      console.warn('[benchmark] getTempDir returned empty');
      return null;
    }
    const sep = tempDir.includes('\\') ? '\\' : '/';
    const benchPath = tempDir + sep + 'sxs-onboarding-benchmark.onnx';
    // Use the Rust command directly — bypasses fs plugin capability issues
    await window.electronAPI.writeBinaryFile(benchPath, Array.from(modelBytes));
    console.log('[benchmark] Model written to:', benchPath);
    return benchPath;
  } catch (err) {
    console.warn('[benchmark] Failed to write model to disk:', err);
    return null;
  }
}

/**
 * Clean up the temporary benchmark model file.
 */
async function cleanupBenchmarkModel(filePath) {
  if (!filePath) return;
  try {
    await window.electronAPI.deleteFile(filePath);
  } catch (_) { /* non-fatal */ }
}

async function runBenchmark() {
  benchLoading.value = true;
  benchStatus.value = '正在加载 ONNX Runtime...';
  benchResults.value = [];
  benchStarted.value = true;

  const results = [];

  // Load the same ORT instance the app uses: Rust ORT first (sole production
  // backend — NNAPI/CoreML/CPU), falling back to onnxruntime-web (WASM) only
  // so the CPU benchmark can still run when the native libonnxruntime isn't
  // bundled (e.g. desktop dev). The NPU/GPU/DSP rows are still gated on real
  // accelerator detection so they never show misleading CPU-fallback numbers.
  let ort;
  try {
    ort = await ensureOrt();
  } catch (err) {
    console.warn('[benchmark] Failed to load ONNX Runtime:', err);
    benchStatus.value = 'ONNX Runtime 不可用，无法进行硬件检测';
    benchResults.value = [
      { ep: 'cpu', label: 'CPU', icon: '\u{2699}\u{FE0F}', available: false, avgMs: 0, tops: 0, device: '', speedLabel: '', speedClass: '' },
      { ep: 'npu', label: 'NPU', icon: '\u{1F9EE}', available: false, avgMs: 0, tops: 0, device: '', speedLabel: '', speedClass: '' },
      { ep: 'gpu', label: 'GPU', icon: '\u{1F3AE}', available: false, avgMs: 0, tops: 0, device: '', speedLabel: '', speedClass: '' },
      { ep: 'dsp', label: 'DSP', icon: '\u{1F5A5}', available: false, avgMs: 0, tops: 0, device: '', speedLabel: '', speedClass: '' },
    ];
    benchLoading.value = false;
    return;
  }
  // true = Rust ORT (native), false = onnxruntime-web (dev fallback).
  const native = isNativeBackend();

  // Real device identity from the Rust backend (SoC model, accelerator set).
  const deviceInfo = await getDeviceInfo();

  // Decode base64 model to Uint8Array
  const binaryString = atob(BENCHMARK_MODEL_BASE64);
  const modelBytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    modelBytes[i] = binaryString.charCodeAt(i);
  }

  // The native backend requires a model file path (__modelPath); sessions are
  // created from the file on disk, so write the benchmark model to a temp file.
  // The ort-web fallback creates sessions from the in-memory bytes directly.
  let benchModelPath = null;
  if (native) {
    benchStatus.value = '正在准备基准测试模型...';
    benchModelPath = await writeBenchmarkModelToDisk(modelBytes);
    if (!benchModelPath) {
      console.warn('[benchmark] Cannot write model to disk; native benchmark will fail.');
    }
  }

  // Test data: [1, 512, 512] float32 — matches the compute-bound MatMul chain.
  const inputSize = 512 * 512;
  const inputData = new Float32Array(inputSize);
  for (let i = 0; i < inputSize; i++) {
    inputData[i] = Math.random();
  }
  const inputTensor = { input: new ort.Tensor('float32', inputData, [1, 512, 512]) };

  // The benchmark model now does ~2.15 GFLOPs/inference, so fewer iterations
  // are enough for a stable, compute-dominated average without a long wait.
  const WARMUP_ITERS = 5;
  const BENCH_ITERS = 20;

  // Detect available native accelerators for display purposes. On the native
  // backend NNAPI (Android) / CoreML (iOS) expose a single accelerator EP with
  // an internal CPU fallback, so we gate the NPU/GPU/DSP rows on this result —
  // a session that "succeeds" does NOT prove the accelerator exists.
  let accelerators = null;
  if (native) {
    accelerators = await detectNativeAccelerators();
    console.log('[benchmark] Native accelerators:', JSON.stringify(accelerators));
  }

  // Helper: create a session for the given device preference.
  // Native backend: __modelPath + devicePreference (Rust picks the EP).
  // ort-web fallback: modelBytes + executionProviders ([webnn] for accel).
  async function createSession(devicePref) {
    if (native && benchModelPath) {
      return await ort.InferenceSession.create(null, {
        __modelPath: benchModelPath,
        __modelId: `bench-${devicePref}-${Date.now()}`,
        graphOptimizationLevel: 'all',
        devicePreference: devicePref,
      });
    }
    return await ort.InferenceSession.create(modelBytes, {
      executionProviders: devicePref === 'cpu'
        ? ['wasm']
        : [{ name: 'webnn', deviceType: devicePref }],
      graphOptimizationLevel: 'all',
    });
  }

  // Whether an accelerator row may be attempted / claimed as available.
  // Native: gated on Rust accelerator detection. ort-web: only if WebNN exists.
  function canUseAccelerator(ep) {
    if (native) return Boolean(accelerators && accelerators[ep]);
    return typeof navigator !== 'undefined' && !!navigator.ml;
  }

  /**
   * Run a benchmark for one device preference.
   * Returns { available: true, avgMs, tops } on success,
   * or { available: false } on failure.
   */
  async function benchOne(devicePref) {
    const session = await createSession(devicePref);
    // Warmup
    for (let i = 0; i < WARMUP_ITERS; i++) {
      await session.run(inputTensor);
    }
    const t0 = performance.now();
    for (let i = 0; i < BENCH_ITERS; i++) {
      await session.run(inputTensor);
    }
    const t1 = performance.now();
    const avgMs = (t1 - t0) / BENCH_ITERS;
    session.release();
    // Estimate TOPS: the benchmark model is a chain of 8 MatMuls,
    // each [1,512,512] x [512,512] = 8 * 2 * 512^3 = 2147483648 FLOPs/inference.
    // TOPS = FLOPs / (avgMs * 1e-3) / 1e12
    const FLOPS_PER_INFER = 8 * 2 * 512 * 512 * 512;
    const tops = (FLOPS_PER_INFER / (avgMs * 1e-3)) / 1e12;
    return { available: true, avgMs, tops };
  }

  // --- CPU benchmark (always available) ---
  try {
    benchStatus.value = '正在测试 CPU 算力...';
    const r = await benchOne('cpu');
    results.push({
      ep: 'cpu',
      label: 'CPU',
      icon: '\u{2699}\u{FE0F}',
      available: true,
      avgMs: r.avgMs,
      tops: r.tops,
      device: getCPUName(deviceInfo),
      speedLabel: getSpeedLabel(r.avgMs),
      speedClass: getSpeedClass(r.avgMs),
    });
  } catch (err) {
    console.warn('[benchmark] CPU test failed:', err);
    results.push({
      ep: 'cpu', label: 'CPU', icon: '\u{2699}\u{FE0F}',
      available: false, avgMs: 0, tops: 0, device: '', speedLabel: '', speedClass: '',
    });
  }

  // --- NPU / GPU / DSP (gated on accelerator availability) ---
  // On the native backend NNAPI (Android) / CoreML (iOS) fold a CPU fallback
  // into every session, so a session that "succeeds" does NOT prove the
  // accelerator exists — it just proves the model loaded on CPU. Gating on
  // accelerator detection prevents a device without an NPU/GPU/DSP from being
  // shown an "available" row with CPU-level numbers.
  const accelRows = [
    { ep: 'npu', label: 'NPU', icon: '\u{1F9EE}', device: acceleratorLabel(deviceInfo, 'NPU') },
    { ep: 'gpu', label: 'GPU', icon: '\u{1F3AE}', device: getGPUName(deviceInfo) },
    { ep: 'dsp', label: 'DSP', icon: '\u{1F5A5}', device: acceleratorLabel(deviceInfo, 'DSP') },
  ];

  for (const row of accelRows) {
    if (!canUseAccelerator(row.ep)) {
      results.push({
        ep: row.ep, label: row.label, icon: row.icon,
        available: false, avgMs: 0, tops: 0, device: '', speedLabel: '', speedClass: '',
      });
      continue;
    }
    try {
      benchStatus.value = `正在测试 ${row.label} 算力...`;
      const r = await benchOne(row.ep);
      results.push({
        ep: row.ep, label: row.label, icon: row.icon,
        available: true, avgMs: r.avgMs, tops: r.tops,
        device: row.device,
        speedLabel: getSpeedLabel(r.avgMs), speedClass: getSpeedClass(r.avgMs),
      });
    } catch (err) {
      console.info(`[benchmark] ${row.label} not available:`, err.message);
      results.push({
        ep: row.ep, label: row.label, icon: row.icon,
        available: false, avgMs: 0, tops: 0, device: '', speedLabel: '', speedClass: '',
      });
    }
  }

  benchResults.value = results;
  benchLoading.value = false;

  // Clean up temp model file
  if (benchModelPath) {
    cleanupBenchmarkModel(benchModelPath);
  }
}

/**
 * Fetch real device identity from the Rust backend. Falls back to a UA-parsed
 * guess only if the native command is unavailable.
 */
async function getDeviceInfo() {
  try {
    const info = await window.electronAPI.getDeviceInfo();
    if (info) return info;
  } catch (err) {
    console.warn('[benchmark] getDeviceInfo failed:', err?.message || err);
  }
  return {
    platform: 'unknown',
    arch: '',
    isMobile: false,
    cpuName: null,
    gpuName: null,
    accelerators: {},
  };
}

function getSpeedLabel(ms) {
  if (ms < 0.5) return '极快';
  if (ms < 2) return '快速';
  if (ms < 10) return '中等';
  if (ms < 50) return '较慢';
  return '慢';
}

function getSpeedClass(ms) {
  if (ms < 0.5) return 'speed-fast';
  if (ms < 2) return 'speed-fast';
  if (ms < 10) return 'speed-mid';
  if (ms < 50) return 'speed-slow';
  return 'speed-slow';
}

function formatTops(tops) {
  if (!tops || tops <= 0) return '';
  if (tops >= 1) return tops.toFixed(2) + ' TOPS';
  if (tops >= 0.001) return (tops * 1000).toFixed(2) + ' GOPS';
  return (tops * 1e6).toFixed(1) + ' MOPS';
}

function complete() {
  localStorage.setItem('sxseditor.onboarding.completed', '1');
  visible.value = false;
}

async function goToModelDownload() {
  complete();
  spa.navigate('model-download');
}

// Watch for step changes to trigger benchmark
watch(step, (newStep) => {
  if (newStep === 2 && !benchStarted.value) {
    runBenchmark();
  }
});
</script>

<style scoped>
.onboarding-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(8px);
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.onboarding-dialog {
  background: var(--bg-panel, #1e1e2e);
  border-radius: 16px;
  max-width: 480px;
  width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  padding: 24px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
  border: 1px solid var(--border-strong, #444460);
}

.onboarding-progress {
  display: flex;
  gap: 8px;
  justify-content: center;
  margin-bottom: 20px;
}

.onboarding-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--border-strong, #444460);
  transition: background 0.3s;
}

.onboarding-dot.active {
  background: var(--accent, #5b8def);
}

.onboarding-dot.done {
  background: var(--success, #22c55e);
}

.onboarding-step {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.onboarding-welcome-row {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}

.onboarding-emoji {
  font-size: 40px;
  line-height: 1;
  flex-shrink: 0;
}

.onboarding-welcome-text {
  flex: 1;
}

.onboarding-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--fg-primary, #e0e0f0);
  margin: 0 0 8px 0;
}

.onboarding-desc {
  font-size: 14px;
  line-height: 1.6;
  color: var(--fg-secondary, #a0a0b0);
  margin: 0;
}

/* Benchmark */
.benchmark-results {
  margin-top: 8px;
}

.bench-loading {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  color: var(--fg-secondary, #a0a0b0);
  font-size: 14px;
}

.bench-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border-strong, #444460);
  border-top-color: var(--accent, #5b8def);
  border-radius: 50%;
  animation: bench-spin 0.8s linear infinite;
  flex-shrink: 0;
}

@keyframes bench-spin {
  to { transform: rotate(360deg); }
}

.bench-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.bench-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  background: var(--bg-app, rgba(255, 255, 255, 0.03));
  border-radius: 10px;
  border: 1px solid var(--border-soft, rgba(255, 255, 255, 0.08));
}

.bench-ep {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--fg-primary, #e0e0f0);
}

.bench-ep-icon {
  font-size: 18px;
}

.bench-ep-name {
  font-weight: 600;
}

.bench-device {
  font-size: 11px;
  color: var(--fg-muted, #6a6a8a);
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bench-unavailable {
  font-size: 11px;
  color: var(--danger, #ef4444);
}

.bench-metrics {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}

.bench-time {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg-primary, #e0e0f0);
}

.bench-tops {
  font-size: 11px;
  color: var(--accent, #5b8def);
  font-weight: 500;
}

.bench-available-no-bench {
  font-size: 11px;
  color: var(--success, #22c55e);
  font-weight: 500;
}

.bench-speed {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
}

.speed-fast {
  background: rgba(34, 197, 94, 0.15);
  color: #22c55e;
}

.speed-mid {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
}

.speed-slow {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
}

/* Navigation */
.onboarding-nav {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin-top: 16px;
}

.onboarding-btn-primary {
  padding: 10px 24px;
  background: var(--accent, #5b8def);
  color: var(--fg-on-accent, #fff);
  border: none;
  border-radius: 10px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
  min-height: 44px;
}

.onboarding-btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 16px var(--accent-glow, rgba(91, 141, 239, 0.3));
}

.onboarding-btn-primary:active {
  transform: scale(0.97);
}

.onboarding-btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.onboarding-btn-secondary {
  padding: 10px 24px;
  background: transparent;
  color: var(--fg-secondary, #a0a0b0);
  border: 1px solid var(--border-strong, #444460);
  border-radius: 10px;
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
  min-height: 44px;
}

.onboarding-btn-secondary:hover {
  background: var(--bg-button-hover, rgba(255, 255, 255, 0.06));
}
</style>
