<!--
  ModelSection.vue — model management. Mirrors #section-model markup: model
  overview cards (main/JP/SiFiGAN), precision select + per-precision status
  list + precision info box, vocoder type select + hint, SiFiGAN precision
  (visible only when sifigan), Japanese vocalization radios, DML VRAM release
  options, and the open-model-download buttons.
-->
<template>
  <div class="settings-section">
    <!-- Model overview cards -->
    <div class="model-overview">
      <div class="model-overview-header">
        <span class="model-overview-title">{{ $t('settings.modelOverviewTitle') }}</span>
        <button class="btn-open-model-download" @click="store.openModelDownloadWindow">{{ $t('settings.openModelDownload') }}</button>
      </div>
      <div class="model-overview-cards">
        <div class="model-overview-card">
          <div class="model-overview-card-header">
            <span class="model-overview-dot" :class="store.model.overview.main.dotState"></span>
            <span class="model-overview-name">{{ $t('settings.modelOverviewMain') }}</span>
            <span class="model-overview-precision">{{ store.model.overviewMainPrecision }}</span>
          </div>
          <div class="model-overview-card-body">
            <span class="model-overview-status" :class="store.model.overview.main.statusClass">{{ store.model.overview.main.statusText }}</span>
            <span class="model-overview-version">{{ store.model.overview.main.versionText }}</span>
          </div>
        </div>
        <div class="model-overview-card">
          <div class="model-overview-card-header">
            <span class="model-overview-dot" :class="store.model.overview.jp.dotState"></span>
            <span class="model-overview-name">{{ $t('settings.modelOverviewJp') }}</span>
            <span class="model-overview-precision">{{ $t('settings.modelOverviewJpPrecision') }}</span>
          </div>
          <div class="model-overview-card-body">
            <span class="model-overview-status" :class="store.model.overview.jp.statusClass">{{ store.model.overview.jp.statusText }}</span>
            <span class="model-overview-version">{{ store.model.overview.jp.versionText }}</span>
          </div>
        </div>
        <div class="model-overview-card">
          <div class="model-overview-card-header">
            <span class="model-overview-dot" :class="store.model.overview.sifigan.dotState"></span>
            <span class="model-overview-name">{{ $t('settings.modelOverviewSifigan') }}</span>
            <span class="model-overview-precision">{{ $t('settings.modelOverviewOptional') }}</span>
          </div>
          <div class="model-overview-card-body">
            <span class="model-overview-status" :class="store.model.overview.sifigan.statusClass">{{ store.model.overview.sifigan.statusText }}</span>
            <span class="model-overview-version">{{ store.model.overview.sifigan.versionText }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="setting-group">
      <label for="modelPrecision">{{ $t('settings.modelPrecision') }}</label>
      <select id="modelPrecision" :value="store.model.precision" @change="store.setModelPrecision($event.target.value)">
        <option value="fp32">{{ $t('settings.precisionFp32') }}</option>
        <option value="fp16">{{ $t('settings.precisionFp16') }}</option>
        <option value="int8">{{ $t('settings.precisionInt8') }}</option>
        <option value="int8-npu">{{ $t('settings.precisionInt8Npu') }}</option>
      </select>
      <p class="hint">{{ $t('settings.modelPrecisionHint') }}</p>
      <div class="model-status-list">
        <div v-for="item in store.model.modelStatusList" :key="item.prec" class="model-status-item">
          <span class="model-status-dot" :class="item.ready ? 'ready' : 'missing'"></span>
          <span class="model-status-label">{{ item.label }}</span>
          <span class="model-status-info">{{ item.info }}</span>
        </div>
      </div>
      <div class="precision-info-box">
        <strong>{{ $t('settings.precisionInfoTitle') }}</strong>
        <ul>
          <li>{{ $t('settings.precisionInfoFp32') }}</li>
          <li>{{ $t('settings.precisionInfoFp16') }}</li>
          <li>{{ $t('settings.precisionInfoInt8') }}</li>
          <li>{{ $t('settings.precisionInfoInt8Npu') }}</li>
          <li>{{ $t('settings.precisionInfoRecommend') }}</li>
        </ul>
      </div>
    </div>

    <div class="setting-group">
      <label for="vocoderType">{{ $t('settings.vocoderType') }}</label>
      <select id="vocoderType" :value="store.model.vocoderType" @change="store.setVocoderType($event.target.value)">
        <option value="default">{{ $t('settings.vocoderTypeDefault') }}</option>
        <option value="sifigan" :disabled="store.sifiganOptionDisabled">{{ store.sifiganOptionLabel }}</option>
      </select>
      <p class="hint">{{ store.model.vocoderTypeHint || $t('settings.vocoderTypeHint') }}</p>
    </div>

    <div v-show="store.sifiganPrecisionVisible" class="setting-group">
      <label for="sifiganPrecision">{{ $t('settings.sifiganPrecision') }}</label>
      <select id="sifiganPrecision" :value="store.model.sifiganPrecision" @change="store.setSifiganPrecision($event.target.value)">
        <option value="fp32">{{ $t('settings.sifiganPrecisionFp32') }}</option>
        <option value="fp16">{{ $t('settings.sifiganPrecisionFp16') }}</option>
      </select>
      <p class="hint">{{ $t('settings.sifiganPrecisionHint') }}</p>
    </div>

    <div class="setting-group">
      <label>{{ $t('settings.japaneseVocalization') }}</label>
      <div class="radio-group">
        <label class="device-mode-radio">
          <input type="radio" name="japaneseVocalization" value="en-phonemes"
            :checked="store.model.japaneseVocalization === 'en-phonemes'"
            @change="store.setJapaneseVocalization('en-phonemes')">
          <span class="radio-label">{{ $t('settings.japaneseVocalizationEnPhonemes') }}</span>
        </label>
        <label class="device-mode-radio">
          <input type="radio" name="japaneseVocalization" value="hybrid"
            :checked="store.model.japaneseVocalization === 'hybrid'"
            @change="store.setJapaneseVocalization('hybrid')">
          <span class="radio-label">{{ $t('settings.japaneseVocalizationHybrid') }}</span>
        </label>
        <label class="device-mode-radio">
          <input type="radio" name="japaneseVocalization" value="jp-lora" disabled>
          <span class="radio-label">{{ $t('settings.japaneseVocalizationJpLora') }}</span>
        </label>
      </div>
      <p class="hint">{{ $t('settings.japaneseVocalizationHint') }}</p>
    </div>

    <!-- Desktop-only: DML VRAM release options (not applicable on mobile,
         where GPU memory is managed by the OS and there's no DirectML). -->
    <div class="setting-group" v-if="!isMobile">
      <label class="device-mode-radio">
        <input type="checkbox" :checked="store.model.releaseDmlVramAfterSynthesis"
          @change="store.setReleaseDmlVramAfterSynthesis($event.target.checked)">
        <span class="radio-label">{{ $t('settings.releaseDmlVramAfterSynthesis') }}</span>
        <span class="radio-desc">{{ $t('settings.releaseDmlVramAfterSynthesisDesc') }}</span>
      </label>
      <p class="hint">{{ $t('settings.releaseDmlVramAfterSynthesisHint') }}</p>
    </div>

    <div class="setting-group" v-if="!isMobile">
      <label class="device-mode-radio">
        <input type="checkbox" :checked="store.model.releaseDiffStepBeforeVocoder"
          @change="store.setReleaseDiffStepBeforeVocoder($event.target.checked)">
        <span class="radio-label">{{ $t('settings.releaseDiffStepBeforeVocoder') }}</span>
        <span class="radio-desc">{{ $t('settings.releaseDiffStepBeforeVocoderDesc') }}</span>
      </label>
      <p class="hint">{{ $t('settings.releaseDiffStepBeforeVocoderHint') }}</p>
    </div>

    <div class="setting-group">
      <button class="btn-open-model-download" @click="store.openModelDownloadWindow">{{ $t('settings.openModelDownload') }}</button>
      <p class="hint">{{ $t('settings.openModelDownloadHint') }}</p>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useSettingsStore } from './store.js';
const store = useSettingsStore();

const isMobile = computed(() => {
  const ua = navigator.userAgent || '';
  return /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(ua);
});
</script>
