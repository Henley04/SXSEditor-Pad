/**
 * modelDownload Pinia store — reactive state for the Model Download window.
 *
 * Holds every piece of reactive state that the vanilla-JS bootstrap
 * (src/modelDownload.js) used to mutate imperatively via
 * document.getElementById / classList / textContent / style.display.
 * The Vue component reads computed views off this store and calls the
 * actions to mirror the original refreshVersionInfo() / refreshJpCard() /
 * refreshSifiganCard() / start download / cancel / update / unload flows.
 *
 * All IPC calls (window.electronAPI.modelDownload*) live here as actions.
 * The component registers the onModelDownload* event listeners in
 * onMounted and routes their payloads into the corresponding handle* actions.
 */
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { t } from '../../../i18n/index.js';
import { formatBytes } from '../../../utils/formatBytes.js';

// --------------------------- helpers ---------------------------

/**
 * Resolve the latest tag from availableTags (same logic as getLatestTag in
 * modelManager.js). Returns the latest tag string or null if none match.
 */
function resolveLatestTag(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return null;
  const valid = tags.filter((tg) => typeof tg === 'string' && /^v?\d+/i.test(tg));
  if (valid.length === 0) return null;
  valid.sort((a, b) => {
    const na = a.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
    const nb = b.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
    const len = Math.max(na.length, nb.length);
    for (let i = 0; i < len; i++) {
      const da = na[i] || 0;
      const db = nb[i] || 0;
      if (da !== db) return db - da; // descending
    }
    return 0;
  });
  return valid[0];
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec <= 0) return '';
  return formatBytes(bytesPerSec) + '/s';
}

