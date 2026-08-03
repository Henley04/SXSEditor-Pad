<!--
  UpdateNotificationApp.vue — full Vue 3 replacement for the
  update-notification window.

  The template reproduces the entire static <body> markup that used to live
  in src/updateNotification.html, and <script setup> moves every event
  handler, IPC listener and piece of logic from src/updateNotification.js
  into the component. Shared/reactive state lives in the Pinia store
  (./store.js); component-local concerns (IPC cleanup arrays, theme
  cleanups) stay here.
-->
<template>
  <div class="header">
    <h1>{{ $t('update.updateAvailable') }}</h1>
  </div>

  <section v-show="store.appAreaVisible" class="update-section">
    <h2>{{ $t('update.appUpdateAreaTitle') }}</h2>
    <div class="info-grid">
      <div class="info-row">
        <span class="info-label">{{ $t('update.currentVersion') }}</span>
        <span class="info-value">{{ store.appCurrentVersionText }}</span>
      </div>
      <div class="info-row">
        <span class="info-label">{{ $t('update.latestVersion') }}</span>
        <span class="info-value">{{ store.appLatestVersionText }}</span>
      </div>
      <div class="info-row">
        <span class="info-label">{{ $t('update.publishedAt') }}</span>
        <span class="info-value">{{ store.appPublishedAtText }}</span>
      </div>
    </div>
    <div class="release-notes-wrapper">
      <div class="release-notes-title">{{ $t('update.releaseNotes') }}</div>
      <div class="release-notes release-notes-structured">
        <template v-if="store.appErrorMsg">{{ store.appErrorMsg }}</template>
        <a
          v-else-if="store.appReleaseNotesUrl"
          href="#"
          class="release-notes-link"
          @click.prevent="openReleaseNotes(store.appReleaseNotesUrl)"
        >{{ $t('update.viewReleaseNotesLink') }}</a>
      </div>
    </div>
    <button
      v-show="!store.updateNowHidden"
      class="btn btn-primary"
      @click="onUpdateNow"
    >{{ $t('update.updateNow') }}</button>
    <div v-show="store.downloadVisible" class="download-progress-container">
      <div class="progress-info">
        <span class="download-status">{{ store.downloadStatus || $t('update.downloading') }}</span>
        <span class="download-size">{{ store.downloadSizeText }}</span>
      </div>
      <div class="progress-bar-wrapper">
        <div class="progress-bar" :style="{ width: store.progressBarWidth }"></div>
      </div>
      <button
        class="btn btn-secondary btn-cancel-download"
        :disabled="store.cancelDisabled"
        @click="onCancelDownload"
      >{{ $t('update.cancelDownload') }}</button>
    </div>
  </section>

  <section v-show="store.modelAreaVisible" class="update-section">
    <h2>{{ $t('update.modelUpdateAreaTitle') }}</h2>
    <ul class="model-update-list">
      <li v-if="store.modelErrorMsg" class="model-error">{{ store.modelErrorMsg }}</li>
      <li v-for="entry in store.modelEntries" :key="entry.key">
        <span class="model-name">{{ entry.name }}</span>
        <span class="model-version">{{ entry.versionText }}</span>
      </li>
    </ul>
    <div v-show="store.modelNotesVisible" class="release-notes-wrapper">
      <div class="release-notes-title">{{ $t('update.releaseNotes') }}</div>
      <div class="release-notes release-notes-structured">
        <a
          v-if="store.modelReleaseNotesUrl"
          href="#"
          class="release-notes-link"
          @click.prevent="openReleaseNotes(store.modelReleaseNotesUrl)"
        >{{ $t('update.viewReleaseNotesLink') }}</a>
      </div>
    </div>
    <button class="btn btn-primary" @click="onOpenModelDownload">{{ $t('update.openModelDownload') }}</button>
  </section>

  <footer class="actions">
    <button
      v-show="!store.skipVersionHidden"
      class="btn btn-secondary"
      @click="onSkipVersion"
    >{{ $t('update.skipVersion') }}</button>
    <button
      v-show="!store.dontRemindHidden"
      class="btn btn-secondary"
      @click="onDontRemind"
    >{{ $t('update.dontRemind') }}</button>
    <button class="btn btn-primary" @click="onClose">{{ $t('update.close') }}</button>
  </footer>

  <div class="toast" v-show="store.toastVisible">{{ store.toastMessage }}</div>
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue';
import { useUpdateNotificationStore } from './store.js';
import { t, getLocale } from '../../../i18n/index.js';
import { initWindowTheme } from '../../../themes/themeInit.js';

// CSS the vanilla JS imported — keep the global styles identical.
import '../../../common.css';
import '../../../updateNotification.css';

const store = useUpdateNotificationStore();

// Cleanup arrays for IPC listeners and theme subscriptions.
const themeCleanups = [];
const ipcCleanups = [];

// ----- Release notes link (opened in external browser via the update API) -----
function openReleaseNotes(url) {
  const api = window.electronAPI && window.electronAPI.updateAPI;
  if (api) api.openDownloadPage(url);
}

// ----- Button handlers (moved verbatim from wireButtons / wireDownloadHandlers) -----

