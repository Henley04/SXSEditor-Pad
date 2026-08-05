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
                <span class="bench-time">{{ r.avgMs.toFixed(2) }} ms</span>
                <span class="bench-speed" :class="r.speedClass">{{ r.speedLabel }}</span>
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
import { ref, onMounted } from 'vue';
import * as spa from '../../../spa/router.js';
import { BENCHMARK_MODEL_BASE64 } from '../../../assets/benchmark_model.js';

const visible = ref(false);
const step = ref(1);
const skipLabel = '跳过引导';

// Benchmark state
const benchLoading = ref(true);
const benchStatus = ref('正在加载 ONNX Runtime...');
const benchResults = ref([]);

onMounted(() => {
  const done = localStorage.getItem('sxseditor.onboarding.completed');
  if (!done) {
    visible.value = true;
  }
});

async function runBenchmark() {
  benchLoading.value = true;
  benchStatus.value = '正在加载 ONNX Runtime...';
  benchResults.value = [];

  const results = [];

  // Decode base64 model to Uint8Array
  const binaryString = atob(BENCHMARK_MODEL_BASE64);
  const modelBytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    modelBytes[i] = binaryString.charCodeAt(i);
  }

  // Test data: [1, 64, 64] float32
  const inputSize = 64 * 64;
  const inputData = new Float32Array(inputSize);
  for (let i = 0; i < inputSize; i++) {
    inputData[i] = Math.random();
  }
  const inputTensor = { input: inputData };

  const WARMUP_ITERS = 10;
  const BENCH_ITERS = 50;

  // --- CPU benchmark ---
  try {
    benchStatus.value = '正在测试 CPU 算力...';
    const ort = await import('onnxruntime-web');
    const session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });

    // Warmup
    for (let i = 0; i < WARMUP_ITERS; i++) {
      await session.run(inputTensor);
    }

    // Benchmark
    const t0 = performance.now();
    for (let i = 0; i < BENCH_ITERS; i++) {
      await session.run(inputTensor);
    }
    const t1 = performance.now();
    const avgMs = (t1 - t0) / BENCH_ITERS;

    results.push({
      ep: 'cpu',
      label: 'CPU',
      icon: '\u{2699}\u{FE0F}',
      available: true,
      avgMs,
      device: getCPUName(),
      speedLabel: getSpeedLabel(avgMs),
      speedClass: getSpeedClass(avgMs),
    });
    session.release();
  } catch (err) {
    console.warn('[benchmark] CPU test failed:', err);
    results.push({
      ep: 'cpu',
      label: 'CPU',
      icon: '\u{2699}\u{FE0F}',
      available: false,
      avgMs: 0,
      device: '',
      speedLabel: '',
      speedClass: '',
    });
  }

  // --- NNAPI (NPU) benchmark (Android-specific) ---
  try {
    benchStatus.value = '正在测试 NPU (NNAPI) 算力...';
    const ort = await import('onnxruntime-web');
    const session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: ['nnapi'],
      graphOptimizationLevel: 'all',
    });

    for (let i = 0; i < WARMUP_ITERS; i++) {
      await session.run(inputTensor);
    }
    const t0 = performance.now();
    for (let i = 0; i < BENCH_ITERS; i++) {
      await session.run(inputTensor);
    }
    const t1 = performance.now();
    const avgMs = (t1 - t0) / BENCH_ITERS;

    results.push({
      ep: 'nnapi',
      label: 'NPU (NNAPI)',
      icon: '\u{1F9EE}',
      available: true,
      avgMs,
      device: 'NPU (NNAPI 加速)',
      speedLabel: getSpeedLabel(avgMs),
      speedClass: getSpeedClass(avgMs),
    });
    session.release();
  } catch (err) {
    console.info('[benchmark] NNAPI not available:', err.message);
    results.push({
      ep: 'nnapi',
      label: 'NPU (NNAPI)',
      icon: '\u{1F9EE}',
      available: false,
      avgMs: 0,
      device: '',
      speedLabel: '',
      speedClass: '',
    });
  }

  // --- GPU (WebGL) benchmark ---
  try {
    benchStatus.value = '正在测试 GPU 算力...';
    const ort = await import('onnxruntime-web');
    const session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: ['webgl'],
      graphOptimizationLevel: 'all',
    });

    for (let i = 0; i < WARMUP_ITERS; i++) {
      await session.run(inputTensor);
    }
    const t0 = performance.now();
    for (let i = 0; i < BENCH_ITERS; i++) {
      await session.run(inputTensor);
    }
    const t1 = performance.now();
    const avgMs = (t1 - t0) / BENCH_ITERS;

    results.push({
      ep: 'webgl',
      label: 'GPU (WebGL)',
      icon: '\u{1F3AE}',
      available: true,
      avgMs,
      device: getGPUName(),
      speedLabel: getSpeedLabel(avgMs),
      speedClass: getSpeedClass(avgMs),
    });
    session.release();
  } catch (err) {
    console.info('[benchmark] WebGL not available:', err.message);
    results.push({
      ep: 'webgl',
      label: 'GPU (WebGL)',
      icon: '\u{1F3AE}',
      available: false,
      avgMs: 0,
      device: '',
      speedLabel: '',
      speedClass: '',
    });
  }

  benchResults.value = results;
  benchLoading.value = false;
}

function getCPUName() {
  const ua = navigator.userAgent || '';
  // Try to extract CPU info from UserAgent
  const match = ua.match(/(?:Intel|AMD|Apple|Snapdragon|Exynos|Kirin|Dimensity|Tensor)[^;) ]*/i);
  if (match) return match[0];
  // Fallback: hardwareConcurrency
  return `${navigator.hardwareConcurrency || '?'} 核 CPU`;
}

function getGPUName() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  if (gl) {
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugInfo) {
      const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
      if (renderer) return renderer;
    }
  }
  return 'WebGL GPU';
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

function complete() {
  localStorage.setItem('sxseditor.onboarding.completed', '1');
  visible.value = false;
}

async function goToModelDownload() {
  complete();
  spa.navigate('model-download');
}

// Watch for step changes to trigger benchmark
import { watch } from 'vue';
watch(step, (newStep) => {
  if (newStep === 2 && benchLoading.value && benchResults.value.length === 0) {
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
