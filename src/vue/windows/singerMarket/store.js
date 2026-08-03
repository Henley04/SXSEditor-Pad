/**
 * Singer Market Pinia store.
 *
 * Holds the reactive domain state for the singerMarket window: auth state,
 * the current page of singer items, pagination, search/filter, popular tags,
 * the upload form payload, the detail-dialog target, and the toast queue.
 * All singer-market IPC calls (login/register/logout/me/list/fileDetail/tags/
 * upload/download/pickFile/pickSavePath) live here as actions so the Vue
 * component stays focused on presentation + dialog visibility.
 *
 * Component-local UI state (dialog visibility flags, raw input field values)
 * stays as `ref()` inside the SingerMarketApp component; this store only owns
 * state that needs to survive dialog open/close or drive multiple template
 * bindings.
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

// Disclaimer link target — the legally controlling English version of the
// Singer Market Terms of Use (the Chinese translation is linked from that page).
export const DISCLAIMER_URL = 'https://henry04.github.io/SXSEditor/singer-market-terms-en.html';

// Monotonic toast id so v-for :key stays stable across rapid show/dismiss.
let _toastIdCounter = 0;

export const useSingerMarketStore = defineStore('singerMarket', () => {
  // ----- Auth -----
  // { id, username, is_admin } or null
  const user = ref(null);

  // ----- Singer list + pagination -----
  const singers = ref([]);
  const page = ref(1);
  const pageSize = ref(24);
  const totalCount = ref(0);
  const totalPages = ref(1);
  const loading = ref(false);

  // ----- Tags + filters -----
  const tags = ref([]);          // popular tag suggestions
  const activeTags = ref([]);    // user-selected tag filter
  const searchQuery = ref('');

  // ----- Auth dialog mode -----
  // 'login' | 'register'
  const authMode = ref('login');

  // ----- Upload dialog payload -----
  // { path, filename, singerName? } or null
  const uploadFile = ref(null);

  // ----- Detail dialog target -----
  // The singer row currently shown in the detail/download dialog, or null.
  const detailSinger = ref(null);

  // ----- Toasts -----
  // [{ id, message, type }]
  const toasts = ref([]);

  // ==================== Toast helpers ====================
  function showToast(message, type = 'info') {
    const id = ++_toastIdCounter;
    toasts.value.push({ id, message, type });
    // Match the original 3500ms lifetime; the toast-in CSS animation handles
    // the entrance. Removal is immediate (the original fade-out was decorative).
    setTimeout(() => removeToast(id), 3500);
  }

  function removeToast(id) {
    const idx = toasts.value.findIndex((t) => t.id === id);
    if (idx >= 0) toasts.value.splice(idx, 1);
  }

  // ==================== API wrappers ====================
  // Thin wrappers around window.electronAPI.singerMarket.* so actions read
  // cleanly and the component never touches the IPC surface directly.
  function api() {
    return window.electronAPI && window.electronAPI.singerMarket;
  }

  // ==================== Auth actions ====================
  async function refreshAuthState() {
    try {
      const result = await api().me();
      if (result && result.success && result.user) {
        user.value = result.user;
      } else {
        user.value = null;
      }
    } catch (_) {
      user.value = null;
    }
    return user.value;
  }

  async function login(username, password) {
    return api().login(username, password);
  }

  async function register(username, password) {
    return api().register(username, password);
  }

  async function logout() {
    try {
      await api().logout();
    } catch (_) {
      // Ignore — local state is cleared regardless.
    }
    user.value = null;
  }

  // ==================== Search + filter actions ====================
  function toggleActiveTag(tag) {
    const idx = activeTags.value.indexOf(tag);
    if (idx >= 0) {
      activeTags.value.splice(idx, 1);
    } else {
      activeTags.value.push(tag);
    }
    page.value = 1;
  }

  function setSearchQuery(q) {
    searchQuery.value = q;
    page.value = 1;
  }

  async function loadPopularTags() {
    try {
      const result = await api().tags({ limit: 30 });
      if (result && result.success && Array.isArray(result.data)) {
        // API may return either array of strings or array of { name, count }.
        tags.value = result.data
          .map((t) => (typeof t === 'string' ? t : (t.name || t.tag)))
          .filter(Boolean);
      }
    } catch (_) {
      // Non-fatal — tag suggestions are optional.
    }
  }

  // ==================== Singer list actions ====================
  async function loadSingers() {
    loading.value = true;
    try {
      const params = {
        page: page.value,
        limit: pageSize.value,
      };
      if (searchQuery.value) params.q = searchQuery.value;
      if (activeTags.value.length > 0) {
        params.tags = activeTags.value.slice();
        params.tag_mode = 'and';
      }
      const result = await api().list(params);
      if (result && result.success && result.data) {
        const data = result.data;
        singers.value = Array.isArray(data.items) ? data.items : [];
        totalCount.value = data.total || singers.value.length;
        totalPages.value = data.total_pages || Math.max(1, Math.ceil(totalCount.value / pageSize.value));
      } else {
        singers.value = [];
        totalCount.value = 0;
        totalPages.value = 1;
        if (result && result.error) showToast(result.error, 'error');
      }
    } catch (err) {
      singers.value = [];
      totalCount.value = 0;
      totalPages.value = 1;
      showToast(err.message || String(err), 'error');
    } finally {
      loading.value = false;
    }
  }

  function prevPage() {
    if (page.value > 1) {
      page.value--;
      return true;
    }
    return false;
  }

  function nextPage() {
    if (page.value < totalPages.value) {
      page.value++;
      return true;
    }
    return false;
  }

  // ==================== Upload actions ====================
  async function pickUploadFile() {
    const result = await api().pickFile();
    if (result && result.success) {
      await handleUploadFilePicked(result.filePath, result.filename);
      return true;
    }
    return false;
  }

  async function handleUploadFilePicked(filePath, filename) {
    uploadFile.value = { path: filePath, filename };
    // Try to read the singer name from the file. The file is a JSON
    // .sxssinger file; we read it and look for the singerName field.
    try {
      const buffer = await window.electronAPI.readFileBuffer(filePath);
      const text = new TextDecoder().decode(buffer);
      const parsed = JSON.parse(text);
      if (parsed.singerName) {
        uploadFile.value.singerName = parsed.singerName;
      }
    } catch (_) {
      // Singer name falls back to the filename stem in the component template.
    }
  }

  function resetUploadFile() {
    uploadFile.value = null;
  }

  async function upload(payload) {
    return api().upload(payload);
  }

  // ==================== Detail / download actions ====================
  async function fetchFileDetail(fileId) {
    try {
      const result = await api().fileDetail(fileId);
      if (result && result.success && result.data) {
        return result.data;
      }
    } catch (_) {}
    return null;
  }

  function setDetailSinger(singer) {
    detailSinger.value = singer;
  }

  function clearDetailSinger() {
    detailSinger.value = null;
  }

  async function downloadSinger(singer) {
    // Returns { success, filePath?, error? } — the component shows toasts.
    const suggestedName = singer.filename
      || `${(singer.description?.split('\n')[0] || 'singer').replace(/[^\w-]+/g, '_')}.sxssinger`;

    const pick = await api().pickSavePath(suggestedName);
    if (!pick || !pick.success) {
      // User canceled — keep the dialog open.
      return { success: false, canceled: true };
    }

    const dlResult = await api().download(singer.id);
    if (!dlResult || !dlResult.success) {
      return { success: false, error: (dlResult && dlResult.error) || null };
    }

    // The buffer is an ArrayBuffer from the main process; convert to a
    // Uint8Array view that the IPC marshal can transfer.
    const buf = dlResult.data.buffer;
    const saveResult = await window.electronAPI.saveFile(
      pick.filePath,
      new Uint8Array(buf)
    );
    if (saveResult && saveResult.success !== false) {
      return { success: true, filePath: pick.filePath };
    }
    return { success: false, error: (saveResult && saveResult.error) || null };
  }

  return {
    // State
    user,
    singers,
    page,
    pageSize,
    totalCount,
    totalPages,
    loading,
    tags,
    activeTags,
    searchQuery,
    authMode,
    uploadFile,
    detailSinger,
    toasts,
    // Toast actions
    showToast,
    removeToast,
    // Auth actions
    refreshAuthState,
    login,
    register,
    logout,
    // Search / filter actions
    toggleActiveTag,
    setSearchQuery,
    loadPopularTags,
    // Singer list actions
    loadSingers,
    prevPage,
    nextPage,
    // Upload actions
    pickUploadFile,
    resetUploadFile,
    upload,
    // Detail / download actions
    fetchFileDetail,
    setDetailSinger,
    clearDetailSinger,
    downloadSinger,
  };
});