// "Update Now" — starts an in-app installer download with a progress bar
// instead of opening the browser to GitHub.
async function onUpdateNow() {
  const api = window.electronAPI && window.electronAPI.updateAPI;
  if (!api) return;
  const app = store.app;
  if (!app || !app.downloadUrl) {
    store.showToast(t('update.networkError'));
    return;
  }
  store.showDownloadProgress();
  try {
    const result = await api.downloadInstaller(app.downloadUrl, app.latestVersion);
    // Success: the 'download-complete' event handler will trigger the installer.
    // If the IPC returns success:false without an event (rare), surface the error.
    if (result && result.success === false && result.error !== 'cancelled') {
      store.hideDownloadProgress();
      store.restoreUpdateNowOnly();
      const msg =
        result.error === 'download_in_progress'
          ? t('update.downloadInProgress')
          : t('update.downloadFailed');
      store.showToast(msg);
    }
  } catch (err) {
    console.error('[UpdateNotification] downloadInstaller failed:', err);
    store.hideDownloadProgress();
    store.restoreUpdateNowOnly();
    store.showToast(t('update.downloadFailed'));
  }
}

async function onCancelDownload() {
  const api = window.electronAPI && window.electronAPI.updateAPI;
  try {
    if (api) await api.cancelDownload();
  } catch (err) {
    console.error('[UpdateNotification] cancelDownload failed:', err);
  }
  store.hideDownloadProgress();
  store.restoreAllActionButtons();
  store.showToast(t('update.downloadCancelled'));
}

async function onOpenModelDownload() {
  try {
    await window.electronAPI.updateAPI.openModelDownload();
  } catch (err) {
    console.error('[UpdateNotification] openModelDownload failed:', err);
  }
  window.close();
}

async function onSkipVersion() {
  const version = store.app && store.app.latestVersion;
  if (!version) return;
  try {
    await window.electronAPI.updateAPI.skipVersion(version);
  } catch (err) {
    console.error('[UpdateNotification] skipVersion failed:', err);
  }
  window.close();
}

async function onDontRemind() {
  try {
    await window.electronAPI.updateAPI.dontRemind();
  } catch (err) {
    console.error('[UpdateNotification] dontRemind failed:', err);
  }
  window.close();
}

function onClose() {
  window.close();
}

// ----- Lifecycle: wire IPC listeners (equivalent to onDOMContentLoaded) -----
onMounted(() => {
  // Mirror the vanilla JS initI18n().then() side effects.
  document.documentElement.lang = getLocale();
  document.title = t('update.title');

  // Apply saved theme; push cleanups for onUnmounted.
  initWindowTheme(themeCleanups);

  const api = window.electronAPI && window.electronAPI.updateAPI;
  if (!api) {
    console.error('[UpdateNotification] updateAPI is not available');
    return;
  }

  // Register IPC listener for notification data pushed by the main process.
  if (typeof api.onNotificationShow === 'function') {
    const cleanup = api.onNotificationShow((data) => store.render(data));
    if (cleanup) ipcCleanups.push(cleanup);
  } else {
    console.error('[UpdateNotification] updateAPI.onNotificationShow is not available');
  }

  // Main process pushes progress updates while the installer downloads.
  const progressCleanup = api.onDownloadProgress((data) => {
    store.setProgress(data.percent, data.received, data.total);
  });
  if (progressCleanup) ipcCleanups.push(progressCleanup);

  // When the download completes, automatically launch the installer.
  // The main process spawns the installer detached and quits the app.
  const completeCleanup = api.onDownloadComplete(async (data) => {
    store.setProgress(100, data.size, data.size);
    store.setDownloadStatus(t('update.downloadComplete'));
    store.setCancelDisabled(true);
    try {
      const res = await api.installInstaller(data.filePath);
      if (res && res.success === false) {
        store.setDownloadStatus(t('update.installFailed'));
        store.setCancelDisabled(false);
        store.showToast(t('update.installFailed'));
      } else {
        // App will quit shortly; show a transient status.
        store.setDownloadStatus(t('update.startingInstaller'));
      }
    } catch (err) {
      console.error('[UpdateNotification] installInstaller failed:', err);
      store.setDownloadStatus(t('update.installFailed'));
      store.setCancelDisabled(false);
      store.showToast(t('update.installFailed'));
    }
  });
  if (completeCleanup) ipcCleanups.push(completeCleanup);

  // Surface download errors (non-cancel) with a toast and reset the UI.
  const errorCleanup = api.onDownloadError((data) => {
    console.error('[UpdateNotification] download error:', data && data.error);
    store.hideDownloadProgress();
    store.restoreAllActionButtons();
    store.showToast(t('update.downloadFailed'));
  });
  if (errorCleanup) ipcCleanups.push(errorCleanup);
});

onUnmounted(() => {
  // Tear down IPC listeners registered in onMounted.
  for (const cleanup of ipcCleanups) {
    try {
      cleanup();
    } catch (_) {}
  }
  ipcCleanups.length = 0;

  // Tear down theme subscriptions.
  for (const cleanup of themeCleanups) {
    try {
      cleanup();
    } catch (_) {}
  }
  themeCleanups.length = 0;
});
</script>

<style>
/*
 * The Vue app mounts into #app. The original layout used <body> as the flex
 * column container for the header / sections / footer; with the mount point
 * in place, #app must take over that role so the footer still pins to the
 * bottom (margin-top: auto) and the page fills the viewport.
 */
#app {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
</style>
