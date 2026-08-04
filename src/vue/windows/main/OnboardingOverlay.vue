<!--
  OnboardingOverlay.vue — first-launch onboarding guide.

  Shows a 3-step modal on first launch:
  1. Welcome / app intro
  2. Hardware check (what acceleration is available on this device)
  3. Model download prompt (navigate to model download page)

  Visibility is controlled by a localStorage flag ('sxseditor.onboarding.completed').
  The overlay is rendered inside MainWindowApp via Teleport so it appears above
  all other content.
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
        <div class="onboarding-icon">{{ '\u{1F3B5}' }}</div>
        <h2 class="onboarding-title">欢迎使用 SXSEditor</h2>
        <p class="onboarding-desc">
          AI 歌声合成工作站，支持 MIDI/F0 编辑、歌手管理和音频导出。<br>
          本应用需要下载 AI 模型后才能使用。
        </p>
      </div>

      <!-- Step 2: Hardware check -->
      <div v-if="step === 2" class="onboarding-step">
        <div class="onboarding-icon">{{ '\u{1F50D}' }}</div>
        <h2 class="onboarding-title">硬件检测</h2>
        <div class="onboarding-hardware">
          <div class="hw-row">
            <span class="hw-label">设备类型</span>
            <span class="hw-value">{{ isMobile ? '移动设备' : '桌面设备' }}</span>
          </div>
          <div class="hw-row">
            <span class="hw-label">推理后端</span>
            <span class="hw-value">{{ hardwareInfo.backend || '检测中...' }}</span>
          </div>
          <div class="hw-row">
            <span class="hw-label">加速器</span>
            <span class="hw-value">{{ hardwareInfo.accelerator || 'CPU' }}</span>
          </div>
          <div class="hw-row">
            <span class="hw-label">推荐精度</span>
            <span class="hw-value">{{ isMobile ? 'INT8（速度快）' : 'INT8-NPU（最佳）' }}</span>
          </div>
        </div>
        <p class="onboarding-hint">{{ hardwareInfo.message || '点击下一步继续' }}</p>
      </div>

      <!-- Step 3: Model download prompt -->
      <div v-if="step === 3" class="onboarding-step">
        <div class="onboarding-icon">{{ '\u{1F4E6}' }}</div>
        <h2 class="onboarding-title">下载模型</h2>
        <p class="onboarding-desc">
          应用需要下载 AI 模型文件（约 300-800MB，取决于精度）。<br>
          模型来源为 ModelScope，请确保网络连接正常。
        </p>
        <div class="onboarding-actions">
          <button class="onboarding-btn-primary" @click="goToModelDownload">
            前往模型下载
          </button>
          <button class="onboarding-btn-secondary" @click="skip">
            稍后下载
          </button>
        </div>
      </div>

      <!-- Navigation buttons (steps 1-2) -->
      <div v-if="step < 3" class="onboarding-nav">
        <button class="onboarding-btn-secondary" @click="skip">跳过</button>
        <button class="onboarding-btn-primary" @click="next">下一步</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';

const STORAGE_KEY = 'sxseditor.onboarding.completed';
const visible = ref(false);
const step = ref(1);
const isMobile = ref(false);
const hardwareInfo = ref({});

onMounted(async () => {
  isMobile.value = /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(navigator.userAgent || '');

  // Check if onboarding has been completed
  try {
    const done = localStorage.getItem(STORAGE_KEY);
    if (done === '1') return;
  } catch (_) {
    // localStorage might be unavailable
  }

  visible.value = true;

  // Detect hardware capabilities
  try {
    if (window.electronAPI && typeof window.electronAPI.settingsGetCurrentHardware === 'function') {
      const hw = await window.electronAPI.settingsGetCurrentHardware();
      if (hw) {
        hardwareInfo.value = {
          backend: hw.provider || hw.backend || 'ONNX Runtime',
          accelerator: hw.accelerator || hw.device || (isMobile.value ? 'NNAPI/CPU' : 'CPU'),
          message: hw.message || '',
        };
      }
    }
  } catch (_) {
    // Hardware detection failed — use defaults
  }

  // Fallback hardware info
  if (!hardwareInfo.value.backend) {
    hardwareInfo.value = {
      backend: 'ONNX Runtime Mobile',
      accelerator: isMobile.value ? 'NNAPI / CPU' : 'CPU',
      message: isMobile.value
        ? '移动设备使用 NNAPI 加速，推荐 INT8 精度以获得最佳性能。'
        : '推荐使用 INT8-NPU 精度获得最佳效果。',
    };
  }
});

function next() {
  if (step.value < 3) {
    step.value++;
  }
}

function skip() {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch (_) { /* noop */ }
  visible.value = false;
}

function goToModelDownload() {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch (_) { /* noop */ }
  visible.value = false;
  // Navigate to model download page
  if (window.electronAPI && window.electronAPI.spa) {
    window.electronAPI.spa.navigate('model-download');
  }
}
</script>

<style scoped>
.onboarding-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10001;
  animation: onboarding-fade-in 0.3s ease;
}

@keyframes onboarding-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

.onboarding-dialog {
  background: var(--bg-panel, #1a1a2e);
  border: 1px solid var(--border-default, #333346);
  border-radius: 16px;
  width: 90%;
  max-width: 480px;
  padding: 32px 28px 24px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
  text-align: center;
  color: var(--fg-primary, #e0e0e0);
}

.onboarding-progress {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-bottom: 24px;
}

.onboarding-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--border-strong, #444);
  transition: all 0.3s ease;
}

.onboarding-dot.active {
  background: var(--accent, #5b8def);
  width: 24px;
  border-radius: 4px;
}

.onboarding-dot.done {
  background: var(--accent, #5b8def);
}

.onboarding-step {
  min-height: 200px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  gap: 16px;
}

.onboarding-icon {
  font-size: 48px;
  line-height: 1;
}

.onboarding-title {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
  color: var(--fg-primary, #e0e0e0);
}

.onboarding-desc {
  font-size: 14px;
  line-height: 1.6;
  color: var(--fg-secondary, #a0a0b0);
  margin: 0;
  max-width: 380px;
}

.onboarding-hint {
  font-size: 12px;
  color: var(--fg-muted, #666680);
  margin: 8px 0 0;
}

.onboarding-hardware {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 8px 0;
}

.hw-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: var(--bg-elevated, #16162a);
  border-radius: 8px;
  border: 1px solid var(--border-subtle, #2a2a3e);
}

.hw-label {
  font-size: 13px;
  color: var(--fg-muted, #888);
}

.hw-value {
  font-size: 14px;
  font-weight: 500;
  color: var(--fg-primary, #e0e0e0);
}

.onboarding-actions,
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
