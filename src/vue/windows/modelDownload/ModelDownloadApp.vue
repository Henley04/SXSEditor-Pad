<!--
  ModelDownloadApp.vue — Vue 3 + Pinia replacement for the vanilla-JS
  src/modelDownload.js bootstrap.

  The template fully replaces the static body of src/modelDownload.html.
  All IPC event routing, precision selection, version select, download /
  cancel / close, overall progress, file list rendering, optional JP /
  SiFiGAN model cards (download / unload / update / progress), error
  display, dir info + change dir, and the overview status cards live here
  (state + actions in store.js, lifecycle + listeners in this component).
-->
<template>
  <div>
    <div class="header">
      <h1>{{ $t('modelDownload.title') }}</h1>
      <p id="statusText">
        <span v-if="store.statusSpinner" class="spinner"></span>{{ store.statusText || $t('modelDownload.detecting') }}
      </p>
    </div>

    <!-- ==================== Overview ==================== -->
    <div v-if="store.overviewSectionVisible" class="overview-section">
      <div class="overview-card">
        <span class="overview-dot" :class="store.mainDotState"></span>
        <span class="overview-label">{{ $t('modelDownload.mainModel') }}</span>
        <span class="overview-status">{{ store.overviewMainText }}</span>
      </div>
      <div class="overview-card">
        <span class="overview-dot" :class="store.jpDotState"></span>
        <span class="overview-label">{{ $t('modelDownload.jpModel') }}</span>
        <span class="overview-status">{{ store.overviewJpText }}</span>
      </div>
      <div class="overview-card">
        <span class="overview-dot" :class="store.sifiganDotState"></span>
        <span class="overview-label">{{ $t('modelDownload.sifiganModel') }}</span>
        <span class="overview-status">{{ store.overviewSifiganText }}</span>
      </div>
    </div>

    <!-- ==================== Dir info ==================== -->
    <div v-if="store.dirInfoVisible" class="dir-info">
      <span class="dir-label">{{ $t('modelDownload.downloadLocation') }}</span>
      <span class="dir-path">{{ store.dirPath }}</span>
      <button
        class="btn-change-dir"
        :disabled="store.changeDirDisabled"
        @click="store.changeDir"
      >{{ $t('modelDownload.change') }}</button>
    </div>

    <!-- ==================== Main model ==================== -->
    <div class="model-group-section">
      <div class="group-header">
        <h2 class="group-title">
          <span>{{ $t('modelDownload.mainModel') }}</span>
          <span class="group-badge group-badge-main">{{ $t('modelDownload.required') }}</span>
        </h2>
      </div>

      <!-- Precision selection -->
      <div v-if="store.precisionSectionVisible" class="precision-section">
        <label class="precision-label">{{ $t('modelDownload.precisionLabel') }}</label>
        <div class="precision-options">
          <label
            v-for="opt in precisionOptions"
            :key="opt.value"
            class="precision-option"
          >
            <input
              type="radio"
              name="modelPrecision"
              :value="opt.value"
              :checked="store.currentPrecision === opt.value"
              @change="onPrecisionChange"
            >
            <span class="precision-radio"></span>
            <span class="precision-text">
              <span class="precision-name">{{ $t(opt.nameKey) }}</span>
              <span class="precision-desc">{{ $t(opt.descKey) }}</span>
            </span>
          </label>
        </div>
      </div>

      <!-- Version info -->
      <div v-if="store.versionInfoSectionVisible" class="version-info-section">
        <div class="version-info-row">
          <span class="version-label">{{ $t('modelDownload.currentVersion') }}</span>
          <span class="version-value">{{ store.localVersionText }}</span>
        </div>
        <div class="version-info-row">
          <span class="version-label">{{ $t('modelDownload.latestVersion') }}</span>
          <span class="version-value">{{ store.latestVersionText }}</span>
        </div>
        <div class="version-select-row">
          <span class="version-label">{{ $t('modelDownload.selectVersion') }}</span>
          <select
            class="version-select"
            :value="store.selectedRevision"
            :disabled="store.versionSelectDisabled"
            @change="onVersionSelectChange"
          >
            <option
              v-for="opt in store.versionOptions"
              :key="opt.value"
              :value="opt.value"
            >{{ opt.label }}</option>
          </select>
        </div>
        <div v-if="store.versionUpdateBannerVisible" class="version-update-banner">
          <span class="update-icon" aria-hidden="true">&#9888;</span>
          <span class="update-text">{{ store.versionUpdateText }}</span>
          <button class="btn btn-update" @click="store.updateModel">{{ $t('modelDownload.update') }}</button>
        </div>
        <a
          href="#"
          class="model-updates-link"
          @click.prevent="store.openModelUpdatesLink"
        >{{ $t('modelDownload.viewVersionDetails') }}</a>
      </div>

      <!-- Overall progress -->
      <div v-if="store.progressSectionVisible" class="overall-progress">
        <div class="label">
          <span>{{ $t('modelDownload.overallProgress') }}</span>
          <span>{{ store.overallPercent }}%</span>
        </div>
        <div
          class="progress-bar-bg"
          role="progressbar"
          :aria-valuenow="store.overallPercent"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <div class="progress-bar-fill" :style="{ width: store.overallBarWidth }"></div>
        </div>
      </div>

      <div v-if="store.progressSectionVisible" class="speed-info">{{ store.speedInfo }}</div>

      <!-- File list -->
      <div v-if="store.missingFiles.length > 0" class="file-list">
        <div
          v-for="file in store.missingFiles"
          :key="file.filePath"
          class="file-item"
          :class="{ downloading: getFileState(file.filePath).status === 'downloading' }"
        >
          <!-- pending icon: circle -->
          <svg
            v-if="getFileState(file.filePath).status === 'pending'"
            class="file-icon pending"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          ><circle cx="12" cy="12" r="10"></circle></svg>
          <!-- downloading icon: spinner arc -->
          <svg
            v-else-if="getFileState(file.filePath).status === 'downloading'"
            class="file-icon downloading"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          ><path d="M21 12a9 9 0 11-6.219-8.56"></path></svg>
          <!-- complete icon: checkmark in circle -->
          <svg
            v-else-if="getFileState(file.filePath).status === 'complete'"
            class="file-icon complete"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          ><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
          <!-- error icon: X in circle -->
          <svg
            v-else-if="getFileState(file.filePath).status === 'error'"
            class="file-icon error"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          ><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>

          <span class="file-name" :title="file.filePath">{{ file.filePath }}</span>
          <span class="file-status" :class="getFileState(file.filePath).status">{{ getFileStatusText(file.filePath) }}</span>
        </div>
      </div>
    </div>

    <div v-if="store.errorVisible" class="error-message" style="display:block;">{{ store.errorMessage }}</div>

    <!-- ==================== Optional models ==================== -->
    <div class="optional-models-section">
      <div class="section-divider">
        <span class="divider-text">{{ $t('modelDownload.optionalModelsDivider') }}</span>
      </div>

      <!-- JP card -->
      <div class="model-card jp-card" data-group-id="jp-lora">
        <div class="model-card-header">
          <div class="model-card-title">
            <span class="model-card-name">{{ $t('modelDownload.jpTitle') }}</span>
            <span class="model-card-badge optional">{{ $t('modelDownload.optionalBadge') }}</span>
          </div>
          <div class="model-card-actions">
            <button
              v-if="store.jpDownloadBtnVisible"
              class="btn-card btn-download"
              :disabled="store.jpDownloadBtnDisabled"
              @click="store.downloadJp"
            >{{ $t('modelDownload.download') }}</button>
            <button
              v-if="store.jpUnloadBtnVisible"
              class="btn-card btn-unload"
              :disabled="store.jpUnloadBtnDisabled"
              @click="store.unloadJp"
            >{{ $t('modelDownload.unload') }}</button>
          </div>
        </div>
        <p class="model-card-desc">{{ $t('modelDownload.jpDesc') }}</p>

        <div class="model-card-status">
          <span class="status-indicator" :class="jpIndicatorClass"></span>
          <span class="status-text">{{ store.jpStatusText }}</span>
          <span v-if="store.jpVersionText" class="status-version">{{ store.jpVersionText }}</span>
          <button
            v-if="store.jpUpdateBtnVisible"
            class="btn-card btn-update-optional"
            @click="store.updateJp"
          >{{ $t('modelDownload.update') }}</button>
        </div>

        <div v-if="store.jpTooltipVisible" class="model-card-tooltip" role="tooltip">{{ store.jpTooltip }}</div>

        <div v-if="store.jpProgressVisible" class="model-card-progress">
          <div class="progress-bar-bg" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">
            <div class="progress-bar-fill" style="width:0%"></div>
          </div>
        </div>
      </div>

      <!-- SiFiGAN card -->
      <div class="model-card sifigan-card" data-group-id="sifigan-vocoder">
        <div class="model-card-header">
          <div class="model-card-title">
            <span class="model-card-name">{{ $t('modelDownload.sifiganTitle') }}</span>
            <span class="model-card-badge optional">{{ $t('modelDownload.optionalBadge') }}</span>
          </div>
          <div class="model-card-actions">
            <button
              v-if="store.sifiganDownloadBtnVisible"
              class="btn-card btn-download"
              :disabled="store.sifiganDownloadBtnDisabled"
              @click="store.downloadSifigan"
            >{{ $t('modelDownload.download') }}</button>
            <button
              v-if="store.sifiganUnloadBtnVisible"
              class="btn-card btn-unload"
              :disabled="store.sifiganUnloadBtnDisabled"
              @click="store.unloadSifigan"
            >{{ $t('modelDownload.unload') }}</button>
          </div>
        </div>
        <p class="model-card-desc">{{ $t('modelDownload.sifiganDesc') }}</p>

        <div class="model-card-files">
          <div class="model-card-file">
            <span class="model-card-file-name">sifigan_vocoder_dml.onnx</span>
            <span class="model-card-file-size">~611 MB</span>
          </div>
          <div class="model-card-file">
            <span class="model-card-file-name">sifigan_stats.joblib</span>
            <span class="model-card-file-size">~2.5 KB</span>
          </div>
        </div>

        <div class="model-card-status">
          <span class="status-indicator" :class="sifiganIndicatorClass"></span>
          <span class="status-text">{{ store.sifiganStatusText }}</span>
          <span v-if="store.sifiganVersionText" class="status-version">{{ store.sifiganVersionText }}</span>
          <button
            v-if="store.sifiganUpdateBtnVisible"
            class="btn-card btn-update-sifigan"
            @click="store.updateSifigan"
          >{{ $t('modelDownload.update') }}</button>
        </div>

        <div v-if="store.sifiganTooltipVisible" class="model-card-tooltip" role="tooltip">{{ store.sifiganTooltip }}</div>

        <div v-if="store.sifiganProgressVisible" class="model-card-progress">
          <div class="progress-bar-bg" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">
            <div class="progress-bar-fill" style="width:0%"></div>
          </div>
        </div>
      </div>
    </div>

    <div class="actions">
      <button
        v-if="store.startBtnVisible"
        class="btn btn-start"
        @click="store.startDownload"
      >{{ $t('modelDownload.startDownload') }}</button>
      <button
        v-if="store.cancelBtnVisible"
        class="btn btn-cancel"
        @click="store.cancelDownload"
      >{{ $t('modelDownload.cancelDownload') }}</button>
      <button
        v-if="store.closeBtnVisible"
        class="btn btn-close"
        @click="store.closeWindow"
      >{{ $t('modelDownload.close') }}</button>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted } from 'vue';
