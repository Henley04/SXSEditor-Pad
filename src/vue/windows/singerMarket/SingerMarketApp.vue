<!--
  SingerMarketApp.vue — full Vue 3 migration of src/singerMarket.js.

  Replaces the entire static HTML body of singerMarket.html. All UI markup
  (toolbar, search/filter bar, singer grid, pagination, auth/upload/detail
  dialogs, toast stack) lives in this template; all logic (login/register,
  debounced search, tag toggle, pagination, upload, detail+download, toasts)
  lives in <script setup>. The Pinia store at ./store.js owns the reactive
  domain state + IPC actions; this component owns dialog visibility flags
  and raw input field values.
-->
<template>
  <!-- Top toolbar -->
  <div id="toolbar">
    <div class="toolbar-group">
      <span id="page-title">{{ $t('singerMarket.title') }}</span>
    </div>
    <div class="toolbar-spacer"></div>
    <div class="toolbar-group" id="auth-area">
      <span id="auth-status" class="auth-status">{{ authStatusText }}</span>
      <button v-if="!store.user" id="btn-login" @click="openAuthDialog('login')">{{ $t('singerMarket.login') }}</button>
      <button v-if="!store.user" id="btn-register" @click="openAuthDialog('register')">{{ $t('singerMarket.register') }}</button>
      <button v-if="store.user" id="btn-logout" @click="onLogout">{{ $t('singerMarket.logout') }}</button>
    </div>
    <div class="toolbar-divider"></div>
    <div class="toolbar-group">
      <button id="btn-refresh" :disabled="refreshing" @click="onRefresh">
        <Icon name="refresh" :size="14" />
        {{ $t('singerMarket.refresh') }}
      </button>
      <button v-if="store.user" id="btn-upload" @click="openUploadDialog">
        <Icon name="upload" :size="14" />
        {{ $t('singerMarket.upload') }}
      </button>
    </div>
  </div>

  <!-- Search + filters bar -->
  <div id="filter-bar">
    <div class="search-wrap">
      <span class="search-icon"><Icon name="search" :size="14" /></span>
      <input
        type="text"
        id="search-input"
        v-model="searchInput"
        :placeholder="$t('singerMarket.searchPlaceholder')"
        @input="onSearchInput"
      />
    </div>
    <div class="filter-chips">
      <div v-for="tag in store.activeTags" :key="tag" class="filter-chip">
        <span>{{ tag }}</span>
        <button
          class="filter-chip-remove"
          :title="$tOr('singerMarket.removeTag', 'Remove tag')"
          @click="store.toggleActiveTag(tag); reloadList()"
        >×</button>
      </div>
    </div>
    <div class="filter-spacer"></div>
    <div class="tag-filter-wrap">
      <span class="filter-label">{{ $t('singerMarket.tags') }}</span>
      <div class="tag-suggestions">
        <div
          v-for="tag in popularTagSuggestions"
          :key="tag"
          class="tag-chip"
          :class="{ active: store.activeTags.includes(tag) }"
          @click="store.toggleActiveTag(tag); reloadList()"
        >{{ tag }}</div>
      </div>
    </div>
  </div>

  <!-- Main content -->
  <div id="main-content">
    <div id="singer-grid" class="singer-grid">
      <div v-if="store.singers.length === 0 && !store.loading" class="empty-state">
        <div class="empty-icon"><Icon name="microphone" :size="48" /></div>
        <div class="empty-text">{{ $t('singerMarket.emptyState') }}</div>
      </div>
      <div
        v-for="singer in store.singers"
        :key="singer.id"
        class="singer-card"
        @click="openDetailDialog(singer)"
      >
        <div class="singer-card-header">
          <div class="singer-avatar" :style="{ background: colorFromString(singerName(singer)) }">{{ singerInitial(singer) }}</div>
          <div class="singer-info">
            <div class="singer-name">{{ singerName(singer) }}</div>
            <div class="singer-meta">{{ formatBytes(singer.size) }} · {{ formatDate(singer.created_at || singer.uploaded_at) }}</div>
          </div>
        </div>
        <div class="singer-description">{{ singer.description || $tOr('singerMarket.noDescription', 'No description') }}</div>
        <div class="singer-tags">
          <span
            v-for="tag in (Array.isArray(singer.tags) ? singer.tags : []).slice(0, 4)"
            :key="tag"
            class="singer-tag"
          >{{ tag }}</span>
        </div>
      </div>
    </div>
    <div v-if="store.loading" id="loading-state" class="loading-state">
      <div class="spinner"></div>
      <div class="loading-text">{{ $t('singerMarket.loading') }}</div>
    </div>
  </div>

  <!-- Pagination -->
  <div v-if="store.totalPages > 1" id="pagination" class="pagination">
    <button id="btn-prev-page" :disabled="store.page <= 1" @click="onPrevPage">{{ $t('singerMarket.prevPage') }}</button>
    <span id="page-info" class="page-info">{{ store.page }} / {{ store.totalPages }}</span>
    <button id="btn-next-page" :disabled="store.page >= store.totalPages" @click="onNextPage">{{ $t('singerMarket.nextPage') }}</button>
  </div>

  <!-- Auth (login / register) dialog -->
  <div v-if="authDialogVisible" class="modal-overlay" @click.self="closeAuthDialog">
    <div class="modal-dialog">
      <div class="modal-title">
        {{ store.authMode === 'register'
          ? $tOr('singerMarket.registerTitle', 'Register')
          : $tOr('singerMarket.loginTitle', 'Login') }}
      </div>
      <div class="form-group">
        <label for="auth-username">{{ $t('singerMarket.username') }}</label>
        <input
          type="text"
          id="auth-username"
          v-model="authUsername"
          autocomplete="username"
          ref="authUsernameRef"
          @keydown.enter="focusAuthPassword"
        />
      </div>
      <div class="form-group">
        <label for="auth-password">{{ $t('singerMarket.password') }}</label>
        <input
          type="password"
          id="auth-password"
          v-model="authPassword"
          autocomplete="current-password"
          ref="authPasswordRef"
          @keydown.enter="submitAuth"
        />
      </div>
      <div v-if="authError" class="modal-hint" id="auth-error">{{ authError }}</div>
      <div class="modal-actions">
        <button id="btn-auth-cancel" class="btn-secondary" @click="closeAuthDialog">{{ $tOr('common.cancel', 'Cancel') }}</button>
        <button id="btn-auth-submit" class="btn-primary" :disabled="authSubmitting" @click="submitAuth">{{ $tOr('singerMarket.submit', 'Submit') }}</button>
      </div>
    </div>
  </div>

  <!-- Upload dialog -->
  <div v-if="uploadDialogVisible" class="modal-overlay" @click.self="closeUploadDialog">
    <div class="modal-dialog modal-dialog-wide">
      <div class="modal-title">{{ $tOr('singerMarket.uploadTitle', 'Upload Singer to Market') }}</div>
      <div
        class="upload-area"
        :class="{ dragover: uploadDragover }"
        @click="onPickUploadFile"
        @dragover.prevent="uploadDragover = true"
        @dragleave="uploadDragover = false"
        @drop.prevent="onUploadDrop"
      >
        <div class="upload-icon"><Icon name="music" :size="32" /></div>
        <div class="upload-text">{{ $tOr('singerMarket.uploadDropText', 'Click or drag a .sxssinger file here') }}</div>
      </div>
      <div v-if="store.uploadFile" class="upload-info">
        <div class="info-row">
          <span class="info-label">{{ $tOr('singerMarket.fileName', 'File') }}</span>
          <span class="info-value">{{ store.uploadFile.filename }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">{{ $tOr('singerMarket.singerName', 'Singer Name') }}</span>
          <span class="info-value">{{ uploadSingerNameDisplay }}</span>
        </div>
      </div>
      <div class="form-group">
        <label for="upload-description">{{ $tOr('singerMarket.description', 'Description') }}</label>
        <textarea
          id="upload-description"
          rows="3"
          v-model="uploadDescription"
          :placeholder="$tOr('singerMarket.descriptionPlaceholder', 'Describe this singer...')"
        ></textarea>
      </div>
      <div class="form-group">
        <label for="upload-tags">{{ $tOr('singerMarket.tagsLabel', 'Tags (comma-separated)') }}</label>
        <input type="text" id="upload-tags" v-model="uploadTags" placeholder="vocal, female, pop..." />
      </div>
      <div class="form-group">
        <label for="upload-visibility">{{ $tOr('singerMarket.visibility', 'Visibility') }}</label>
        <select id="upload-visibility" v-model="uploadVisibility">
          <option value="public">{{ $tOr('singerMarket.public', 'Public') }}</option>
          <option value="private">{{ $tOr('singerMarket.private', 'Private') }}</option>
        </select>
      </div>
      <div class="modal-actions">
        <button id="btn-upload-cancel" class="btn-secondary" @click="closeUploadDialog">{{ $tOr('common.cancel', 'Cancel') }}</button>
        <button id="btn-upload-submit" class="btn-primary" :disabled="uploadSubmitting" @click="submitUpload">{{ $tOr('singerMarket.upload', 'Upload') }}</button>
      </div>
    </div>
  </div>

  <!-- Singer detail + download dialog -->
  <div v-if="detailDialogVisible" class="modal-overlay" @click.self="closeDetailDialog">
    <div class="modal-dialog modal-dialog-wide">
      <div class="modal-title">{{ detailTitle }}</div>
      <div class="detail-body">
        <div class="detail-header">
          <div class="detail-avatar" :style="{ background: colorFromString(detailTitle) }">{{ detailTitle.charAt(0).toUpperCase() }}</div>
          <div class="detail-info">
            <div class="detail-name">{{ detailTitle }}</div>
            <div class="detail-meta">
              <span class="detail-meta-item"><strong>{{ $tOr('singerMarket.size', 'Size') }}:</strong> {{ formatBytes(detailData.size) }}</span>
              <span class="detail-meta-item"><strong>{{ $tOr('singerMarket.uploaded', 'Uploaded') }}:</strong> {{ formatDate(detailData.created_at || detailData.uploaded_at) }}</span>
              <span class="detail-meta-item"><strong>{{ $tOr('singerMarket.owner', 'Owner') }}:</strong> {{ detailOwner }}</span>
              <span class="detail-meta-item"><strong>{{ $tOr('singerMarket.visibilityLabel', 'Visibility') }}:</strong> {{ detailVisibility }}</span>
            </div>
          </div>
        </div>
        <div v-if="Array.isArray(detailData.tags) && detailData.tags.length > 0">
          <div class="detail-section-title">{{ $tOr('singerMarket.tags', 'Tags') }}</div>
          <div class="detail-tags">
            <span v-for="tag in detailData.tags" :key="tag" class="singer-tag">{{ tag }}</span>
          </div>
        </div>
        <div>
          <div class="detail-section-title">{{ $tOr('singerMarket.description', 'Description') }}</div>
          <div class="detail-description">{{ detailData.description || $tOr('singerMarket.noDescription', 'No description') }}</div>
        </div>
      </div>
      <div class="disclaimer-box">
        <div class="disclaimer-icon"><Icon name="info" :size="18" /></div>
        <div class="disclaimer-text">
          This Singer file is licensed to you by its owner. SXSEditor is not responsible for, nor does it grant any licenses to, third-party singers. For details, see
          <a :href="disclaimerUrl" target="_blank" rel="noopener">official website</a>.
        </div>
      </div>
      <div class="modal-actions">
        <button id="btn-detail-cancel" class="btn-secondary" @click="closeDetailDialog">{{ $tOr('common.cancel', 'Cancel') }}</button>
        <button id="btn-detail-download" class="btn-primary" :disabled="downloadSubmitting" @click="onDownload">{{ $tOr('singerMarket.download', 'Download') }}</button>
      </div>
    </div>
  </div>

  <!-- Toast notifications -->
  <div class="toast-container">
    <div
      v-for="toast in store.toasts"
      :key="toast.id"
      class="toast"
      :class="toast.type"
    >{{ toast.message }}</div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { useSingerMarketStore, DISCLAIMER_URL } from './store.js';
import { initWindowTheme } from '../../../themes/themeInit.js';
import { tOr } from '../../../i18n/index.js';

// Pull in the CSS the vanilla-JS bootstrap imported so the existing
// #toolbar / .singer-card / .modal-overlay / .toast styles still apply.
import '../../../common.css';
import '../../../singerMarket.css';

const store = useSingerMarketStore();
const disclaimerUrl = DISCLAIMER_URL;

// ==================== Component-local UI state ====================
// Dialog visibility flags (modal mount/unmount via v-if).
const authDialogVisible = ref(false);
const uploadDialogVisible = ref(false);
const detailDialogVisible = ref(false);

// Auth dialog form fields
const authUsername = ref('');
const authPassword = ref('');
const authError = ref('');
const authSubmitting = ref(false);
const authUsernameRef = ref(null);
const authPasswordRef = ref(null);

// Upload dialog form fields + drag state
const uploadDescription = ref('');
const uploadTags = ref('');
const uploadVisibility = ref('public');
const uploadDragover = ref(false);
const uploadSubmitting = ref(false);

// Detail dialog rendered data (merged singer + fileDetail response)
const detailTitle = ref('Singer');
const detailData = ref({});
const downloadSubmitting = ref(false);

// Search input + debounce timer
const searchInput = ref('');
let _searchDebounceTimer = null;

// Refresh button locked state (separate from store.loading so a tags-only
// refresh can still disable the button).
const refreshing = ref(false);

// ==================== Computed ====================
const authStatusText = computed(() =>
  store.user
    ? tOr('singerMarket.loggedInAs', 'Logged in as {name}', { name: store.user.username })
    : tOr('singerMarket.notLoggedIn', 'Not logged in')
);

const popularTagSuggestions = computed(() => store.tags.slice(0, 15));

const uploadSingerNameDisplay = computed(() => {
  const f = store.uploadFile;
  if (!f) return '';
  return f.singerName || f.filename.replace(/\.sxssinger$/i, '');
});

const detailOwner = computed(() => {
  const v = detailData.value.owner || detailData.value.user_id;
  return v == null || v === '' ? '-' : String(v);
});

const detailVisibility = computed(() => detailData.value.visibility || 'public');

// ==================== i18n helpers ====================
// `tOr` is imported from ../../../i18n/index.js (the same module the
// i18n Vue plugin wraps). Templates use the $t / $tOr global properties
// installed by the plugin; script uses these direct imports.

// ==================== Pure display helpers ====================
function colorFromString(str) {
  if (!str) str = '';
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 60%, 50%)`;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(isoString) {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch (_) {
    return isoString;
  }
}

function singerName(singer) {
  if (!singer) return '';
  return singer.filename?.replace(/\.sxssinger$/i, '')
    || singer.description?.split('\n')[0]
    || `Singer #${(singer.id || '').slice(0, 8)}`;
}

