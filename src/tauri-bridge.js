/**
 * SXSEditor-Pad Tauri Bridge
 *
 * Exposes `window.electronAPI` (kept under that name for renderer compatibility)
 * backed entirely by Tauri v2 APIs. There is no Electron here — every call maps
 * to a `#[tauri::command]` in src-tauri/src/lib.rs or a Tauri plugin.
 *
 * Command naming: Tauri commands are invoked by their snake_case Rust function
 * name, so this bridge translates the legacy camelCase / colon-separated
 * channel names used by the renderer into the registered snake_case commands.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { readFile } from '@tauri-apps/plugin-fs';
import * as spa from './spa/router.js';

// --------------------------- event helpers ---------------------------

const _listeners = {};

function onEvent(channel, callback) {
  const unlistenPromise = listen(channel, (event) => {
    callback(event.payload);
  });
  const cleanup = () => {
    unlistenPromise.then(fn => fn && fn()).catch(() => {});
  };
  if (!_listeners[channel]) _listeners[channel] = [];
  _listeners[channel].push(cleanup);
  return cleanup;
}

function emitEvent(channel, payload) {
  emit(channel, payload);
}

// --------------------------- Tauri bridge ---------------------------

const tauriBridge = {
  // Dialog (plugin passthrough)
  showSaveDialog: (options) => invoke('plugin:dialog|save', { options: options || {} }),
  showOpenDialog: (options) => invoke('plugin:dialog|open', { options: options || {} }),

  // File operations → Rust commands in lib.rs
  saveFile: (filePath, data) => invoke('save_file', { path: filePath, data }),
  readFile: (filePath) => invoke('read_file', { path: filePath }),
  readFileBuffer: (filePath) => invoke('read_file_buffer', { path: filePath }),
  fileExists: (filePath) => invoke('file_exists', { path: filePath }),
  authorizePath: () => Promise.resolve(true),

  // SVS pipeline (legacy main-process inference → stubs; renderer uses WebNN)
  initSVSPipeline: () => invoke('svs_init'),
  synthesizeSVS: (data) => invoke('svs_synthesize', { data }),
  synthesizeMultiStreaming: (data) => invoke('svs_synthesize_multi_streaming', { data }),
  disposeSVSPipeline: () => invoke('svs_dispose'),
  onSVSProgress: (callback) => onEvent('svs:progress', (data) => callback({ progress: data })),
  onSVSChunkAudio: (callback) => onEvent('svs:chunk-audio', callback),

  // Fragment SVS (legacy → stubs)
  getFragmentSVSSampleRate: () => invoke('fragment_svs_get_sample_rate'),
  initFragmentSVSPipeline: () => invoke('fragment_svs_init'),
  synthesizeFragmentSVS: async (data) => {
    const result = await invoke('fragment_svs_synthesize', { data });
    if (result && result.error) throw new Error(result.error);
    return result && result.data;
  },
  resolvePhonemes: (lyrics) => invoke('fragment_svs_resolve_phonemes', { lyrics }),
  disposeFragmentSVSPipeline: () => invoke('fragment_svs_dispose'),
  onFragmentSVSProgress: (callback) => onEvent('fragment-svs:progress', (data) => callback({ progress: data })),
  onFragmentSVSChunkAudio: (callback) => onEvent('fragment-svs:chunk-audio', callback),

  // Fragment editor persistence
  // SPA navigation + 信箱 + 事件: the fragment editor is now an in-WebView
  // view, not a separate BrowserWindow. `openFragmentEditor`:
  //   1. Persists the serializable {fragment, project} payload via the
  //      file-backed mailbox (`save_fragment_data`) so the target view can
  //      fetch it through `get_fragment_data` after the page loads.
  //   2. Stashes the non-serializable wavBuffer in the SPA mailbox
  //      (in-memory + sessionStorage base64 when it fits).
  //   3. Navigates to the fragment-editor view with `#fragmentId=…` so the
  //      view's `loadFragmentFromHash()` can pick the right payload.
  //   4. Emits a `spa:navigate` event (typed subscribers + DOM CustomEvent).
  openFragmentEditor: async (data) => {
    const fragmentId = data && data.fragment ? data.fragment.id : undefined;
    if (fragmentId !== undefined && fragmentId !== null) {
      try {
        await invoke('save_fragment_data', {
          fragmentId: String(fragmentId),
          data: { fragment: data.fragment, project: data.project },
        });
      } catch (e) {
        // File mailbox failure is non-fatal: the SPA mailbox still carries
        // the full payload for same-page handoff.
        console.warn('[bridge] saveFragmentData failed:', e);
      }
    }
    // SPA mailbox: carries the wavBuffer (and re-carries fragment/project for
    // same-page SPA where the file round-trip is unnecessary).
    spa.mailbox('fragment-editor', data);
    spa.navigate('fragment-editor', null, { fragmentId: fragmentId != null ? String(fragmentId) : '' });
  },
  saveFragmentData: (fragmentId, data) => invoke('save_fragment_data', { fragmentId, data }),
  saveFragmentDataSync: (fragmentId, data) => invoke('save_fragment_data', { fragmentId, data }),
  getFragmentData: (fragmentId) => invoke('get_fragment_data', { fragmentId }),
  closeFragmentEditor: (fragmentId) => invoke('fragment_close', { fragmentId }),
  closeAllFragmentEditors: () => invoke('fragment_close_all'),
  onFragmentSaved: (callback) => onEvent('fragmentDataSaved', callback),
  onLoadFragment: (callback) => onEvent('loadFragment', callback),
  updateFragmentBounds: (fragmentId, data) => invoke('update_fragment_bounds', { fragmentId, data }),
  onFragmentBoundsChanged: (callback) => onEvent('fragmentBoundsChanged', callback),
  updateProjectSettings: (projectData) => invoke('update_project_settings', { projectData }),
  onProjectSettingsChanged: (callback) => onEvent('projectSettingsChanged', callback),
  // SPA navigation for the remaining former child windows. Each call stashes
  // its payload in the SPA mailbox and navigates to the corresponding view;
  // the view's controller reads the payload back via `spa.consumeMail(route)`.
  openSingerCreator: () => spa.navigate('singer-creator'),
  openSingerMarket: () => spa.navigate('singer-market'),
  saveSingerFile: (singerData) => invoke('save_singer_file', { singerData }),
  onSingerCreatorSaveRequest: (callback) => onEvent('singer-creator:save-request', callback),
  onSingerCreatorSaveAsRequest: (callback) => onEvent('singer-creator:save-as-request', callback),
  onSingerCreated: (callback) => onEvent('singerCreated', callback),

  // Audio preprocess
  openAudioPreprocess: (data) => {
    spa.mailbox('audio-preprocess', data);
    return spa.navigate('audio-preprocess');
  },
  sendPreprocessData: (data) => invoke('send_preprocess_data', { data }),
  onPreprocessDataSaved: (callback) => onEvent('preprocessDataSaved', callback),
  onLoadPreprocessData: (callback) => onEvent('loadPreprocessData', callback),

  // Model directory
  getModelDir: () => invoke('get_model_dir'),

  // Pitch / MIDI extraction — renderer-native runners (dynamic import keeps
  // the inference chunks out of the initial bundle):
  //   RMVPE (ONNX)  → src/inference/native/rmvpeNative.js   (native ORT / ort-web)
  //   Basic Pitch   → src/inference/native/basicPitchNative.js (LiteRT / TF.js)
  //   Rosvot        → model not shipped in the INT8-NPU build; stub stays.
  extractF0: async (data) => {
    const { extractF0Native } = await import('./inference/native/rmvpeNative.js');
    return extractF0Native(data);
  },
  extractMidiRosvot: (data) => invoke('extract_midi_rosvot', { data }),
  extractF0BasicPitch: async (data) => {
    const { extractBasicPitchNative } = await import('./inference/native/basicPitchNative.js');
    return extractBasicPitchNative(data);
  },
  importMidi: () => invoke('midi_import'),
  importMidiMultiTrack: () => invoke('midi_import_multi_track'),
  resolvePath: (basePath, relativePath) => invoke('resolve_path', { basePath, relativePath }),
  getDirName: (filePath) => invoke('get_dir_name', { filePath }),
  showItemInFolder: (filePath) => invoke('show_item_in_folder', { path: filePath }),

  // Settings / hardware info
  getDMLDevices: () => invoke('settings_get_dml_devices'),
  getHardwareStatus: () => invoke('settings_get_hardware_status'),
  getCurrentHardware: () => invoke('settings_get_current_hardware'),
  getVocoderChunkFramesInfo: () => invoke('settings_get_vocoder_chunk_frames_info'),
  getVocoderChunkFramesTable: () => invoke('settings_get_vocoder_chunk_frames_table'),
  getSettings: () => invoke('get_settings'),
  saveSettings: (settings) => invoke('save_settings', { settings }),
  checkModels: (precision) => invoke('settings_check_models', { precision: precision || null }),
  getAppVersion: () => invoke('get_app_version'),
  validateDevices: () => invoke('settings_validate_devices'),

  // Audio (legacy → stubs; renderer uses WebAudio)
  getAudioDevices: () => invoke('audio_get_devices'),
  audioPlay: (audioData, options) => invoke('audio_play', { audioData, options: options || null }),
  audioStop: () => invoke('audio_stop'),
  audioGetPosition: () => invoke('audio_get_position'),
  audioIsAvailable: () => invoke('audio_is_available'),
  onAudioEnded: (callback) => onEvent('audio:ended', callback),

  // ---------------- Model download (INT8-NPU from ModelScope) ----------------
  onModelDownloadMissingFiles: (callback) => onEvent('model-download:missing-files', callback),
  onModelDownloadProgress: (callback) => onEvent('model-download:progress', callback),
  onModelDownloadFileStart: (callback) => onEvent('model-download:file-start', callback),
  onModelDownloadFileComplete: (callback) => onEvent('model-download:file-complete', callback),
  onModelDownloadComplete: (callback) => onEvent('model-download:complete', callback),
  onModelDownloadError: (callback) => onEvent('model-download:error', callback),
  onModelDownloadPrecision: (callback) => onEvent('model-download:precision', callback),
  onModelDownloadRevision: (callback) => onEvent('model-download:revision', callback),
  onModelDownloadWindowClosed: (callback) => onEvent('model-download:window-closed', callback),
  modelDownloadStart: (precision, revision) => invoke('model_download_start', { precision, revision }),
  modelDownloadCancel: () => invoke('model_download_cancel'),
  modelDownloadCheck: () => invoke('model_download_check'),
  modelDownloadChangeDir: () => invoke('model_download_change_dir'),
  modelDownloadGetDir: () => invoke('model_download_get_dir'),
  // SPA navigation: announce precision to the model-download view (was a Rust
  // emit) and switch to it. The view reads precision from the event / mailbox.
  modelDownloadOpen: (precision) => {
    emitEvent('model-download:precision', precision);
    spa.mailbox('model-download', { precision });
    return spa.navigate('model-download', null, { precision: precision || '' });
  },
  modelDownloadDeleteAndRecheck: (precision) => invoke('model_download_delete_and_recheck', { precision }),
  modelDownloadRecheck: (precision) => invoke('model_download_recheck', { precision }),
  modelDownloadCheckJp: (precision) => invoke('model_download_check_jp', { precision }),
  modelDownloadStartJp: (precision, revision) => invoke('model_download_start_jp', { precision, revision }),
  modelDownloadCheckJpExists: () => invoke('model_download_check_jp_exists'),
  modelDownloadCheckSifigan: () => invoke('model_download_check_sifigan'),
  modelDownloadStartSifigan: (revision) => invoke('model_download_start_sifigan', { revision }),
  modelDownloadUnloadSifigan: () => invoke('model_download_unload_sifigan'),
  modelDownloadCheckVersion: (precision) => invoke('model_download_check_version', { precision }),
  modelDownloadCheckJpVersion: (precision) => invoke('model_download_check_jp_version', { precision }),
  modelDownloadCheckSifiganVersion: () => invoke('model_download_check_sifigan_version'),
  modelDownloadCheckAllVersions: (precision) => invoke('model_download_check_all_versions', { precision }),
  modelDownloadUpdate: (precision, revision) => invoke('model_download_update', { precision, revision }),
  modelDownloadUpdateJp: (precision, revision) => invoke('model_download_update_jp', { precision, revision }),
  modelDownloadUpdateSifigan: (revision) => invoke('model_download_update_sifigan', { revision }),
  modelDownloadListVersions: (precision) => invoke('model_download_list_versions', { precision }),
  modelDownloadListJpVersions: (precision) => invoke('model_download_list_jp_versions', { precision }),
  modelDownloadListSifiganVersions: () => invoke('model_download_list_sifigan_versions'),
  modelDownloadOpenExternal: (url) => invoke('model_download_open_external', { url }),

  // SVS JP model check
  svsCheckJpModels: () => invoke('svs_check_jp_models'),

  // ---------------- Native inference (ORT Mobile / LiteRT) ----------------
  // The live SVS inference path: tensors are packed into binary frames by
  // src/inference/native/tensorCodec.js and executed by the Rust ORT engine.
  getPlatformInfo: () => invoke('get_platform_info'),
  nativeOrtInit: (libPath) => invoke('native_ort_init', { libPath: libPath || null }),
  nativeOrtDetectAccelerators: () => invoke('native_ort_detect_accelerators'),
  nativeOrtLoadModel: (modelId, modelPath, options) => invoke('native_ort_load_model', { modelId, modelPath, options: options || null }),
  nativeOrtUnloadModel: (modelId) => invoke('native_ort_unload_model', { modelId }),
  nativeOrtStatus: () => invoke('native_ort_status'),
  // Raw-frame fast path (desktop/iOS): bare Uint8Array → octet-stream body.
  nativeOrtRun: (frameBytes) => invoke('native_ort_run', frameBytes),
  // Android path: base64 JSON (avoids numeric-array serialization cost).
  nativeOrtRunB64: (frameB64) => invoke('native_ort_run_b64', { frameB64 }),
  nativeTfliteInit: (libPath) => invoke('native_tflite_init', { libPath: libPath || null }),
  nativeTfliteLoadModel: (modelId, modelPath, numThreads, useAccelerator) =>
    invoke('native_tflite_load_model', { modelId, modelPath, numThreads: numThreads || null, useAccelerator: useAccelerator ?? null }),
  nativeTfliteRun: (modelId, inputs) => invoke('native_tflite_run', { modelId, inputs }),
  nativeTfliteUnload: (modelId) => invoke('native_tflite_unload', { modelId }),
  nativeTfliteStatus: () => invoke('native_tflite_status'),
  nativeExportWav: (samplesB64, sampleRate, channels, bitsPerSample, path) =>
    invoke('native_export_wav', { samplesB64, sampleRate, channels, bitsPerSample, path }),
  nativeSha256File: (path) => invoke('native_sha256_file', { path }),

  // Locale
  saveLocale: (locale) => invoke('save_locale', { locale }),
  getLocale: () => invoke('get_locale'),
  reloadMainWindow: () => invoke('reload_main_window'),
  onLocaleChanged: (callback) => onEvent('locale-changed', callback),

  // Window / menu
  setDirty: (dirty) => invoke('set_dirty', { dirty }),
  onCloseConfirm: (callback) => onEvent('close-confirm', callback),
  closeConfirmed: () => invoke('close_confirmed'),
  onMainMenuSaveRequest: (callback) => onEvent('main-menu:save-request', callback),
  onMainMenuSaveAsRequest: (callback) => onEvent('main-menu:save-as-request', callback),

  // Resource manager — SPA navigation to the resource-manager view.
  resmgrOpen: () => spa.navigate('resource-manager'),
  resmgrGetGPUInfo: () => invoke('resmgr_get_gpu_info'),
  resmgrGetModelGroups: () => invoke('resmgr_get_model_groups'),
  resmgrLoadModel: (groupId, modelId) => invoke('resmgr_load_model', { groupId, modelId }),
  resmgrUnloadModel: (groupId, modelId) => invoke('resmgr_unload_model', { groupId, modelId }),
  resmgrLoadGroup: (groupId) => invoke('resmgr_load_group', { groupId }),
  resmgrUnloadGroup: (groupId) => invoke('resmgr_unload_group', { groupId }),

  // ---------------- WebNN / NPU ----------------
  // Inference runs in the renderer via onnxruntime-web. `webnnReadModelFile`
  // reads model bytes; for large files we prefer the fs plugin (returns a
  // Uint8Array directly, avoiding JSON serialization of a byte array).
  webnnDetectNPU: () => invoke('webnn_detect_npu'),
  webnnLoadModel: (modelId, modelPath, options) => invoke('webnn_load_model', { modelId, modelPath, options: options || null }),
  webnnUnloadModel: (modelId) => invoke('webnn_unload_model', { modelId }),
  webnnRunInference: (modelId, inputs) => invoke('webnn_run_inference', { modelId, inputs }),
  webnnGetStatus: () => invoke('webnn_get_status'),
  webnnReadModelFile: async (filePath) => {
    try {
      const bytes = await readFile(filePath);
      return { success: true, data: bytes.buffer };
    } catch (e) {
      // Fallback to the Rust command (handles paths outside the fs scope).
      try {
        const result = await invoke('webnn_read_model_file', { filePath });
        if (result && result.success && Array.isArray(result.data)) {
          return { success: true, data: new Uint8Array(result.data).buffer };
        }
        return result || { success: false, error: String(e) };
      } catch (e2) {
        return { success: false, error: e2.message || String(e2) };
      }
    }
  },
  onWebnnDetectNPURequest: (callback) => onEvent('webnn:detectNPU:request', callback),
  onWebnnLoadModelRequest: (callback) => onEvent('webnn:loadModel:request', callback),
  onWebnnUnloadModelRequest: (callback) => onEvent('webnn:unloadModel:request', callback),
  onWebnnRunInferenceRequest: (callback) => onEvent('webnn:runInference:request', callback),
  onWebnnGetStatusRequest: (callback) => onEvent('webnn:getStatus:request', callback),
  onWebnnRunSynthesisRequest: (callback) => onEvent('webnn:runSynthesis:request', callback),
  onWebnnPrefetchRequest: (callback) => onEvent('webnn:prefetch:request', callback),
  webnnRespond: (responseChannel, result) => emitEvent(responseChannel, result),
  webnnProgress: (progressChannel, data) => emitEvent(progressChannel, data),
  webnnChunk: (chunkChannel, data) => emitEvent(chunkChannel, data),

  // ---------------- Theme ----------------
  themeAPI: {
    bootstrap: () => invoke('theme_bootstrap'),
    list: () => invoke('theme_list'),
    get: (themeId) => invoke('theme_get', { themeId }),
    current: (options) => invoke('theme_current', { options: options || null }),
    apply: (themeId, options) => invoke('theme_apply', { themeId, options: options || null }),
    save: (themeObj) => invoke('theme_save', { themeObj }),
    delete: (themeId) => invoke('theme_delete', { themeId }),
    import: () => invoke('theme_import'),
    export: (themeId) => invoke('theme_export', { themeId }),
    reset: () => invoke('theme_reset'),
    onChanged: (callback) => onEvent('theme:changed', callback),
    onListChanged: (callback) => onEvent('theme:list-changed', callback),
  },

  // ---------------- Update ----------------
  updateAPI: {
    checkNow: () => invoke('update_check_now'),
    getStatus: () => invoke('update_get_status'),
    skipVersion: (version) => invoke('update_skip_version', { version }),
    dontRemind: () => invoke('update_dont_remind'),
    openDownloadPage: (url) => invoke('update_open_download_page', { url }),
    // SPA navigation: jump to the model-download view from the update notification.
    openModelDownload: () => spa.navigate('model-download'),
    downloadInstaller: (url, version) => invoke('update_download_installer', { url, version }),
    cancelDownload: () => invoke('update_cancel_download'),
    installInstaller: (filePath) => invoke('update_install_installer', { filePath }),
    onDownloadProgress: (callback) => onEvent('update:download-progress', callback),
    onDownloadComplete: (callback) => onEvent('update:download-complete', callback),
    onDownloadError: (callback) => onEvent('update:download-error', callback),
    onNotificationShow: (callback) => onEvent('update:notification-show', callback),
  },

  // ---------------- Singer market ----------------
  singerMarket: {
    login: (username, password) => invoke('singer_market_login', { username, password }),
    register: (username, password) => invoke('singer_market_register', { username, password }),
    logout: () => invoke('singer_market_logout'),
    me: () => invoke('singer_market_me'),
    list: (params) => invoke('singer_market_list', { params }),
    fileDetail: (fileId) => invoke('singer_market_file_detail', { fileId }),
    tags: (params) => invoke('singer_market_tags', { params }),
    upload: (payload) => invoke('singer_market_upload', { payload }),
    download: (fileId) => invoke('singer_market_download', { fileId }),
    pickFile: () => invoke('singer_market_pick_file'),
    pickSavePath: (suggestedName) => invoke('singer_market_pick_save_path', { suggestedName: suggestedName || null }),
  },

  // ---------------- SPA router (信箱 + 事件 + view navigation) ----------------
  // Exposed so views can consume their mailbox payload through the same
  // `window.electronAPI` surface they already use, without each view having
  // to import the router module directly. The fragment editor's loader, for
  // example, calls `electronAPI.spa.consumeMail('fragment-editor')` to pick
  // up the wavBuffer stashed by `openFragmentEditor`.
  spa: {
    navigate: (route, data, params) => spa.navigate(route, data, params),
    consumeMail: (route) => spa.consumeMail(route),
    peekMail: (route) => spa.peekMail(route),
    mailbox: (route, data) => spa.mailbox(route, data),
    onNavigate: (callback) => spa.onNavigate(callback),
    getCurrentRoute: () => spa.getCurrentRoute(),
    listRoutes: () => spa.listRoutes(),
    resolveRouteUrl: (route) => spa.resolveRouteUrl(route),
  },
};

// Export the bridge under the legacy `electronAPI` name so existing renderer
// code (`window.electronAPI.*`) works without modification. The implementation
// is 100% Tauri — there is no Electron runtime involved.
window.electronAPI = tauriBridge;

export default tauriBridge;