import { useModelDownloadStore } from './store.js';
import { t, getLocale } from '../../../i18n/index.js';
import { formatBytes } from '../../../utils/formatBytes.js';
import { initWindowTheme } from '../../../themes/themeInit.js';

// Pull in the CSS the vanilla-JS bootstrap imported so the existing
// .header / .overview-section / .precision-section / .file-list / .model-card
// styles still apply.
import '../../../common.css';
import '../../../modelDownload.css';

const store = useModelDownloadStore();

// ==================== Precision options (static) ====================
// The four precision radio options. Kept as a static array so the template
// can render them via v-for while still using :checked binding for the
// current precision.
const precisionOptions = [
  { value: 'fp32', nameKey: 'modelDownload.precisionFp32', descKey: 'modelDownload.precisionFp32Desc' },
  { value: 'fp16', nameKey: 'modelDownload.precisionFp16', descKey: 'modelDownload.precisionFp16Desc' },
  { value: 'int8', nameKey: 'modelDownload.precisionInt8', descKey: 'modelDownload.precisionInt8Desc' },
  { value: 'int8-npu', nameKey: 'modelDownload.precisionInt8Npu', descKey: 'modelDownload.precisionInt8NpuDesc' },
];

// ==================== Computed indicator classes ====================

// JP status → indicator class. The 'installed' / 'not_downloaded' / 'checking'
// / 'downloading' statuses map directly to CSS classes. The original code
// used the same status string as the className suffix.
const jpIndicatorClass = computed(() => {
  switch (store.jpStatus) {
    case 'installed': return 'installed';
    case 'not_downloaded': return 'not_downloaded';
    case 'downloading': return 'downloading';
    case 'checking':
    default: return 'checking';
  }
});

