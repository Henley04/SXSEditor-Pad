/**
 * SXSEditor-Pad Tauri Bridge
 * 
 * Provides window.electronAPI compatibility layer using Tauri v2 APIs.
 * This bridges the gap between Electron's ipcRenderer.invoke/on pattern
 * and Tauri's invoke/listen pattern.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { save, open, message, ask } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile, readFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { open as openShell } from '@tauri-apps/plugin-shell';

// Event listeners storage
const _listeners = {};

function onEvent(channel, callback) {
  const unlistenPromise = listen(channel, (event) => {
    callback(event.payload);
  });
  const cleanup = () => {
    unlistenPromise.then(fn => fn && fn());
  };
  if (!_listeners[channel]) _listeners[channel] = [];
  _listeners[channel].push(cleanup);
  return cleanup;
}

function emitEvent(channel, payload) {
  emit(channel, payload);
}

// ==================== Tauri Bridge ====================
const tauriBridge = {
  // Dialog
  showSaveDialog: (options) => invoke('plugin:dialog|save', { ...options }),
  showOpenDialog: (options) => invoke('plugin:dialog|open', { ...options }),

  // File operations
  saveFile: (filePath, data) => invoke('save_file', { path: filePath, data }),
  readFile: (filePath) => invoke('read_file', { path: filePath }),
  readFileBuffer: (filePath) => invoke('read_file_buffer', { path: filePath }),
  fileExists: (filePath) => invoke('file_exists', { path: filePath }),
  authorizePath: (filePath) => Promise.resolve(true),

  // SVS Pipeline
  initSVSPipeline: () => invoke('svs:init'),
  synthesizeSVS: (data) => invoke('svs:synthesize', { data }),
  synthesizeMultiStreaming: (data) => invoke('svs:synthesizeMultiStreaming', { data }),
  disposeSVSPipeline: () => invoke('svs:dispose'),
  onSVSProgress: (callback) => onEvent('svs:progress', (data) => callback({ progress: data })),
  onSVSChunkAudio: (callback) => onEvent('svs:chunk-audio', callback),

  // Fragment SVS
  getFragmentSVSSampleRate: () => invoke('fragment-svs:getSampleRate'),
  initFragmentSVSPipeline: () => invoke('fragment-svs:init'),
  synthesizeFragmentSVS: async (data) => {
    const result = await invoke('fragment-svs:synthesize', { data });
    if (result.error) throw new Error(result.error);
    return result.data;
  },
  resolvePhonemes: (lyrics) => invoke('fragment-svs:resolvePhonemes', { lyrics }),
  disposeFragmentSVSPipeline: () => invoke('fragment-svs:dispose'),
  onFragmentSVSProgress: (callback) => onEvent('fragment-svs:progress', (data) => callback({ progress: data })),
  onFragmentSVSChunkAudio: (callback) => onEvent('fragment-svs:chunk-audio', callback),

  // Fragment Editor
  openFragmentEditor: (data) => invoke('openFragmentEditor', { data }),
  saveFragmentData: (fragmentId, data) => invoke('saveFragmentData', { fragmentId, data }),
  saveFragmentDataSync: (fragmentId, data) => invoke('saveFragmentData', { fragmentId, data }),
  getFragmentData: (fragmentId) => invoke('getFragmentData', { fragmentId }),
  closeFragmentEditor: (fragmentId) => invoke('fragment:close', { fragmentId }),
  closeAllFragmentEditors: () => invoke('fragment:closeAll'),
  onFragmentSaved: (callback) => onEvent('fragmentDataSaved', callback),
  onLoadFragment: (callback) => onEvent('loadFragment', callback),
  updateFragmentBounds: (fragmentId, data) => invoke('updateFragmentBounds', { fragmentId, data }),
  onFragmentBoundsChanged: (callback) => onEvent('fragmentBoundsChanged', callback),
  updateProjectSettings: (projectData) => invoke('updateProjectSettings', { projectData }),
  onProjectSettingsChanged: (callback) => onEvent('projectSettingsChanged', callback),
  openSingerCreator: () => invoke('openSingerCreator'),
  openSingerMarket: () => invoke('openSingerMarket'),
  saveSingerFile: (singerData) => invoke('saveSingerFile', { singerData }),
  onSingerCreatorSaveRequest: (callback) => onEvent('singer-creator:save-request', callback),
  onSingerCreatorSaveAsRequest: (callback) => onEvent('singer-creator:save-as-request', callback),
  onSingerCreated: (callback) => onEvent('singerCreated', callback),

  // Audio Preprocess
  openAudioPreprocess: (data) => invoke('openAudioPreprocess', { data }),
  sendPreprocessData: (data) => invoke('sendPreprocessData', { data }),
  onPreprocessDataSaved: (callback) => onEvent('preprocessDataSaved', callback),
  onLoadPreprocessData: (callback) => onEvent('loadPreprocessData', callback),

  // Model Directory
  getModelDir: () => invoke('get_model_dir'),

  // Pitch/MIDI extraction
  extractF0: (data) => invoke('extractF0:onnx', { data }),
  extractMidiRosvot: (data) => invoke('extractMidi:rosvot', { data }),
  extractF0BasicPitch: (data) => invoke('extractF0:basicPitch', { data }),
  importMidi: () => invoke('midi:import'),
  importMidiMultiTrack: () => invoke('midi:importMultiTrack'),
  resolvePath: (basePath, relativePath) => invoke('resolvePath', { basePath, relativePath }),
  getDirName: (filePath) => invoke('getDirName', { filePath }),
  showItemInFolder: (filePath) => invoke('show_item_in_folder', { path: filePath }),

  // Settings
  getDMLDevices: () => invoke('settings:getDMLDevices'),
  getHardwareStatus: () => invoke('settings:getHardwareStatus'),
  getCurrentHardware: () => invoke('settings:getCurrentHardware'),
  getVocoderChunkFramesInfo: () => invoke('settings:getVocoderChunkFramesInfo'),
  getVocoderChunkFramesTable: () => invoke('settings:getVocoderChunkFramesTable'),
  getSettings: () => invoke('get_settings'),
  saveSettings: (settings) => invoke('save_settings', { settings }),
  checkModels: () => invoke('settings:check-models'),
  getAppVersion: () => invoke('get_app_version'),
  validateDevices: () => invoke('settings:validateDevices'),

  // Audio
  getAudioDevices: () => invoke('audio:getDevices'),
  audioPlay: (audioData, options) => invoke('audio:play', { audioData, options }),
  audioStop: () => invoke('audio:stop'),
  audioGetPosition: () => invoke('audio:getPosition'),
  audioIsAvailable: () => invoke('audio:isAvailable'),
  onAudioEnded: (callback) => onEvent('audio:ended', callback),

  // Model Download
  onModelDownloadMissingFiles: (callback) => onEvent('model-download:missing-files', callback),
  onModelDownloadProgress: (callback) => onEvent('model-download:progress', callback),
  onModelDownloadFileStart: (callback) => onEvent('model-download:file-start', callback),
  onModelDownloadFileComplete: (callback) => onEvent('model-download:file-complete', callback),
  onModelDownloadComplete: (callback) => onEvent('model-download:complete', callback),
  onModelDownloadError: (callback) => onEvent('model-download:error', callback),
  onModelDownloadPrecision: (callback) => onEvent('model-download:precision', callback),
  onModelDownloadWindowClosed: (callback) => onEvent('model-download:window-closed', callback),
  onModelDownloadRevision: (callback) => onEvent('model-download:revision', callback),
  modelDownloadStart: (precision, revision) => invoke('model-download:start', { precision, revision }),
  modelDownloadCancel: () => invoke('model-download:cancel'),
  modelDownloadCheck: () => invoke('model-download:check'),
  modelDownloadChangeDir: () => invoke('model-download:change-dir'),
  modelDownloadGetDir: () => invoke('model-download:get-dir'),
  modelDownloadOpen: (precision) => invoke('model-download:open', { precision }),
  modelDownloadDeleteAndRecheck: (precision) => invoke('model-download:delete-and-recheck', { precision }),
  modelDownloadRecheck: (precision) => invoke('model-download:recheck', { precision }),
  modelDownloadCheckJp: (precision) => invoke('model-download:check-jp', { precision }),
  modelDownloadStartJp: (precision, revision) => invoke('model-download:start-jp', { precision, revision }),
  modelDownloadCheckJpExists: () => invoke('model-download:check-jp-exists'),
  modelDownloadCheckSifigan: () => invoke('model-download:check-sifigan'),
  modelDownloadStartSifigan: (revision) => invoke('model-download:start-sifigan', { revision }),
  modelDownloadUnloadSifigan: () => invoke('model-download:unload-sifigan'),
  modelDownloadCheckVersion: (precision) => invoke('model-download:check-version', { precision }),
  modelDownloadCheckJpVersion: (precision) => invoke('model-download:check-jp-version', { precision }),
  modelDownloadCheckSifiganVersion: () => invoke('model-download:check-sifigan-version'),
  modelDownloadCheckAllVersions: (precision) => invoke('model-download:check-all-versions', { precision }),
  modelDownloadUpdate: (precision, revision) => invoke('model-download:update', { precision, revision }),
  modelDownloadUpdateJp: (precision, revision) => invoke('model-download:update-jp', { precision, revision }),
  modelDownloadUpdateSifigan: (revision) => invoke('model-download:update-sifigan', { revision }),
  modelDownloadListVersions: (precision) => invoke('model-download:list-versions', { precision }),
  modelDownloadListJpVersions: (precision) => invoke('model-download:list-jp-versions', { precision }),
  modelDownloadListSifiganVersions: () => invoke('model-download:list-sifigan-versions'),
  modelDownloadOpenExternal: (url) => invoke('model-download:open-external', { url }),

  // SVS JP Model
  svsCheckJpModels: () => invoke('svs:checkJpModels'),

  // Locale
  saveLocale: (locale) => invoke('save-locale', { locale }),
  getLocale: () => invoke('get-locale'),
  reloadMainWindow: () => invoke('reload-main-window'),
  onLocaleChanged: (callback) => onEvent('locale-changed', callback),

  // Window
  setDirty: (dirty) => invoke('set-dirty', { dirty }),
  onCloseConfirm: (callback) => onEvent('close-confirm', callback),
  closeConfirmed: () => invoke('close-confirmed'),
  onMainMenuSaveRequest: (callback) => onEvent('main-menu:save-request', callback),
  onMainMenuSaveAsRequest: (callback) => onEvent('main-menu:save-as-request', callback),

  // Resource Manager
  resmgrOpen: () => invoke('resmgr:open'),
  resmgrGetGPUInfo: () => invoke('resmgr:getGPUInfo'),
  resmgrGetModelGroups: () => invoke('resmgr:getModelGroups'),
  resmgrLoadModel: (groupId, modelId) => invoke('resmgr:loadModel', { groupId, modelId }),
  resmgrUnloadModel: (groupId, modelId) => invoke('resmgr:unloadModel', { groupId, modelId }),
  resmgrLoadGroup: (groupId) => invoke('resmgr:loadGroup', { groupId }),
  resmgrUnloadGroup: (groupId) => invoke('resmgr:unloadGroup', { groupId }),

  // WebNN / NPU API
  webnnDetectNPU: () => invoke('webnn:detectNPU'),
  webnnLoadModel: (modelId, modelPath, options) => invoke('webnn:loadModel', { modelId, modelPath, options }),
  webnnUnloadModel: (modelId) => invoke('webnn:unloadModel', { modelId }),
  webnnRunInference: (modelId, inputs) => invoke('webnn:runInference', { modelId, inputs }),
  webnnGetStatus: () => invoke('webnn:getStatus'),
  webnnReadModelFile: (filePath) => invoke('webnn:readModelFile', { filePath }),
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

  // Theme API
  themeAPI: {
    bootstrap: () => invoke('theme:bootstrap'),
    list: () => invoke('theme:list'),
    get: (themeId) => invoke('theme:get', { themeId }),
    current: (options) => invoke('theme:current', { options: options || {} }),
    apply: (themeId, options) => invoke('theme:apply', { themeId, options: options || {} }),
    save: (themeObj) => invoke('theme:save', { themeObj }),
    delete: (themeId) => invoke('theme:delete', { themeId }),
    import: () => invoke('theme:import'),
    export: (themeId) => invoke('theme:export', { themeId }),
    reset: () => invoke('theme:reset'),
    onChanged: (callback) => onEvent('theme:changed', callback),
    onListChanged: (callback) => onEvent('theme:list-changed', callback),
  },

  // Update API
  updateAPI: {
    checkNow: () => invoke('update:check-now'),
    getStatus: () => invoke('update:get-status'),
    skipVersion: (version) => invoke('update:skip-version', { version }),
    dontRemind: () => invoke('update:dont-remind'),
    openDownloadPage: (url) => invoke('update:open-download-page', { url }),
    openModelDownload: () => invoke('update:open-model-download'),
    downloadInstaller: (url, version) => invoke('update:download-installer', { url, version }),
    cancelDownload: () => invoke('update:cancel-download'),
    installInstaller: (filePath) => invoke('update:install-installer', { filePath }),
    onDownloadProgress: (callback) => onEvent('update:download-progress', callback),
    onDownloadComplete: (callback) => onEvent('update:download-complete', callback),
    onDownloadError: (callback) => onEvent('update:download-error', callback),
    onNotificationShow: (callback) => onEvent('update:notification-show', callback),
  },

  // Singer Market API
  singerMarket: {
    login: (username, password) => invoke('singer-market:login', { username, password }),
    register: (username, password) => invoke('singer-market:register', { username, password }),
    logout: () => invoke('singer-market:logout'),
    me: () => invoke('singer-market:me'),
    list: (params) => invoke('singer-market:list', { params }),
    fileDetail: (fileId) => invoke('singer-market:file-detail', { fileId }),
    tags: (params) => invoke('singer-market:tags', { params }),
    upload: (payload) => invoke('singer-market:upload', { payload }),
    download: (fileId) => invoke('singer-market:download', { fileId }),
    pickFile: () => invoke('singer-market:pick-file'),
    pickSavePath: (suggestedName) => invoke('singer-market:pick-save-path', { suggestedName }),
  },
};

// Export the bridge
window.electronAPI = tauriBridge;

export default tauriBridge;