function singerInitial(singer) {
  return singerName(singer).charAt(0).toUpperCase();
}

// ==================== Auth dialog ====================
function openAuthDialog(mode) {
  store.authMode = mode;
  authUsername.value = '';
  authPassword.value = '';
  authError.value = '';
  authDialogVisible.value = true;
  nextTick(() => {
    authUsernameRef.value && authUsernameRef.value.focus();
  });
}

function closeAuthDialog() {
  authDialogVisible.value = false;
}

function focusAuthPassword() {
  authPasswordRef.value && authPasswordRef.value.focus();
}

async function submitAuth() {
  const username = authUsername.value.trim();
  const password = authPassword.value;
  if (!username || !password) {
    authError.value = tOr('singerMarket.fillAllFields', 'Please fill in all fields');
    return;
  }
  authSubmitting.value = true;
  try {
    const result = store.authMode === 'register'
      ? await store.register(username, password)
      : await store.login(username, password);
    if (result && result.success) {
      closeAuthDialog();
      await store.refreshAuthState();
      store.showToast(
        store.authMode === 'register'
          ? tOr('singerMarket.registerSuccess', 'Registration successful')
          : tOr('singerMarket.loginSuccess', 'Login successful'),
        'success'
      );
      await store.loadSingers();
    } else {
      authError.value = (result && result.error) || tOr('singerMarket.authFailed', 'Authentication failed');
    }
  } catch (err) {
    authError.value = (err && err.message) || String(err);
  } finally {
    authSubmitting.value = false;
  }
}