// SiFiGAN status → indicator class. 'download_url_not_configured' maps to the
// 'warning' indicator class (matches renderSifiganCard's setSifiganStatusIndicator
// call in that case).
const sifiganIndicatorClass = computed(() => {
  switch (store.sifiganStatus) {
    case 'installed': return 'installed';
    case 'not_downloaded': return 'not_downloaded';
    case 'download_url_not_configured': return 'warning';
    case 'downloading': return 'downloading';
    case 'checking':
    default: return 'checking';
  }
});

// ==================== File-list helpers ====================

function getFileState(filePath) {
  return (
    store.fileStates[filePath] || {
      status: 'pending',
      progress: 0,
      downloaded: 0,
      total: 0,
    }
  );
}

// Mirrors getStatusText() in the original bootstrap.
function getFileStatusText(filePath) {
  const state = getFileState(filePath);
  if (state.status === 'pending') {
    return t('modelDownload.pending');
  } else if (state.status === 'downloading') {
    let pct = 0;
    if (state.total > 0) {
      pct = Math.min(Math.max(Math.round((state.downloaded / state.total) * 100), 0), 100);
    }
    return `${pct}% (${formatBytes(state.downloaded)}/${formatBytes(state.total)})`;
  } else if (state.status === 'complete') {
    return `${t('modelDownload.complete')} (${formatBytes(state.total)})`;
  } else if (state.status === 'error') {
    return t('modelDownload.failed');
  }
  return '';
}

