/**
 * Pinia store for the update-notification window.
 *
 * Holds every piece of reactive state that the vanilla-JS bootstrap
 * (src/updateNotification.js) used to mutate imperatively via
 * document.getElementById / classList / textContent. The Vue component
 * reads computed views off this store and calls the actions to mirror the
 * original render() / showDownloadProgress() / setProgress() / etc. flows.
 */
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { t } from '../../../i18n/index.js';

const MODEL_LABELS = {
  main: 'Main',
  jp: 'JP',
  sifigan: 'SiFiGAN',
};

function formatBytes(n) {
  if (!n || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export const useUpdateNotificationStore = defineStore('updateNotification', () => {
  // Raw notification data pushed by the main process. `app` defaults to {}
  // to match the vanilla JS behaviour (`currentData.app || {}`).
  const app = ref({});
  const models = ref(null);

  // ----- Visibility / UI state (mirrors imperative DOM toggling) -----
  // The static HTML showed the app area and the action buttons by default
  // and hid the model area / download container, so we seed accordingly.
  const appAreaVisible = ref(true);
  const appErrorMsg = ref('');
  const modelAreaVisible = ref(false);
  const modelErrorMsg = ref('');
  const modelNotesVisible = ref(false);

  const updateNowHidden = ref(false);
  const skipVersionHidden = ref(false);
  const dontRemindHidden = ref(false);

  // ----- Download progress -----
  const downloadVisible = ref(false);
  const progressPercent = ref(0);
  const downloadSizeText = ref('0%');
  const downloadStatus = ref('');
  const cancelDisabled = ref(false);

  // ----- Toast -----
  const toastMessage = ref('');
  const toastVisible = ref(false);
  let toastTimer = null;

  // ----- Computed display values -----
  const appCurrentVersionText = computed(() => (app.value && app.value.currentVersion) || '-');
  const appLatestVersionText = computed(() =>
    appErrorMsg.value ? '-' : ((app.value && app.value.latestVersion) || '-')
  );
  const appPublishedAtText = computed(() =>
    appErrorMsg.value ? '-' : ((app.value && app.value.publishedAt) || '-')
  );
  const appReleaseNotesUrl = computed(() => (app.value && app.value.appReleaseNotesUrl) || '');

  const modelEntries = computed(() => {
    const m = models.value;
    if (!m || m.error || !m.anyUpdateAvailable) return [];
    const entries = [['main', m.main], ['jp', m.jp], ['sifigan', m.sifigan]];
    const result = [];
    for (const [key, info] of entries) {
      if (!info || !info.updateAvailable) continue;
      const local = info.localVersion ? info.localVersion : t('modelDownload.legacyVersion');
      result.push({
        key,
        name: MODEL_LABELS[key] || key,
        versionText: `${local} → ${info.latestVersion || '-'}`,
      });
    }
    return result;
  });
  const modelReleaseNotesUrl = computed(() =>
    (models.value && models.value.modelReleaseNotesUrl) || ''
  );

  const progressBarWidth = computed(() => `${progressPercent.value.toFixed(1)}%`);

  // ----- Actions (mirror the vanilla JS functions) -----
  function renderAppArea(appData) {
    if (appData.error) {
      // Show the app area as an error banner (no version rows, no update button)
      appAreaVisible.value = true;
      appErrorMsg.value =
        appData.error === 'rate_limited' ? t('update.rateLimited') : t('update.networkError');
      return;
    }
    if (!appData.updateAvailable) {
      appAreaVisible.value = false;
      appErrorMsg.value = '';
      return;
    }
    appAreaVisible.value = true;
    appErrorMsg.value = '';
  }

  function renderModelArea(modelsData) {
    if (!modelsData) {
      modelAreaVisible.value = false;
      modelErrorMsg.value = '';
      modelNotesVisible.value = false;
      return;
    }
    if (modelsData.error) {
      modelAreaVisible.value = true;
      modelErrorMsg.value = t('update.modelCheckError');
      modelNotesVisible.value = false;
      return;
    }
    if (!modelsData.anyUpdateAvailable) {
      modelAreaVisible.value = false;
      modelErrorMsg.value = '';
      modelNotesVisible.value = false;
      return;
    }
    modelAreaVisible.value = true;
    modelErrorMsg.value = '';
    modelNotesVisible.value = true;
  }

  function updateActionButtons(appData) {
    const hasAppUpdate = !!(appData && appData.updateAvailable && !appData.error);
    updateNowHidden.value = !hasAppUpdate;
    skipVersionHidden.value = !hasAppUpdate;
    dontRemindHidden.value = !hasAppUpdate;
  }

  function render(data) {
    const d = data || {};
    const appData = d.app || {};
    const modelsData = d.models || null;
    app.value = appData;
    models.value = modelsData;
    renderAppArea(appData);
    renderModelArea(modelsData);
    updateActionButtons(appData);
  }

  function showDownloadProgress() {
    downloadVisible.value = true;
    updateNowHidden.value = true;
    skipVersionHidden.value = true;
    dontRemindHidden.value = true;
    progressPercent.value = 0;
    downloadSizeText.value = '0%';
    downloadStatus.value = t('update.downloading');
    cancelDisabled.value = false;
  }

  function hideDownloadProgress() {
    downloadVisible.value = false;
  }

  function setProgress(percent, received, total) {
    const pct = Math.max(0, Math.min(100, percent || 0));
    progressPercent.value = pct;
    if (total > 0) {
      downloadSizeText.value = `${pct.toFixed(1)}% (${formatBytes(received)} / ${formatBytes(total)})`;
    } else {
      downloadSizeText.value = `${formatBytes(received)}`;
    }
  }

  function setDownloadStatus(status) {
    downloadStatus.value = status;
  }

  function setCancelDisabled(disabled) {
    cancelDisabled.value = disabled;
  }

  // Used by the cancel-download and download-error handlers: re-show all
  // three action buttons when an app update is still available.
  function restoreAllActionButtons() {
    const hasAppUpdate = !!(app.value && app.value.updateAvailable && !app.value.error);
    updateNowHidden.value = !hasAppUpdate;
    skipVersionHidden.value = !hasAppUpdate;
    dontRemindHidden.value = !hasAppUpdate;
  }

  // Used by the update-now click error paths. The vanilla JS only un-hid the
  // "Update Now" button here (leaving skip / don't-remind hidden); we keep
  // that exact behaviour.
  function restoreUpdateNowOnly() {
    updateNowHidden.value = false;
  }

  function showToast(msg) {
    toastMessage.value = msg;
    toastVisible.value = true;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastVisible.value = false;
    }, 4000);
  }

  return {
    // state
    app,
    models,
    appAreaVisible,
    appErrorMsg,
    modelAreaVisible,
    modelErrorMsg,
    modelNotesVisible,
    updateNowHidden,
    skipVersionHidden,
    dontRemindHidden,
    downloadVisible,
    progressPercent,
    downloadSizeText,
    downloadStatus,
    cancelDisabled,
    toastMessage,
    toastVisible,
    // computed
    appCurrentVersionText,
    appLatestVersionText,
    appPublishedAtText,
    appReleaseNotesUrl,
    modelEntries,
    modelReleaseNotesUrl,
    progressBarWidth,
    // actions
    render,
    showDownloadProgress,
    hideDownloadProgress,
    setProgress,
    setDownloadStatus,
    setCancelDisabled,
    restoreAllActionButtons,
    restoreUpdateNowOnly,
    showToast,
    formatBytes,
  };
});
