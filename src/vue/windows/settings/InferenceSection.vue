<!--
  InferenceSection.vue — inference hardware settings. Mirrors
  #section-inference markup: provider select, current-hardware info, device
  mode radios (smart/manual/advanced), device select, WebNN/NPU/GPU status
  bar, and the advanced per-model-group device mapping.
-->
<template>
  <div class="settings-section">
    <div class="setting-group">
      <label for="inferenceProvider">{{ $t('settings.inferenceProvider') }}</label>
      <select id="inferenceProvider" :value="store.inference.provider" @change="store.setInferenceProvider($event.target.value)">
        <option value="ortnode">{{ $t('settings.inferenceProviderOrtnode') }}</option>
        <option value="ortweb">{{ $t('settings.inferenceProviderOrtweb') }}</option>
      </select>
      <p class="hint">{{ store.inferenceProviderHintText }}</p>
    </div>

    <div class="setting-group hardware-info">
      <label>{{ $t('settings.currentHardware') }}</label>
      <div class="info-box">
        <span>{{ store.inference.currentHardwareText || $t('settings.notInitialized') }}</span>
      </div>
    </div>

    <div class="setting-group">
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

    <div class="setting-group">
      <label for="inferenceDevice">{{ $t('settings.inferenceHardware') }}</label>
      <select id="inferenceDevice" :disabled="store.deviceSelectDisabled"
        :value="store.inference.preferredDeviceId" @change="store.setPreferredDeviceId($event.target.value)">
        <option v-for="opt in store.deviceOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
      <p class="hint">{{ $t('settings.inferenceHardwareHint') }}</p>
    </div>

    <div class="setting-group">
      <div class="webnn-status-bar">
        <span class="webnn-status-label">WebNN:</span>
        <span class="webnn-status-value" :class="statusClass(store.inference.webnnState)">{{ store.webnnStatusText }}</span>
        <span class="webnn-status-separator">|</span>
        <span class="webnn-status-label">NPU:</span>
        <span class="webnn-status-value" :class="statusClass(store.inference.npuState)">{{ store.npuStatusText }}</span>
        <span class="webnn-status-separator">|</span>
        <span class="webnn-status-label">GPU:</span>
        <span class="webnn-status-value" :class="statusClass(store.inference.gpuState)">{{ store.gpuStatusText }}</span>
      </div>
    </div>

    <div v-show="store.advancedSettingsVisible" class="setting-group">
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
import { useSettingsStore, MODEL_GROUPS } from './store.js';
const store = useSettingsStore();
const modelGroups = MODEL_GROUPS;

function statusClass(state) {
  if (state === 'available') return 'status-available';
  if (state === 'unavailable') return 'status-unavailable';
  return 'status-checking';
}
</script>