// ==================== Change handlers ====================

function onPrecisionChange(e) {
  store.setPrecision(e.target.value);
}

function onVersionSelectChange(e) {
  store.setRevision(e.target.value);
}

// ==================== IPC event listeners ====================
// Registered in onMounted, cleaned up in onUnmounted. Each listener forwards
// its payload to the corresponding store action (which preserves the original
// routing rules — e.g. skipping main-model UI updates while an optional model
// is downloading).
const cleanups = [];

onMounted(async () => {
  initWindowTheme(cleanups);
  document.documentElement.lang = getLocale();

  // Apply safe-area insets for Android status bar (shared utility).
  try {
    const { applySafeAreaInsets } = await import('../../../utils/safeArea.js');
    cleanups.push(applySafeAreaInsets());
  } catch (_) { /* non-fatal */ }

  cleanups.push(window.electronAPI.onModelDownloadMissingFiles((files) => store.handleMissingFiles(files)));
  cleanups.push(window.electronAPI.onModelDownloadPrecision((precision) => store.handlePrecision(precision)));
  cleanups.push(window.electronAPI.onModelDownloadRevision((revision) => store.handleRevision(revision)));
  cleanups.push(window.electronAPI.onModelDownloadProgress((data) => store.handleProgress(data)));
  cleanups.push(window.electronAPI.onModelDownloadFileStart((data) => store.handleFileStart(data)));
  cleanups.push(window.electronAPI.onModelDownloadFileComplete((data) => store.handleFileComplete(data)));
  cleanups.push(window.electronAPI.onModelDownloadComplete(() => store.handleComplete()));
  cleanups.push(window.electronAPI.onModelDownloadError((data) => store.handleError(data)));

  // Run the post-i18n init sequence (i18n was already initialized by the
  // entry point before mounting).
  store.init();
});

onUnmounted(() => {
  for (const cleanup of cleanups) {
    try { cleanup(); } catch (_) { /* noop */ }
  }
  cleanups.length = 0;
});
</script>

<style scoped>
/* All window styles for Model Download are imported globally from
   src/common.css + src/modelDownload.css (see <script setup> imports), so
   the existing class names reused in the template above apply unchanged.
   This block is intentionally left for component-scoped additions if needed. */
</style>