async function onLogout() {
  await store.logout();
  await store.refreshAuthState();
  store.showToast(tOr('singerMarket.loggedOut', 'Logged out'), 'info');
  await store.loadSingers();
}

// ==================== Search + filter ====================
function onSearchInput() {
  clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(() => {
    store.setSearchQuery(searchInput.value.trim());
    store.loadSingers();
  }, 350);
}

function reloadList() {
  store.loadSingers();
}

// ==================== Pagination ====================
function onPrevPage() {
  if (store.prevPage()) store.loadSingers();
}

function onNextPage() {
  if (store.nextPage()) store.loadSingers();
}

// ==================== Refresh ====================
async function onRefresh() {
  refreshing.value = true;
  try {
    await Promise.all([store.loadSingers(), store.loadPopularTags()]);
    store.showToast(tOr('singerMarket.refreshed', 'Refreshed'), 'success');
  } finally {
    refreshing.value = false;
  }
}

// ==================== Upload dialog ====================
function openUploadDialog() {
  if (!store.user) {
    store.showToast(tOr('singerMarket.loginRequired', 'Please log in to upload'), 'error');
    return;
  }
  store.resetUploadFile();
  uploadDescription.value = '';
  uploadTags.value = '';
  uploadVisibility.value = 'public';
  uploadDragover.value = false;
  uploadDialogVisible.value = true;
}