export const useModelDownloadStore = defineStore('modelDownload', () => {
  // ==================== i18n / precision init ====================
  const i18nReady = ref(false);

  // Resolved when the main process pushes the initial precision via
  // 'model-download:precision'. Used to make refreshVersionInfo() wait for the
  // real precision instead of falling back to the 'fp16' default — otherwise
  // an FP32 install would briefly display the FP16 version number on open.
  let _resolveInitialPrecision = null;
  const initialPrecisionReady = new Promise((resolve) => {
    _resolveInitialPrecision = resolve;
  });

  // ==================== Precision / revision ====================
  // Default precision is int8-npu on ALL platforms (same as desktop SXSEditor).
  // The Rust backend (models.rs) ships only the int8-npu manifest.
  const currentPrecision = ref('int8-npu');
  // 'latest' = auto-pick newest tag, or a specific tag (e.g. 'v1')
  const currentRevision = ref('latest');
  // tags fetched from ModelScope (branches NOT shown)
  const availableTags = ref([]);
  // value bound to the <select>; mirrors currentRevision but kept separate
  // so the change handler can revert it during an active download.
  const selectedRevision = ref('latest');
  const versionSelectDisabled = ref(true);

  // ==================== Version info ====================
  // { updateAvailable, localVersion, latestVersion, hasModelFiles, localRevision }
  const currentVersionInfo = ref(null);
  const versionInfoSectionVisible = ref(false);
  const localVersionText = ref('-');
  const latestVersionText = ref('-');
  const versionUpdateBannerVisible = ref(false);
  const versionUpdateText = ref('');
  const updateModelBtnVisible = ref(false);

  // ==================== Download state ====================
  const isDownloading = ref(false);
  let downloadStartTime = 0;
  let lastSpeedTime = 0;
  let lastOverallDownloaded = 0;

  const overallPercent = ref(0);
  const overallBarWidth = ref('0%');
  const speedInfo = ref('');
  // statusText holds the message shown in the header. When statusSpinner is
  // true the template prepends a .spinner element (downloading-multiple state).
  const statusText = ref('');
  const statusSpinner = ref(false);

  // ==================== File list ====================
  const missingFiles = ref([]);
  // keyed by filePath → { status, progress, downloaded, total }
  const fileStates = ref({});

  // ==================== Dir info ====================
  const dirPath = ref('');
  const dirInfoVisible = ref(false);
  const changeDirDisabled = ref(false);

  // ==================== Error ====================
  const errorMessage = ref('');
  const errorVisible = ref(false);

  // ==================== Section / button visibility ====================
  const precisionSectionVisible = ref(false);
  const progressSectionVisible = ref(false);
  const startBtnVisible = ref(false);
  const cancelBtnVisible = ref(false);
  const closeBtnVisible = ref(false);

  // ==================== Overview ====================
  const overviewSectionVisible = ref(false);
  const mainDotState = ref('checking');
  const overviewMainText = ref('');
  const jpDotState = ref('checking');
  const overviewJpText = ref('');
  const sifiganDotState = ref('checking');
  const overviewSifiganText = ref('');

  // ==================== JP (Japanese LoRA) card ====================
  // status: 'installed' | 'not_downloaded' | 'checking' | 'downloading'
  const jpStatus = ref('checking');
  const jpIsDownloading = ref(false);
  // { updateAvailable, localVersion, latestVersion, hasModelFiles }
  const jpVersionInfo = ref(null);
  const jpStatusText = ref('');
  const jpTooltip = ref('');
  const jpTooltipVisible = ref(false);
  const jpProgressVisible = ref(false);
  const jpDownloadBtnVisible = ref(true);
  const jpDownloadBtnDisabled = ref(true);
  const jpUnloadBtnVisible = ref(false);
  const jpUnloadBtnDisabled = ref(false);
  const jpVersionText = ref('');
  const jpUpdateBtnVisible = ref(false);

  // ==================== SiFiGAN card ====================
  // status: 'installed' | 'not_downloaded' | 'download_url_not_configured' | 'checking' | 'downloading'
  const sifiganStatus = ref('checking');
  const sifiganIsDownloading = ref(false);
  const sifiganVersionInfo = ref(null);
  const sifiganFiles = ref(null);
  const sifiganStatusText = ref('');
  const sifiganTooltip = ref('');
  const sifiganTooltipVisible = ref(false);
  const sifiganProgressVisible = ref(false);
  const sifiganDownloadBtnVisible = ref(true);
  const sifiganDownloadBtnDisabled = ref(true);
  const sifiganUnloadBtnVisible = ref(false);
  const sifiganUnloadBtnDisabled = ref(false);
  const sifiganVersionText = ref('');
  const sifiganUpdateBtnVisible = ref(false);

  // ==================== computed ====================

  // Options for the version <select>: 'latest' first, then each tag.
  const versionOptions = computed(() => {
    const opts = [{ value: 'latest', label: t('modelDownload.latestVersionLabel') }];
    for (const tag of availableTags.value) {
      opts.push({ value: tag, label: tag });
    }
    return opts;
  });

  // ==================== version-target helpers ====================

  /**
   * Check if the currently selected main model revision resolves to v0 or
   * null (no real version). In such cases the download/update confirmation
   * should warn the user that v0 and legacy content are identical.
   */
  function isMainModelTargetV0OrLegacy() {
    if (currentRevision.value === 'v0') return true;
    if (currentRevision.value === 'latest') {
      const latest = resolveLatestTag(availableTags.value);
      return !latest || latest === 'v0';
    }
    return false;
  }

  /**
   * Check if SiFiGAN's latest version is v0 or null based on cached versionInfo.
   */
  function isSifiganTargetV0OrLegacy() {
    const info = sifiganVersionInfo.value;
    if (!info) return false; // unknown — don't block initial download
    return !info.latestVersion || info.latestVersion === 'v0';
  }

  // ==================== dir info ====================

  async function loadModelDir() {
    try {
      const dir = await window.electronAPI.modelDownloadGetDir();
      dirPath.value = dir;
      dirInfoVisible.value = true;
    } catch (_) { /* noop */ }
  }

  // ==================== missing files ====================

  function updateMissingFiles(newMissingFiles) {
    missingFiles.value = newMissingFiles.slice();
    const next = {};
    for (const file of newMissingFiles) {
      const prev = fileStates.value[file.filePath];
      if (prev && prev.status !== 'pending') {
        next[file.filePath] = prev;
      } else {
        next[file.filePath] = { status: 'pending', progress: 0, downloaded: 0, total: 0 };
      }
    }
    fileStates.value = next;
    statusText.value = t('modelDownload.needDownloadCount', { count: newMissingFiles.length });
    statusSpinner.value = false;
  }

  // ==================== version management ====================

  /**
   * Check model version for the current precision and update the UI.
   * Called on window load, precision switch, and after download completes.
   */
  async function refreshVersionInfo() {
    try {
      const result = await window.electronAPI.modelDownloadCheckVersion(currentPrecision.value);
      currentVersionInfo.value = result;
      renderVersionInfo(result);
    } catch (err) {
      console.error('[Version] Failed to check model version:', err);
      versionInfoSectionVisible.value = false;
    }
    // Update overview after main model version info is refreshed
    updateOverviewStatus();
  }

  /**
   * Fetch available model versions (tags) from ModelScope and populate
   * the version selector dropdown. The first option is always 'latest'
   * (auto-pick the newest tag). Tags are appended after. Branches are
   * NOT shown. 'latest' is the default selection.
   */
  async function refreshVersionSelector() {
    versionSelectDisabled.value = true;
    try {
      const result = await window.electronAPI.modelDownloadListVersions(currentPrecision.value);
      availableTags.value = (result && result.tags) || [];
    } catch (_) {
      availableTags.value = [];
    }
    // Determine which option to select:
    // 1. If local model has a specific tag installed, select that tag
    // 2. Else default to 'latest'
    const info = currentVersionInfo.value;
    const localRev = info && info.hasModelFiles ? info.localRevision : null;
    if (localRev && localRev !== 'master' && availableTags.value.includes(localRev)) {
      selectedRevision.value = localRev;
      currentRevision.value = localRev;
    } else {
      selectedRevision.value = 'latest';
      currentRevision.value = 'latest';
    }
    versionSelectDisabled.value = false;
  }

  function renderVersionInfo(info) {
    if (!info || !info.hasModelFiles) {
      // No model files installed — hide version info, no update needed
      versionInfoSectionVisible.value = false;
      // Still refresh the version selector so user can pick a version to download
      refreshVersionSelector();
      return;
    }

    versionInfoSectionVisible.value = true;
    // Show local revision (tag name) and latest version
    const localRev = info.localRevision;
    if (!localRev || localRev === 'master') {
      // Legacy branch-based install — show as legacy
      localVersionText.value = t('modelDownload.legacyVersion');
    } else {
      localVersionText.value = localRev;
    }
    latestVersionText.value = info.latestVersion || '-';

    if (info.updateAvailable) {
      versionUpdateBannerVisible.value = true;
      if (!localRev || localRev === 'master') {
        // Legacy install → update to latest tag
        versionUpdateText.value = t('modelDownload.legacyUpdateHint');
      } else {
        // Specific tag installed → update to latest available
        versionUpdateText.value = t('modelDownload.versionSwitchHint', { version: localRev });
      }
      updateModelBtnVisible.value = true;
    } else {
      versionUpdateBannerVisible.value = false;
      updateModelBtnVisible.value = false;
    }
    // Refresh the version selector to reflect installed revision
    refreshVersionSelector();
  }

  function updateOverallProgress(overallDownloaded, overallTotal) {
    let percent = overallTotal > 0 ? Math.round((overallDownloaded / overallTotal) * 100) : 0;
    percent = Math.min(Math.max(percent, 0), 100);
    overallPercent.value = percent;
    overallBarWidth.value = `${percent}%`;

    const now = Date.now();
    if (downloadStartTime > 0 && now - lastSpeedTime > 500) {
      const elapsed = (now - lastSpeedTime) / 1000;
      const diff = overallDownloaded - lastOverallDownloaded;
      const speed = diff / elapsed;
      speedInfo.value = formatSpeed(speed);
      lastSpeedTime = now;
      lastOverallDownloaded = overallDownloaded;
    }
  }

  // ==================== IPC event handlers ====================
  // These mirror the window.electronAPI.onModelDownload* callbacks in the
  // original bootstrap. The component registers the listeners and forwards
  // payloads here. Routing rules (skip main-model UI updates while an optional
  // model is downloading) are preserved exactly.

  function handleMissingFiles(files) {
    // Skip main-model UI updates when an optional model (JP/SiFiGAN) is being
    // downloaded — those flows reuse the same IPC events but should not reset
    // the main model panel.
    if (jpIsDownloading.value || sifiganIsDownloading.value) return;

    missingFiles.value = files.slice();
    // 清除旧的文件状态
    const next = {};
    for (const file of files) {
      next[file.filePath] = { status: 'pending', progress: 0, downloaded: 0, total: 0 };
    }
    fileStates.value = next;
    loadModelDir();

    // During an in-window update (updateModelBtn flow), isDownloading is true
    // and the progress section is already visible. Don't reset the UI back to
    // the "ready to download" state — the download is about to start.
    if (isDownloading.value) {
      errorVisible.value = false;
      return;
    }
    statusText.value = t('modelDownload.needDownloadCount', { count: files.length });
    statusSpinner.value = false;
    startBtnVisible.value = true;
    closeBtnVisible.value = true;
    precisionSectionVisible.value = true;
    progressSectionVisible.value = false;
    errorVisible.value = false;
  }

  function handlePrecision(precision) {
    const newPrecision = precision || 'int8-npu';
    const changed = newPrecision !== currentPrecision.value;
    currentPrecision.value = newPrecision;
    // Resolve the initial-precision promise so the first refreshVersionInfo()
    // call (in the init flow) uses the real precision.
    if (_resolveInitialPrecision) {
      const r = _resolveInitialPrecision;
      _resolveInitialPrecision = null;
      r();
    } else if (i18nReady.value && changed) {
      // Subsequent precision pushes (e.g. after delete-and-recheck) — refresh
      // version info so the UI reflects the new precision.
      refreshVersionInfo();
      // JP model status depends on precision (JP files live under <precision>/JP/)
      refreshJpCard();
    }
  }

  function handleRevision(revision) {
    if (revision && typeof revision === 'string' && revision !== 'latest') {
      currentRevision.value = revision;
      if (availableTags.value.includes(revision)) {
        selectedRevision.value = revision;
      }
    }
  }

  function handleProgress(data) {
    // Skip main-model UI updates when an optional model (JP/SiFiGAN) is being
    // downloaded — those flows reuse the same IPC events but should not update
    // the main model progress bar / file list.
    if (jpIsDownloading.value || sifiganIsDownloading.value) return;
    const state = fileStates.value[data.currentFile];
    if (state) {
      state.status = 'downloading';
      state.downloaded = data.bytesDownloaded;
      state.total = data.bytesTotal;
    }
    updateOverallProgress(data.overallDownloaded, data.overallTotal);
  }

  function handleFileStart(data) {
    // Skip for optional model downloads (JP/SiFiGAN)
    if (jpIsDownloading.value || sifiganIsDownloading.value) return;
    fileStates.value[data.filePath] = { status: 'downloading', progress: 0, downloaded: 0, total: 0 };
    // 统计当前正在下载的文件数
    const states = Object.values(fileStates.value);
    const downloadingCount = states.filter((s) => s.status === 'downloading').length;
    const completedCount = states.filter((s) => s.status === 'complete').length;
    statusText.value = t('modelDownload.downloadingMultiple', {
      active: downloadingCount,
      completed: completedCount,
      total: missingFiles.value.length,
    });
    statusSpinner.value = true;
  }

  function handleFileComplete(data) {
    // Skip for optional model downloads (JP/SiFiGAN)
    if (jpIsDownloading.value || sifiganIsDownloading.value) return;
    const state = fileStates.value[data.filePath];
    if (state) {
      state.status = 'complete';
    }
  }

  function handleComplete() {
    // JP/SiFiGAN downloads reuse the same 'complete' event. Route to the right
    // card refresh and skip main-model UI updates. Note: isDownloading flags
    // may have already been reset by the click handler's finally block (the
    // IPC event can fire before or after the await returns), so we check
    // isDownloading (main model) first — if it's true, this is a main model
    // download. Otherwise, treat it as an optional model completion and
    // refresh all optional cards.
    if (!isDownloading.value) {
      // Optional model (JP or SiFiGAN) completed — refresh both cards
      jpIsDownloading.value = false;
      sifiganIsDownloading.value = false;
      refreshJpCard();
      refreshSifiganCard();
      updateOverviewStatus();
      return;
    }
    statusText.value = t('modelDownload.allComplete');
    statusSpinner.value = false;
    speedInfo.value = '';
    cancelBtnVisible.value = false;
    closeBtnVisible.value = true;
    changeDirDisabled.value = true;
    overallBarWidth.value = '100%';
    overallPercent.value = 100;
    for (const key in fileStates.value) {
      fileStates.value[key].status = 'complete';
    }
    isDownloading.value = false;
    // 刷新版本信息（下载完成后版本应已更新）
    refreshVersionInfo();
    updateOverviewStatus();
  }

  function handleError(data) {
    // Optional model error — refresh cards and skip main-model UI updates
    if (!isDownloading.value) {
      jpIsDownloading.value = false;
      sifiganIsDownloading.value = false;
      if (data && data.message) showJpTooltip(data.message);
      refreshJpCard();
      refreshSifiganCard();
      updateOverviewStatus();
      return;
    }
    statusText.value = t('modelDownload.downloadFailed');
    statusSpinner.value = false;
    speedInfo.value = '';
    errorMessage.value = (data && data.message) || '未知错误';
    errorVisible.value = true;
    cancelBtnVisible.value = false;
    closeBtnVisible.value = true;
    changeDirDisabled.value = false;
    isDownloading.value = false;
  }

  // ==================== main-model actions ====================

  async function startDownload() {
    // When the target revision is v0 or null (no real version), warn the user
    // that v0 and legacy content are identical before starting the download.
    if (isMainModelTargetV0OrLegacy()) {
      const { showConfirmDialog } = await import('../../components/alertDialogService.js');
      const confirmed = await showConfirmDialog(t('modelDownload.v0LegacyConfirmMessage'));
      if (!confirmed) return;
    }

    startBtnVisible.value = false;
    closeBtnVisible.value = false;
    cancelBtnVisible.value = true;
    changeDirDisabled.value = true;
    precisionSectionVisible.value = false;
    progressSectionVisible.value = true;
    downloadStartTime = Date.now();
    lastSpeedTime = downloadStartTime;
    lastOverallDownloaded = 0;
    isDownloading.value = true;

    const result = await window.electronAPI.modelDownloadStart(
      currentPrecision.value,
      currentRevision.value
    );
    if (result && !result.success && result.error) {
      statusText.value = t('modelDownload.downloadNotAvailable');
      statusSpinner.value = false;
      speedInfo.value = '';
      errorMessage.value = result.error;
      errorVisible.value = true;
      cancelBtnVisible.value = false;
      closeBtnVisible.value = true;
      changeDirDisabled.value = false;
      precisionSectionVisible.value = true;
      progressSectionVisible.value = false;
      isDownloading.value = false;
    }
  }

  async function updateModel() {
    if (isDownloading.value) return;
    const { showConfirmDialog } = await import('../../components/alertDialogService.js');
    const confirmMsg = isMainModelTargetV0OrLegacy()
      ? t('modelDownload.v0LegacyConfirmMessage')
      : t('modelDownload.updateConfirmMessage');
    const confirmed = await showConfirmDialog(confirmMsg);
    if (!confirmed) return;

    isDownloading.value = true;
    updateModelBtnVisible.value = false;
    startBtnVisible.value = false;
    closeBtnVisible.value = false;
    cancelBtnVisible.value = true;
    changeDirDisabled.value = true;
    precisionSectionVisible.value = false;
    versionInfoSectionVisible.value = false;
    progressSectionVisible.value = true;
    downloadStartTime = Date.now();
    lastSpeedTime = downloadStartTime;
    lastOverallDownloaded = 0;

    const result = await window.electronAPI.modelDownloadUpdate(
      currentPrecision.value,
      currentRevision.value
    );
    if (result && !result.success && result.error) {
      statusText.value = t('modelDownload.downloadNotAvailable');
      statusSpinner.value = false;
      errorMessage.value = result.error;
      errorVisible.value = true;
      cancelBtnVisible.value = false;
      closeBtnVisible.value = true;
      changeDirDisabled.value = false;
      precisionSectionVisible.value = true;
      isDownloading.value = false;
    }
  }

  function cancelDownload() {
    window.electronAPI.modelDownloadCancel();
    statusText.value = t('modelDownload.downloadCancelled');
    statusSpinner.value = false;
    speedInfo.value = '';
    cancelBtnVisible.value = false;
    closeBtnVisible.value = true;
    changeDirDisabled.value = false;
    isDownloading.value = false;
  }

  function closeWindow() {
    window.close();
  }

  async function changeDir() {
    if (isDownloading.value) return;
    const result = await window.electronAPI.modelDownloadChangeDir();
    if (result.canceled) return;
    dirPath.value = result.modelDir;
    updateMissingFiles(result.missing);
    if (result.missing.length === 0) {
      statusText.value = t('modelDownload.modelsReady');
      statusSpinner.value = false;
      startBtnVisible.value = false;
      closeBtnVisible.value = true;
    } else {
      startBtnVisible.value = true;
      closeBtnVisible.value = true;
    }
  }

  /**
   * Precision radio change handler. Re-checks model files for the new
   * precision (does not delete existing files — different precisions coexist).
   */
  async function setPrecision(newPrecision) {
    if (isDownloading.value) return;
    if (newPrecision === currentPrecision.value) return;

    currentPrecision.value = newPrecision;
    statusText.value = t('modelDownload.detecting');
    statusSpinner.value = false;
    startBtnVisible.value = false;
    // 切换精度时刷新版本信息
    refreshVersionInfo();
    // 切换精度时也刷新 JP 卡片（JP 文件存放在 <precision>/JP/ 下）
    refreshJpCard();
    try {
      await window.electronAPI.modelDownloadRecheck(currentPrecision.value);
    } catch (err) {
      console.error('Failed to recheck model files:', err);
    }
  }

  /**
   * Version <select> change handler. Reverts the selection during an active
   * download (mirrors the original behaviour). In the normal case it syncs
   * both currentRevision (used by download/update IPC) and selectedRevision
   * (the value bound to the <select>).
   */
  function setRevision(newRevision) {
    if (isDownloading.value) {
      // revert selection during download
      selectedRevision.value = currentRevision.value;
      return;
    }
    if (newRevision && newRevision !== currentRevision.value) {
      currentRevision.value = newRevision;
    }
    selectedRevision.value = newRevision;
  }

  async function openModelUpdatesLink() {
    await window.electronAPI.modelDownloadOpenExternal(
      'https://henley04.github.io/SXSEditor/user/model-updates.html'
    );
  }

  // ==================== JP card ====================

  function showJpTooltip(message) {
    if (message) {
      jpTooltip.value = message;
      jpTooltipVisible.value = true;
    } else {
      jpTooltip.value = '';
      jpTooltipVisible.value = false;
    }
  }

  function renderJpCard() {
    // Reset transient visibility
    jpProgressVisible.value = false;
    jpVersionText.value = '';
    jpUpdateBtnVisible.value = false;

    switch (jpStatus.value) {
      case 'installed': {
        jpDownloadBtnVisible.value = false;
        jpUnloadBtnVisible.value = true;
        jpUnloadBtnDisabled.value = false;
        jpDownloadBtnDisabled.value = false;
        jpStatusText.value = t('modelDownload.jpInstalled');
        showJpTooltip('');
        if (jpVersionInfo.value) {
          const v = jpVersionInfo.value;
          const localStr = v.localVersion || t('modelDownload.legacyVersion');
          jpVersionText.value = t('modelDownload.versionDisplay', {
            local: localStr,
            latest: v.latestVersion || '-',
          });
          if (v.updateAvailable) {
            jpUpdateBtnVisible.value = true;
          }
        }
        break;
      }
      case 'not_downloaded': {
        jpDownloadBtnVisible.value = true;
        jpUnloadBtnVisible.value = false;
        jpDownloadBtnDisabled.value = false;
        jpStatusText.value = t('modelDownload.jpNotDownloaded');
        showJpTooltip('');
        break;
      }
      case 'downloading': {
        jpDownloadBtnVisible.value = true;
        jpDownloadBtnDisabled.value = true;
        jpUnloadBtnVisible.value = false;
        jpProgressVisible.value = true;
        jpStatusText.value = t('modelDownload.checking');
        break;
      }
      case 'checking':
      default: {
        jpDownloadBtnVisible.value = true;
        jpDownloadBtnDisabled.value = true;
        jpUnloadBtnVisible.value = false;
        jpStatusText.value = t('modelDownload.checking');
        showJpTooltip('');
        break;
      }
    }
  }

  async function refreshJpCard() {
    jpStatus.value = 'checking';
    renderJpCard();
    try {
      const result = await window.electronAPI.modelDownloadCheckJp(currentPrecision.value);
      // IMPORTANT: check result.installed first, not just result.missing.length.
      // The Rust stub returns { installed: false, missing: [] } — an empty
      // missing array with installed=false means "not checked / stub", NOT
      // "all files present". Without this check, the UI incorrectly shows
      // the JP model as "already downloaded".
      if (result && result.installed && (!result.missing || result.missing.length === 0)) {
        jpStatus.value = 'installed';
        try {
          jpVersionInfo.value = await window.electronAPI.modelDownloadCheckJpVersion(
            currentPrecision.value
          );
        } catch (_) {
          jpVersionInfo.value = null;
        }
      } else {
        jpStatus.value = 'not_downloaded';
        jpVersionInfo.value = null;
      }
    } catch (err) {
      console.error('[JP] status check failed:', err);
      jpStatus.value = 'not_downloaded';
      jpVersionInfo.value = null;
    }
    renderJpCard();
    updateOverviewStatus();
  }

  async function downloadJp() {
    if (jpIsDownloading.value) return;
    jpIsDownloading.value = true;
    jpStatus.value = 'downloading';
    renderJpCard();
    try {
      const result = await window.electronAPI.modelDownloadStartJp(
        currentPrecision.value,
        'latest'
      );
      if (result && result.success === false && result.error) {
        showJpTooltip(result.error);
        jpStatus.value = 'not_downloaded';
      } else {
        // Refresh state after download
        const checkResult = await window.electronAPI.modelDownloadCheckJp(currentPrecision.value);
        if (checkResult && checkResult.missing && checkResult.missing.length === 0) {
          jpStatus.value = 'installed';
          try {
            jpVersionInfo.value = await window.electronAPI.modelDownloadCheckJpVersion(
              currentPrecision.value
            );
          } catch (_) {
            jpVersionInfo.value = null;
          }
        } else {
          jpStatus.value = 'not_downloaded';
        }
      }
    } catch (err) {
      console.error('[JP] download failed:', err);
      showJpTooltip(err.message || t('modelDownload.jpDownloadFailed'));
      jpStatus.value = 'not_downloaded';
    } finally {
      jpIsDownloading.value = false;
      renderJpCard();
      updateOverviewStatus();
    }
  }

  async function unloadJp() {
    if (jpIsDownloading.value) return;
    // Inform user that frontend unloading is not supported in this version
    const { showConfirmDialog } = await import('../../components/alertDialogService.js');
    await showConfirmDialog(t('modelDownload.jpUnloadNotSupported'));
  }

  async function updateJp() {
    if (jpIsDownloading.value) return;
    const { showConfirmDialog } = await import('../../components/alertDialogService.js');
    const confirmed = await showConfirmDialog(t('modelDownload.jpUpdateConfirmMessage'));
    if (!confirmed) return;
    jpIsDownloading.value = true;
    jpStatus.value = 'downloading';
    renderJpCard();
    try {
      // Delete existing files then re-download
      await window.electronAPI.modelDownloadUpdateJp(currentPrecision.value, 'latest');
      const result = await window.electronAPI.modelDownloadStartJp(currentPrecision.value, 'latest');
      if (result && result.success === false && result.error) {
        showJpTooltip(result.error);
        jpStatus.value = 'not_downloaded';
      } else {
        const checkResult = await window.electronAPI.modelDownloadCheckJp(currentPrecision.value);
        if (checkResult && checkResult.missing && checkResult.missing.length === 0) {
          jpStatus.value = 'installed';
          try {
            jpVersionInfo.value = await window.electronAPI.modelDownloadCheckJpVersion(
              currentPrecision.value
            );
          } catch (_) {
            jpVersionInfo.value = null;
          }
        } else {
          jpStatus.value = 'not_downloaded';
        }
      }
    } catch (err) {
      console.error('[JP] update failed:', err);
      showJpTooltip(err.message || t('modelDownload.jpDownloadFailed'));
      jpStatus.value = 'not_downloaded';
    } finally {
      jpIsDownloading.value = false;
      renderJpCard();
      updateOverviewStatus();
    }
  }

  // ==================== SiFiGAN card ====================

  function showSifiganTooltip(message) {
    if (message) {
      sifiganTooltip.value = message;
      sifiganTooltipVisible.value = true;
    } else {
      sifiganTooltip.value = '';
      sifiganTooltipVisible.value = false;
    }
  }

  function renderSifiganCard() {
    // Reset visibility
    sifiganProgressVisible.value = false;
    sifiganVersionText.value = '';
    sifiganUpdateBtnVisible.value = false;

    switch (sifiganStatus.value) {
      case 'installed': {
        sifiganDownloadBtnVisible.value = false;
        sifiganUnloadBtnVisible.value = true;
        sifiganUnloadBtnDisabled.value = false;
        sifiganDownloadBtnDisabled.value = false;
        sifiganStatusText.value = t('modelDownload.sifiganInstalled');
        showSifiganTooltip('');
        // 显示版本信息和更新按钮
        if (sifiganVersionInfo.value) {
          const v = sifiganVersionInfo.value;
          const localStr = v.localVersion || t('modelDownload.legacyVersion');
          sifiganVersionText.value = t('modelDownload.versionDisplay', {
            local: localStr,
            latest: v.latestVersion || '-',
          });
          if (v.updateAvailable) {
            sifiganUpdateBtnVisible.value = true;
          }
        }
        break;
      }
      case 'not_downloaded': {
        sifiganDownloadBtnVisible.value = true;
        sifiganUnloadBtnVisible.value = false;
        sifiganDownloadBtnDisabled.value = false;
        sifiganStatusText.value = t('modelDownload.sifiganNotDownloaded');
        showSifiganTooltip('');
        break;
      }
      case 'download_url_not_configured': {
        // Disable download button and show explanatory tooltip
        sifiganDownloadBtnVisible.value = true;
        sifiganUnloadBtnVisible.value = false;
        sifiganDownloadBtnDisabled.value = true;
        sifiganStatusText.value = t('modelDownload.sifiganUrlNotConfigured');
        showSifiganTooltip(t('modelDownload.sifiganUrlNotConfiguredTooltip'));
        break;
      }
      case 'downloading': {
        sifiganDownloadBtnVisible.value = true;
        sifiganDownloadBtnDisabled.value = true;
        sifiganUnloadBtnVisible.value = false;
        sifiganProgressVisible.value = true;
        break;
      }
      case 'checking':
      default: {
        sifiganDownloadBtnVisible.value = true;
        sifiganDownloadBtnDisabled.value = true;
        sifiganUnloadBtnVisible.value = false;
        sifiganStatusText.value = t('modelDownload.checking');
        showSifiganTooltip('');
        break;
      }
    }
  }

  async function refreshSifiganCard() {
    sifiganStatus.value = 'checking';
    renderSifiganCard();
    try {
      const result = await window.electronAPI.modelDownloadCheckSifigan();
      sifiganStatus.value = result.status;
      sifiganFiles.value = result.files;
      // 检查 SiFiGAN 版本
      if (result.allExist) {
        try {
          sifiganVersionInfo.value = await window.electronAPI.modelDownloadCheckSifiganVersion();
        } catch (_) {
          sifiganVersionInfo.value = null;
        }
      } else {
        sifiganVersionInfo.value = null;
      }
    } catch (err) {
      console.error('[SiFiGAN] status check failed:', err);
      sifiganStatus.value = 'download_url_not_configured';
    }
    renderSifiganCard();
    updateOverviewStatus();
  }

  async function downloadSifigan() {
    if (sifiganIsDownloading.value) return;
    // Warn if SiFiGAN's latest version is v0 or null (same as legacy content).
    if (isSifiganTargetV0OrLegacy()) {
      const { showConfirmDialog } = await import('../../components/alertDialogService.js');
      const confirmed = await showConfirmDialog(t('modelDownload.v0LegacyConfirmMessage'));
      if (!confirmed) return;
    }
    sifiganIsDownloading.value = true;
    sifiganStatus.value = 'downloading';
    renderSifiganCard();
    try {
      const result = await window.electronAPI.modelDownloadStartSifigan();
      if (result.status === 'download_url_not_configured') {
        // Main process short-circuited because MODEL_IDS.sifigan is empty.
        sifiganStatus.value = 'download_url_not_configured';
        sifiganFiles.value = result.files;
      } else if (result.status === 'installed') {
        sifiganStatus.value = 'installed';
        sifiganFiles.value = result.files;
        // 下载完成后刷新版本信息
        try {
          sifiganVersionInfo.value = await window.electronAPI.modelDownloadCheckSifiganVersion();
        } catch (_) {
          sifiganVersionInfo.value = null;
        }
      } else {
        sifiganStatus.value = 'not_downloaded';
        sifiganFiles.value = result.files;
      }
    } catch (err) {
      console.error('[SiFiGAN] download failed:', err);
      sifiganStatus.value = 'download_url_not_configured';
    } finally {
      sifiganIsDownloading.value = false;
      renderSifiganCard();
    }
  }

  async function unloadSifigan() {
    if (sifiganIsDownloading.value) return;
    // Confirm before deleting model files
    const { showConfirmDialog } = await import('../../components/alertDialogService.js');
    const confirmed = await showConfirmDialog(t('modelDownload.sifiganUnloadConfirmMessage'));
    if (!confirmed) return;

    sifiganIsDownloading.value = true;
    try {
      const result = await window.electronAPI.modelDownloadUnloadSifigan();
      sifiganStatus.value = result.status || 'download_url_not_configured';
      sifiganFiles.value = result.files;
      sifiganVersionInfo.value = null;
    } catch (err) {
      console.error('[SiFiGAN] unload failed:', err);
      // Re-check on failure to get the actual state
    } finally {
      sifiganIsDownloading.value = false;
      renderSifiganCard();
    }
  }

  async function updateSifigan() {
    if (sifiganIsDownloading.value) return;
    const { showConfirmDialog } = await import('../../components/alertDialogService.js');
    const confirmMsg = isSifiganTargetV0OrLegacy()
      ? t('modelDownload.v0LegacyConfirmMessage')
      : t('modelDownload.sifiganUpdateConfirmMessage');
    const confirmed = await showConfirmDialog(confirmMsg);
    if (!confirmed) return;

    sifiganIsDownloading.value = true;
    sifiganStatus.value = 'downloading';
    renderSifiganCard();
    try {
      // 先删除旧文件（含版本文件），再触发下载
      await window.electronAPI.modelDownloadUpdateSifigan();
      const result = await window.electronAPI.modelDownloadStartSifigan();
      if (result.status === 'installed') {
        sifiganStatus.value = 'installed';
        sifiganFiles.value = result.files;
        try {
          sifiganVersionInfo.value = await window.electronAPI.modelDownloadCheckSifiganVersion();
        } catch (_) {
          sifiganVersionInfo.value = null;
        }
      } else {
        sifiganStatus.value = 'not_downloaded';
        sifiganFiles.value = result.files;
      }
    } catch (err) {
      console.error('[SiFiGAN] update failed:', err);
      sifiganStatus.value = 'download_url_not_configured';
    } finally {
      sifiganIsDownloading.value = false;
      renderSifiganCard();
    }
  }

  // ==================== Overview ====================

  function setOverviewCard(groupId, dotState, txt) {
    if (groupId === 'main') {
      mainDotState.value = dotState;
      if (txt) overviewMainText.value = txt;
    } else if (groupId === 'jp') {
      jpDotState.value = dotState;
      if (txt) overviewJpText.value = txt;
    } else if (groupId === 'sifigan') {
      sifiganDotState.value = dotState;
      if (txt) overviewSifiganText.value = txt;
    }
  }

  function updateOverviewStatus() {
    overviewSectionVisible.value = true;

    // Main model: derive from currentVersionInfo (refreshVersionInfo populates it)
    let mainState = 'checking';
    let mainText = t('modelDownload.overviewChecking');
    const info = currentVersionInfo.value;
    if (info) {
      if (info.hasModelFiles) {
        mainState = info.updateAvailable ? 'warning' : 'installed';
        mainText = info.updateAvailable
          ? t('modelDownload.overviewUpdateAvailable')
          : t('modelDownload.overviewReady');
      } else {
        mainState = 'missing';
        mainText = t('modelDownload.overviewMissing');
      }
    }
    // When main model is downloading, override to 'checking' (animated)
    if (isDownloading.value) {
      mainState = 'checking';
      mainText = t('modelDownload.overviewDownloading');
    }
    setOverviewCard('main', mainState, mainText);

    // JP model
    let jpDot = 'checking';
    let jpText = t('modelDownload.overviewChecking');
    if (jpStatus.value === 'installed') {
      jpDot = jpVersionInfo.value && jpVersionInfo.value.updateAvailable ? 'warning' : 'installed';
      jpText =
        jpVersionInfo.value && jpVersionInfo.value.updateAvailable
          ? t('modelDownload.overviewUpdateAvailable')
          : t('modelDownload.overviewReady');
    } else if (jpStatus.value === 'not_downloaded') {
      jpDot = 'missing';
      jpText = t('modelDownload.overviewMissing');
    } else if (jpStatus.value === 'downloading') {
      jpDot = 'checking';
      jpText = t('modelDownload.overviewDownloading');
    }
    setOverviewCard('jp', jpDot, jpText);

    // SiFiGAN
    let sifiganDot = 'checking';
    let sifiganText = t('modelDownload.overviewChecking');
    if (sifiganStatus.value === 'installed') {
      sifiganDot =
        sifiganVersionInfo.value && sifiganVersionInfo.value.updateAvailable
          ? 'warning'
          : 'installed';
      sifiganText =
        sifiganVersionInfo.value && sifiganVersionInfo.value.updateAvailable
          ? t('modelDownload.overviewUpdateAvailable')
          : t('modelDownload.overviewReady');
    } else if (
      sifiganStatus.value === 'not_downloaded' ||
      sifiganStatus.value === 'download_url_not_configured'
    ) {
      sifiganDot = 'missing';
      sifiganText = t('modelDownload.overviewMissing');
    } else if (sifiganStatus.value === 'downloading') {
      sifiganDot = 'checking';
      sifiganText = t('modelDownload.overviewDownloading');
    }
    setOverviewCard('sifigan', sifiganDot, sifiganText);
  }

  // ==================== init ====================

  /**
   * Run the post-i18n init sequence. Mirrors the original
   * `initI18n().then(async () => { ... })` block. The component calls this
   * from onMounted after registering the IPC listeners (so the precision
   * push can resolve the initialPrecisionReady promise).
   */
  async function init() {
    i18nReady.value = true;
    // Wait for the main process to push the real precision before querying
    // the version — otherwise an FP32 install would briefly show the FP16
    // version. Fall back after a short timeout in case the push never arrives.
    await Promise.race([
      initialPrecisionReady,
      new Promise((r) => setTimeout(r, 1000)),
    ]);
    // Refresh SiFiGAN card once i18n is ready so status text is translated
    refreshSifiganCard();
    // Refresh JP card after precision is known
    refreshJpCard();
    // Check main model version info (stub returns hasModelFiles:false,
    // so the overview correctly shows "missing" until files are downloaded)
    refreshVersionInfo();
    // Also run the real file-level check (check_missing) to get an accurate
    // count of missing files. This populates missingFiles so the start
    // button shows the correct "N files to download" label.
    try {
      const checkResult = await window.electronAPI.modelDownloadCheck();
      // Rust returns { files: [...], precision: "..." } — field is "files"
      if (checkResult && checkResult.files) {
        missingFiles.value = checkResult.files;
      }
    } catch (_) { /* non-fatal */ }
    // Initial overview status (will be re-updated as each refresh completes)
    updateOverviewStatus();
  }

  return {
    // state
    i18nReady,
    currentPrecision,
    currentRevision,
    selectedRevision,
    versionSelectDisabled,
    availableTags,
    currentVersionInfo,
    versionInfoSectionVisible,
    localVersionText,
    latestVersionText,
    versionUpdateBannerVisible,
    versionUpdateText,
    updateModelBtnVisible,
    isDownloading,
    overallPercent,
    overallBarWidth,
    speedInfo,
    statusText,
    statusSpinner,
    missingFiles,
    fileStates,
    dirPath,
    dirInfoVisible,
    changeDirDisabled,
    errorMessage,
    errorVisible,
    precisionSectionVisible,
    progressSectionVisible,
    startBtnVisible,
    cancelBtnVisible,
    closeBtnVisible,
    overviewSectionVisible,
    mainDotState,
    overviewMainText,
    jpDotState,
    overviewJpText,
    sifiganDotState,
    overviewSifiganText,
    jpStatus,
    jpIsDownloading,
    jpVersionInfo,
    jpStatusText,
    jpTooltip,
    jpTooltipVisible,
    jpProgressVisible,
    jpDownloadBtnVisible,
    jpDownloadBtnDisabled,
    jpUnloadBtnVisible,
    jpUnloadBtnDisabled,
    jpVersionText,
    jpUpdateBtnVisible,
    sifiganStatus,
    sifiganIsDownloading,
    sifiganVersionInfo,
    sifiganFiles,
    sifiganStatusText,
    sifiganTooltip,
    sifiganTooltipVisible,
    sifiganProgressVisible,
    sifiganDownloadBtnVisible,
    sifiganDownloadBtnDisabled,
    sifiganUnloadBtnVisible,
    sifiganUnloadBtnDisabled,
    sifiganVersionText,
    sifiganUpdateBtnVisible,
    // computed
    versionOptions,
    // helpers
    isMainModelTargetV0OrLegacy,
    isSifiganTargetV0OrLegacy,
    // IPC event handlers
    handleMissingFiles,
    handlePrecision,
    handleRevision,
    handleProgress,
    handleFileStart,
    handleFileComplete,
    handleComplete,
    handleError,
    // actions
    init,
    loadModelDir,
    updateMissingFiles,
    refreshVersionInfo,
    refreshVersionSelector,
    startDownload,
    updateModel,
    cancelDownload,
    closeWindow,
    changeDir,
    setPrecision,
    setRevision,
    openModelUpdatesLink,
    refreshJpCard,
    downloadJp,
    unloadJp,
    updateJp,
    showJpTooltip,
    refreshSifiganCard,
    downloadSifigan,
    unloadSifigan,
    updateSifigan,
    showSifiganTooltip,
    updateOverviewStatus,
  };
});
