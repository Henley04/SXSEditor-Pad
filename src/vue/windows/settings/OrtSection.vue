<!--
  OrtSection.vue — ONNX Runtime session options. Mirrors #section-ort markup.
  Includes the collapsed "advanced / high-risk" group (force-mem-pattern on
  DML, intra/inter op threads, log severity).
-->
<template>
  <div class="settings-section">
    <p class="section-desc">{{ $t('settings.ortSectionDesc') }}</p>
    <div class="info-box ort-default-info">
      <strong>{{ $t('settings.ortDefaultNote') }}</strong>
      <ul>
        <li>{{ $t('settings.ortDefaultNote1') }}</li>
        <li>{{ $t('settings.ortDefaultNote2') }}</li>
        <li>{{ $t('settings.ortDefaultNote3') }}</li>
      </ul>
    </div>

    <div class="setting-group">
      <label class="checkbox-label" for="ortEnableMemPattern">
        <input type="checkbox" id="ortEnableMemPattern" :checked="store.ort.enableMemPattern"
          @change="store.setOrtEnableMemPattern($event.target.checked)">
        <span>{{ $t('settings.ortEnableMemPattern') }}</span>
      </label>
      <p class="hint">{{ $t('settings.ortEnableMemPatternHint') }}</p>
    </div>

    <div class="setting-group">
      <label class="checkbox-label" for="ortEnableCpuMemArena">
        <input type="checkbox" id="ortEnableCpuMemArena" :checked="store.ort.enableCpuMemArena"
          @change="store.setOrtEnableCpuMemArena($event.target.checked)">
        <span>{{ $t('settings.ortEnableCpuMemArena') }}</span>
      </label>
      <p class="hint">{{ $t('settings.ortEnableCpuMemArenaHint') }}</p>
    </div>

    <div class="setting-group">
      <label for="ortGraphOptLevel">{{ $t('settings.ortGraphOptLevel') }}</label>
      <select id="ortGraphOptLevel" :value="store.ort.graphOptLevel" @change="store.setOrtGraphOptLevel($event.target.value)">
        <option value="disabled">{{ $t('settings.ortGraphOptDisabled') }}</option>
        <option value="basic">{{ $t('settings.ortGraphOptBasic') }}</option>
        <option value="extended">{{ $t('settings.ortGraphOptExtended') }}</option>
        <option value="all">{{ $t('settings.ortGraphOptAll') }}</option>
      </select>
      <p class="hint">{{ $t('settings.ortGraphOptLevelHint') }}</p>
    </div>

    <div class="setting-group">
      <label for="ortExecutionMode">{{ $t('settings.ortExecutionMode') }}</label>
      <select id="ortExecutionMode" :value="store.ort.executionMode" @change="store.setOrtExecutionMode($event.target.value)">
        <option value="sequential">{{ $t('settings.ortExecSequential') }}</option>
        <option value="parallel">{{ $t('settings.ortExecParallel') }}</option>
      </select>
      <p class="hint">{{ $t('settings.ortExecutionModeHint') }}</p>
    </div>

    <details class="ort-advanced-collapse">
      <summary>{{ $t('settings.ortAdvancedGroup') }}</summary>
      <div class="ort-advanced-content">
        <div class="info-box">
          <strong>{{ $t('settings.ortRiskWarning') }}</strong>
          <ul>
            <li>{{ $t('settings.ortRiskWarning1') }}</li>
            <li>{{ $t('settings.ortRiskWarning2') }}</li>
          </ul>
        </div>

        <div class="setting-group setting-risk">
          <label class="checkbox-label" for="ortForceMemPatternOnDml">
            <input type="checkbox" id="ortForceMemPatternOnDml" :checked="store.ort.forceMemPatternOnDml"
              @change="store.setOrtForceMemPatternOnDml($event.target.checked)">
            <span class="risk-badge">{{ $t('settings.riskBadge') }}</span>
            <span>{{ $t('settings.ortForceMemPatternOnDml') }}</span>
          </label>
          <p class="hint">{{ $t('settings.ortForceMemPatternOnDmlHint') }}</p>
        </div>

        <div class="setting-group setting-risk">
          <label for="ortIntraOpNumThreads">
            <span class="risk-badge">{{ $t('settings.riskBadge') }}</span>
            <span>{{ $t('settings.ortIntraOpNumThreads') }}</span>
            <span class="volume-display">{{ store.ort.intraOpNumThreads }}</span>
          </label>
          <input type="range" id="ortIntraOpNumThreads" min="0" max="64" step="1"
            :value="store.ort.intraOpNumThreads" @input="store.setOrtIntraOpNumThreads($event.target.value)">
          <p class="hint">{{ $t('settings.ortIntraOpNumThreadsHint') }}</p>
        </div>

        <div class="setting-group setting-risk">
          <label for="ortInterOpNumThreads">
            <span class="risk-badge">{{ $t('settings.riskBadge') }}</span>
            <span>{{ $t('settings.ortInterOpNumThreads') }}</span>
            <span class="volume-display">{{ store.ort.interOpNumThreads }}</span>
          </label>
          <input type="range" id="ortInterOpNumThreads" min="0" max="64" step="1"
            :value="store.ort.interOpNumThreads" @input="store.setOrtInterOpNumThreads($event.target.value)">
          <p class="hint">{{ $t('settings.ortInterOpNumThreadsHint') }}</p>
        </div>

        <div class="setting-group setting-risk">
          <label for="ortLogSeverityLevel">
            <span class="risk-badge">{{ $t('settings.riskBadge') }}</span>
            <span>{{ $t('settings.ortLogSeverityLevel') }}</span>
          </label>
          <select id="ortLogSeverityLevel" :value="store.ort.logSeverityLevel" @change="store.setOrtLogSeverityLevel($event.target.value)">
            <option value="verbose">{{ $t('settings.ortLogVerbose') }}</option>
            <option value="info">{{ $t('settings.ortLogInfo') }}</option>
            <option value="warning">{{ $t('settings.ortLogWarning') }}</option>
            <option value="error">{{ $t('settings.ortLogError') }}</option>
            <option value="fatal">{{ $t('settings.ortLogFatal') }}</option>
          </select>
          <p class="hint">{{ $t('settings.ortLogSeverityLevelHint') }}</p>
        </div>
      </div>
    </details>
  </div>
</template>

<script setup>
import { useSettingsStore } from './store.js';
const store = useSettingsStore();
</script>