function closeUploadDialog() {
  uploadDialogVisible.value = false;
}

async function onPickUploadFile() {
  await store.pickUploadFile();
}

async function onUploadDrop() {
  // Renderer cannot read arbitrary file paths from drag events due to
  // security restrictions; fall back to the native picker (matches the
  // original behavior).
  uploadDragover.value = false;
  await store.pickUploadFile();
}

async function submitUpload() {
  if (!store.uploadFile) {
    store.showToast(tOr('singerMarket.pickFileFirst', 'Please select a file first'), 'error');
    return;
  }
  uploadSubmitting.value = true;
  try {
    const result = await store.upload({
      filePath: store.uploadFile.path,
      description: uploadDescription.value.trim(),
      tags: uploadTags.value.trim(),
      visibility: uploadVisibility.value,
    });
    if (result && result.success) {
      store.showToast(tOr('singerMarket.uploadSuccess', 'Upload successful'), 'success');
      closeUploadDialog();
      await store.loadSingers();
      await store.loadPopularTags();
    } else {
      store.showToast(
        (result && result.error) || tOr('singerMarket.uploadFailed', 'Upload failed'),
        'error'
      );
    }
  } catch (err) {
    store.showToast((err && err.message) || String(err), 'error');
  } finally {
    uploadSubmitting.value = false;
  }
}

