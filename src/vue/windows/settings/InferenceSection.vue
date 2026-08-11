<!--
  InferenceSection.vue — inference hardware settings.

  After the migration to Rust ORT as the sole inference backend, the settings
  panel now exposes a unified device preference selector (CPU/GPU/NPU/DSP/Auto)
  that works on both mobile and desktop. On mobile this is the primary hardware
  control, mapping directly to the Rust ORT engine's execution provider selection.

  Desktop-only sections (DirectML device enumeration, advanced per-model mapping)
  remain hidden on mobile via v-if="!isMobile".
-->
<template>
  <div class="settings-section">
    <!-- Inference backend info -->
    <div class="setting-group">
      <label>{{ $t('settings.inferenceBackend') }}</label>
      <div class="info-box">
        <span>Rust ORT (ONNX Runtime Mobile)</span>
      </div>
      <p class="hint">{{ isMobile
        ? 'Native ORT with NNAPI/CoreML acceleration. Select device preference below.'
        : 'Native ORT engine loaded dynamically. Use device preference to select acceleration target.' }}</p>
    </div>

    <!-- Device preference selector (works on all platforms) -->
    <div class="setting-group">
      <label for="devicePreference">{{ $t('settings.devicePreference') }}</label>
      <select id="devicePreference"
        :value="store.inference.devicePreference"
        @change="store.setDevicePreference($event.target.value)">
        <option value="auto">{{ $t('settings.devicePrefAuto') }}</option>
        <option value="cpu">{{ $t('settings.devicePrefCpu') }}</option>
        <option value="gpu" :disabled="store.inference.gpuState === 'unavailable'">{{ $t('settings.devicePrefGpu') }}</option>
        <option value="npu" :disabled="store.inference.npuState === 'unavailable'">{{ $t('settings.devicePrefNpu') }}</option>
        <option value="dsp" :disabled="store.inference.dspState === 'unavailable'">{{ $t('settings.devicePrefDsp') }}</option>
      </select>
      <p class="hint">{{ $t('settings.devicePreferenceHint') }}</p>
    </div>

    <!-- Hardware status bar (visible on all platforms) -->
    <div class="setting-group">
      <div class="webnn-status-bar">
        <span class="webnn-status-label">NPU:</span>
        <span class="webnn-status-value" :class="statusClass(store.inference.npuState)">{{ store.npuStatusText }}</span>
        <span class="webnn-status-separator">|</span>
        <span class="webnn-status-label">GPU:</span>
        <span class="webnn-status-value" :class="statusClass(store.inference.gpuState)">{{ store.gpuStatusText }}</span>
        <span class="webnn-status-separator">|</span>
        <span class="webnn-status-label">DSP:</span>
        <span class="webnn-status-value" :class="statusClass(store.inference.dspState)">{{ store.dspStatusText }}</span>
        <span class="webnn-status-separator">|</span>
        <span class="webnn-status-label">CPU:</span>
        <span class="webnn-status-value status-available">{{ $t('settings.cpuAvailable') }}</span>
      </div>
    </div>

    <!-- Current hardware info (visible on all platforms) -->
    <div class="setting-group hardware-info">
      <label>{{ $t('settings.currentHardware') }}</label>
      <div class="info-box">
        <span>{{ store.inference.currentHardwareText || $t('settings.notInitialized') }}</span>
      </div>
    </div>

    <!-- Desktop-only: device mode radios (smart/manual/advanced) -->
    <div class="setting-group" v-if="!isMobile">
      <label>{{ $t('settings.deviceMode') }}</label>
      <div class="device-mode-radios">
        <label class="device-mode-radio">
          <input type="radio" name="deviceMode" value="smart"
            :checked="store.inference.deviceMode === 'smart'"
            @change="store.setDeviceMode('smart')">
          <span class="radio-label">{{ $t('settings.smartMode') }}</span>
          <span class="radio-desc">{{ $t('settings.smartModeDesc') }}</span>
        </label>
        <label class="device-mode-radio">
          <input type="radio" name="deviceMode" value="manual"
            :checked="store.inference.deviceMode === 'manual'"
            @change="store.setDeviceMode('manual')">
          <span class="radio-label">{{ $t('settings.manualMode') }}</span>
          <span class="radio-desc">{{ $t('settings.manualModeDesc') }}</span>
        </label>
        <label class="device-mode-radio">
          <input type="radio" name="deviceMode" value="advanced"
            :checked="store.inference.deviceMode === 'advanced'"
            @change="store.setDeviceMode('advanced')">
          <span class="radio-label">{{ $t('settings.advancedMode') }}</span>
          <span class="radio-desc">{{ $t('settings.advancedModeDesc') }}</span>
        </label>
      </div>
    </div>

    <!-- Desktop-only: device select (DirectML/GPU device enumeration) -->
    <div class="setting-group" v-if="!isMobile">
      <label for="inferenceDevice">{{ $t('settings.inferenceHardware') }}</label>
      <select id="inferenceDevice" :disabled="store.deviceSelectDisabled"
        :value="store.inference.preferredDeviceId" @change="store.setPreferredDeviceId($event.target.value)">
        <option v-for="opt in store.deviceOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
      <p class="hint">{{ $t('settings.inferenceHardwareHint') }}</p>
    </div>

    <!-- Desktop-only: advanced per-model-group device mapping -->
    <div v-show="store.advancedSettingsVisible && !isMobile" class="setting-group">
      <label>{{ $t('settings.advancedHardwareSettings') }}</label>
      <p class="hint">{{ $t('settings.selectDeviceForModelGroup') }}</p>
      <div class="model-device-mapping">
        <div v-for="group in modelGroups" :key="group.id" class="model-mapping-row">
          <span class="model-mapping-label">{{ $t(group.labelKey) }}</span>
          <select class="model-mapping-select"
            :value="store.inference.modelDeviceMapping[group.id] || 'auto'"
            @change="store.setModelDeviceMapping(group.id, $event.target.value)">
            <option v-for="opt in store.deviceOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useSettingsStore, MODEL_GROUPS } from './store.js';
const store = useSettingsStore();
const modelGroups = MODEL_GROUPS;

const isMobile = computed(() => {
  const ua = navigator.userAgent || '';
  return /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(ua);
});

function statusClass(state) {
  if (state === 'available') return 'status-available';
  if (state === 'unavailable') return 'status-unavailable';
  return 'status-checking';
}
</script>
