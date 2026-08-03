<!--
  ExportParamsSection.vue — export inference params (diffusion steps, sampler,
  CFG strength/rescale). Mirrors #section-export-params markup.
-->
<template>
  <div class="settings-section">
    <p class="section-desc">{{ $t('settings.exportInferenceParamsDesc') }}</p>

    <div class="setting-group">
      <label for="exportDiffSteps">
        <span>{{ $t('settings.diffSteps') }}</span>
        <span class="volume-display">{{ store.exportParams.diffSteps }}</span>
      </label>
      <input type="range" id="exportDiffSteps" min="4" max="64" step="4"
        :value="store.exportParams.diffSteps" @input="store.setExportDiffSteps($event.target.value)">
      <p class="hint">{{ $t('settings.exportDiffStepsHint') }}</p>
    </div>

    <div class="setting-group">
      <label for="exportSampler"><span>{{ $t('settings.sampler') }}</span></label>
      <select id="exportSampler" :value="store.exportParams.sampler" @change="store.setExportSampler($event.target.value)">
        <option value="euler">{{ $t('settings.samplerEuler') }}</option>
        <option value="heun">{{ $t('settings.samplerHeun') }}</option>
        <option value="extrap">{{ $t('settings.samplerExtrap') }}</option>
        <option value="stork2">{{ $t('settings.samplerStork2') }}</option>
      </select>
      <p class="hint">{{ $t('settings.samplerHint') }}</p>
    </div>

    <div class="setting-group">
      <label for="exportCfgStrength">
        <span>{{ $t('settings.cfgStrength') }}</span>
        <span class="volume-display">{{ Number(store.exportParams.cfgStrength).toFixed(1) }}</span>
      </label>
      <input type="range" id="exportCfgStrength" min="0" max="10" step="0.5"
        :value="store.exportParams.cfgStrength" @input="store.setExportCfgStrength($event.target.value)">
      <p class="hint">{{ $t('settings.exportCfgStrengthHint') }}</p>
    </div>

    <div class="setting-group">
      <label for="exportCfgRescale">
        <span>{{ $t('settings.cfgRescale') }}</span>
        <span class="volume-display">{{ Number(store.exportParams.cfgRescale).toFixed(2) }}</span>
      </label>
      <input type="range" id="exportCfgRescale" min="0" max="1" step="0.05"
        :value="store.exportParams.cfgRescale" @input="store.setExportCfgRescale($event.target.value)">
      <p class="hint">{{ $t('settings.exportCfgRescaleHint') }}</p>
    </div>
  </div>
</template>

<script setup>
import { useSettingsStore } from './store.js';
const store = useSettingsStore();
</script>