// ==================== Detail / download dialog ====================
async function openDetailDialog(singer) {
  store.setDetailSinger(singer);
  // Start with the list-row data so the dialog paints immediately.
  detailData.value = { ...singer };
  detailTitle.value = singerName(singer);
  detailDialogVisible.value = true;

  // Then merge in the richer fileDetail response (more metadata than the
  // list view) once it arrives.
  const detail = await store.fetchFileDetail(singer.id);
  if (detail) {
    // Only patch if the user hasn't closed the dialog in the meantime.
    if (!store.detailSinger) return;
    detailData.value = { ...singer, ...detail };
    detailTitle.value = singerName(detailData.value);
  }
}

function closeDetailDialog() {
  detailDialogVisible.value = false;
  store.clearDetailSinger();
}

async function onDownload() {
  const singer = store.detailSinger;
  if (!singer) return;
  downloadSubmitting.value = true;
  try {
    const result = await store.downloadSinger(singer);
    if (result.canceled) {
      // User canceled the save picker — keep the dialog open. No toast.
      return;
    }
    if (result.success) {
      store.showToast(
        tOr('singerMarket.downloadSuccess', 'Downloaded to {path}', { path: result.filePath }),
        'success'
      );
      closeDetailDialog();
    } else {
      store.showToast(
        result.error || tOr('singerMarket.downloadFailed', 'Download failed'),
        'error'
      );
    }
  } catch (err) {
    store.showToast((err && err.message) || String(err), 'error');
  } finally {
    downloadSubmitting.value = false;
  }
}

// ==================== Lifecycle ====================
const _cleanups = [];

onMounted(async () => {
  // Apply theme tokens + listen for theme changes (cleanup pushed to array).
  initWindowTheme(_cleanups);

  // Restore locale was already done by initI18n() in the entry; mirror the
  // original bootstrap's document lang + i18n hydration step.
  await store.refreshAuthState();
  await Promise.all([store.loadSingers(), store.loadPopularTags()]);
});

onUnmounted(() => {
  _cleanups.forEach((fn) => {
    try { fn && fn(); } catch (_) {}
  });
  clearTimeout(_searchDebounceTimer);
});
</script>

<style scoped>
/*
  Window-specific styles live in the globally-imported singerMarket.css
  (which targets #toolbar / .singer-card / .modal-overlay / .toast by id
  and class). Scoped styles here are intentionally empty — adding scoped
  styles would force a data-v-* attribute onto every element and break the
  id-based selectors in the global stylesheet.
*/
</style>
