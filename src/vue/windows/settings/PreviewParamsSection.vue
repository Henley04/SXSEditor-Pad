<!--
  PreviewParamsSection.vue — preview inference params (diffusion steps,
  sampler, CFG strength/rescale, diffStep chunked inference).
  Mirrors #section-preview-params markup. All values bind to the store;
  sliders use @input handlers that persist via applySettingsDebounced().
-->
<template>
  <div class="settings-section">
    <p class="section-desc">{{ $t('settings.previewInferenceParamsDesc') }}</p>

    <div class="setting-group">
      <label for="previewDiffSteps">
        <span>{{ $t('settings.diffSteps') }}</span>
        <span class="volume-display">{{ store.previewParams.diffSteps }}</span>
      </label>
      <input type="range" id="previewDiffSteps" min="4" max="64" step="4"
        :value="store.previewParams.diffSteps" @input="store.setPreviewDiffSteps($event.target.value)">
      <p class="hint">{{ $t('settings.previewDiffStepsHint') }}</p>
    </div>

    <div class="setting-group">
      <label for="previewSampler"><span>{{ $t('settings.sampler') }}</span></label>
      <select id="previewSampler" :value="store.previewParams.sampler" @change="store.setPreviewSampler($event.target.value)">
        <option value="euler">{{ $t('settings.samplerEuler') }}</option>
        <option value="heun">{{ $t('settings.samplerHeun') }}</option>
        <option value="extrap">{{ $t('settings.samplerExtrap') }}</option>
        <option value="stork2">{{ $t('settings.samplerStork2') }}</option>
      </select>
      <p class="hint">{{ $t('settings.samplerHint') }}</p>
    </div>

    <div class="setting-group">
      <label for="previewCfgStrength">
        <span>{{ $t('settings.cfgStrength') }}</span>
        <span class="volume-display">{{ Number(store.previewParams.cfgStrength).toFixed(1) }}</span>
      </label>
      <input type="range" id="previewCfgStrength" min="0" max="10" step="0.5"
        :value="store.previewParams.cfgStrength" @input="store.setPreviewCfgStrength($event.target.value)">
      <p class="hint">{{ $t('settings.cfgStrengthHint') }}</p>
    </div>

    <div class="setting-group">
      <label for="previewCfgRescale">
        <span>{{ $t('settings.cfgRescale') }}</span>
        <span class="volume-display">{{ Number(store.previewParams.cfgRescale).toFixed(2) }}</span>
      </label>
      <input type="range" id="previewCfgRescale" min="0" max="1" step="0.05"
        :value="store.previewParams.cfgRescale" @input="store.setPreviewCfgRescale($event.target.value)">
      <p class="hint">{{ $t('settings.cfgRescaleHint') }}</p>
    </div>

    <div class="setting-group">
      <label class="device-mode-radio">
        <input type="checkbox" :checked="store.previewParams.chunkEnabled"
          @change="store.setPreviewChunkEnabled($event.target.checked)">
        <span class="radio-label">{{ $t('settings.previewDiffStepChunkEnabled') }}</span>
        <span class="radio-desc">{{ $t('settings.previewDiffStepChunkEnabledDesc') }}</span>
      </label>
      <p class="hint">{{ $t('settings.previewDiffStepChunkHint') }}</p>
    </div>

    <div v-show="store.previewDiffStepChunkGroupVisible" class="setting-group">
      <div class="setting-group">
        <label for="previewDiffStepChunkFrames">
          <span>{{ $t('settings.previewDiffStepChunkFrames') }}</span>
          <span class="volume-display">{{ store.previewParams.chunkFrames }}</span>
        </label>
        <input type="range" id="previewDiffStepChunkFrames" min="100" max="2000" step="50"
          :value="store.previewParams.chunkFrames" @input="store.setPreviewChunkFrames($event.target.value)">
        <p class="hint">{{ $t('settings.previewDiffStepChunkFramesHint') }}</p>
      </div>
      <div class="setting-group">
        <label for="previewDiffStepOverlapFrames">
          <span>{{ $t('settings.previewDiffStepChunkOverlapFrames') }}</span>
          <span class="volume-display">{{ store.previewParams.chunkOverlapFrames }}</span>
        </label>
        <input type="range" id="previewDiffStepOverlapFrames" min="0" max="200" step="10"
          :value="store.previewParams.chunkOverlapFrames" @input="store.setPreviewChunkOverlapFrames($event.target.value)">
        <p class="hint">{{ $t('settings.previewDiffStepChunkOverlapFramesHint') }}</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useSettingsStore } from './store.js';
const store = useSettingsStore();
</script>
