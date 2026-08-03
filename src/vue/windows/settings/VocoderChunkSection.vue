<!--
  VocoderChunkSection.vue — vocoder chunk size (smart/manual) + VRAM table.
  Mirrors #section-vocoder-chunk markup.
-->
<template>
  <div class="settings-section">
    <p class="section-desc">{{ $t('settings.vocoderChunkDesc') }}</p>

    <div class="setting-group">
      <label>{{ $t('settings.vocoderChunkMode') }}</label>
      <div class="device-mode-radios">
        <label class="device-mode-radio">
          <input type="radio" name="vocoderChunkMode" value="smart"
            :checked="store.vocoderChunk.mode === 'smart'"
            @change="store.setVocoderChunkMode('smart')">
          <span class="radio-label">{{ $t('settings.vocoderChunkSmart') }}</span>
          <span class="radio-desc">{{ $t('settings.vocoderChunkSmartDesc') }}</span>
        </label>
        <label class="device-mode-radio">
          <input type="radio" name="vocoderChunkMode" value="manual"
            :checked="store.vocoderChunk.mode === 'manual'"
            @change="store.setVocoderChunkMode('manual')">
          <span class="radio-label">{{ $t('settings.vocoderChunkManual') }}</span>
          <span class="radio-desc">{{ $t('settings.vocoderChunkManualDesc') }}</span>
        </label>
      </div>
    </div>

    <div v-show="store.vocoderChunkManualVisible" class="setting-group">
      <label for="vocoderChunkFrames">
        <span>{{ $t('settings.vocoderChunkFrames') }}</span>
        <span class="volume-display">{{ store.vocoderChunk.frames }}</span>
      </label>
      <input type="range" id="vocoderChunkFrames" min="256" max="2048" step="8"
        :value="store.vocoderChunk.frames" @input="store.setVocoderChunkFrames($event.target.value)">
      <p class="hint">{{ $t('settings.vocoderChunkFramesHint') }}</p>
    </div>

    <div v-show="store.vocoderChunkSmartInfoVisible" class="setting-group">
      <div class="info-box">
        <span>{{ store.vocoderChunk.smartInfoText || $t('settings.vocoderChunkSmartInfo') }}</span>
      </div>
    </div>

    <div class="setting-group">
      <label>{{ $t('settings.vocoderChunkTableTitle') }}</label>
      <p class="hint">{{ $t('settings.vocoderChunkTableHint') }}</p>
      <div class="vram-table-wrapper">
        <table class="vram-table">
          <thead>
            <tr>
              <th>{{ $t('settings.vocoderChunkTableVram') }}</th>
              <th>{{ $t('settings.vocoderChunkTableBudget') }}</th>
              <th>{{ $t('settings.vocoderChunkTableFrames') }}</th>
              <th>{{ $t('settings.vocoderChunkTableDuration') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="store.vocoderChunk.tableRows.length === 0">
              <td colspan="4">{{ store.vocoderChunk.tableLoading ? $t('settings.vocoderChunkTableLoading') : $t('settings.vocoderChunkTableEmpty') }}</td>
            </tr>
            <tr v-for="row in store.vocoderChunk.tableRows" :key="row.tierGb"
              :class="{ 'vram-row-current': row.isCurrent }">
              <td>
                {{ row.tierGb }}GB
                <span v-if="row.isCurrent" class="vram-current-badge">{{ $t('settings.vocoderChunkTableCurrent') }}</span>
              </td>
              <td>{{ row.budgetGb > 0 ? row.budgetGb.toFixed(2) + 'GB' : '—' }}</td>
              <td>{{ row.frames }}</td>
              <td>{{ row.approxSeconds.toFixed(1) }}s</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useSettingsStore } from './store.js';
const store = useSettingsStore();
</script>
