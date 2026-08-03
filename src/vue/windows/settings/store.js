/**
 * settings Pinia store — reactive state for the Settings window.
 *
 * Owns ALL state + logic that previously lived in src/settings.js (2085 lines
 * of vanilla-JS bootstrap). State is organized by settings section
 * (language, theme, inference, preview-params, export-params, vocoder-chunk,
 * ort, audio, midi, model, update) plus the theme editor / save-as modal /
 * toast UI state. All IPC calls (window.electronAPI.*) and the debounced
 * save / load / hardware-detection / theme-editor flows live here as actions.
 */
import { defineStore } from 'pinia';
import { t, getLocale, setLocale } from '../../../i18n/index.js';
import {
  themeManager,
  TOKEN_CATALOG,
  BUILTIN_THEMES,
  computeIsDarkFromTokens as computeIsDark,
  validate,
  normalize,
} from '../../../themes/index.js';

// Model groups shown in the advanced device-mapping section.
export const MODEL_GROUPS = [
  { id: 'svsDiffusion', labelKey: 'settings.modelGroupSvsDiffusion' },
  { id: 'svsEncoder', labelKey: 'settings.modelGroupSvsEncoder' },
  { id: 'svsAuxiliary', labelKey: 'settings.modelGroupSvsAuxiliary' },
  { id: 'rmvpe', labelKey: 'settings.modelGroupRmvpe' },
  { id: 'rosvot', labelKey: 'settings.modelGroupRosvot' },
];

const PRECISION_LABELS = {
  'fp32': 'FP32',
  'fp16': 'FP16',
  'int8': 'INT8',
  'int8-npu': 'INT8-NPU',
};

// Module-level (non-reactive) caches & timers, mirroring the vanilla-JS
// module-scope `let` variables. Kept out of reactive state so storing a
// timer / promise does not perturb Vue's reactivity tracking.
let _saveDebounce = null;
let _editDebounce = null;
let _toastTimer = null;
let _vocoderChunkInfoLoaded = false;
let _currentVramGb = 0; // current GPU VRAM (GB), used to highlight the matching table row
const _cleanups = []; // IPC listener cleanup functions, flushed in destroy()

// ==================== Pure helper functions ====================
// (ported verbatim from settings.js so behavior is identical)

function getDeviceTypeLabel(deviceType) {
  switch (deviceType) {
    case 'discrete-gpu': return t('settings.discreteGpu');
    case 'integrated-gpu': return t('settings.integratedGpu');
    case 'npu': return t('settings.npuLabel');
    case 'webnn-gpu': return t('settings.webnnGpuDevice');
    case 'cpu': return t('settings.cpuLabel');
    default: return deviceType || '';
  }
}

function getDeviceOptionText(d) {
  const vramStr = d.vram ? ` (${d.vram})` : '';
  const typeStr = getDeviceTypeLabel(d.deviceType);
  const npuTag = d.deviceType === 'npu' ? ' [NPU(WebNN)]' : '';
  const webnnGpuTag = d.deviceType === 'webnn-gpu' ? ' [WebNN GPU]' : '';
  return `${d.name}${vramStr} ${typeStr}${npuTag}${webnnGpuTag}`;
}

/** Build the <option> value string for a device, matching the original select. */
function deviceOptionValue(d) {
  if (d.deviceType === 'npu') return 'npu';
  if (d.deviceType === 'webnn-gpu') return 'webnn-gpu';
  return String(d.dxgiAdapterNumber);
}

function toHexForColorInput(value) {
  if (typeof value !== 'string') return '#000000';
  const v = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    return '#' + v.slice(1).split('').map(c => c + c).join('');
  }
  if (/^#[0-9a-fA-F]{8}$/.test(v)) return v.slice(0, 7);
  const m = v.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map(s => parseFloat(s.trim()));
    if (parts.length >= 3) {
      const toHex = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
      return '#' + toHex(parts[0]) + toHex(parts[1]) + toHex(parts[2]);
    }
  }
  return '#000000';
}

function isValidThemeId(id) {
  return typeof id === 'string' && /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(id);
}

function getThemeDisplayName(meta) {
  if (!meta) return '';
  const key = `settings.theme.names.${meta.id}`;
  const localized = t(key);
  return localized !== key ? localized : (meta.name || meta.id);
}

function layerLabel(layer) {
  if (layer === 'global') return t('settings.theme.editor.layerGlobal');
  if (layer === 'alias') return t('settings.theme.editor.layerAlias');
  if (layer === 'component') return t('settings.theme.editor.layerComponent');
  return t('settings.theme.editor.layerCustom');
}

function resolveTokenValue(tokenName) {
  const cur = themeManager.currentTokens();
  if (cur && cur.tokens && Object.prototype.hasOwnProperty.call(cur.tokens, tokenName)) {
    return cur.tokens[tokenName];
  }
  return TOKEN_CATALOG[tokenName]?.default || '';
}

function _formatVersionLine(info) {
  if (!info) return '';
  const localRaw = info.localVersion;
  const localStr = (!localRaw || localRaw === 'master')
    ? t('settings.modelOverviewLegacyVersion')
    : localRaw;
  const latestStr = info.latestVersion || '-';
  if (!localRaw && !info.latestVersion) return '';
  return `${t('settings.modelOverviewVersionLocal', { version: localStr })}  ·  ${t('settings.modelOverviewVersionLatest', { version: latestStr })}`;
}

function _resolveOverviewState(info, opts = {}) {
  const { isDownloading = false } = opts;
  if (isDownloading) {
    return {
      dotState: 'checking',
      statusText: t('modelDownload.overviewDownloading'),
      versionText: '',
      statusClass: 'checking',
    };
  }
  if (!info) {
    return {
      dotState: 'checking',
      statusText: t('settings.modelOverviewChecking'),
      versionText: '',
      statusClass: 'checking',
    };
  }
  if (info.status === 'download_url_not_configured' || info.status === 'not_downloaded') {
    return { dotState: 'missing', statusText: t('settings.modelOverviewMissing'), versionText: '', statusClass: 'missing' };
  }
  if (info.hasModelFiles === false && !info.allExist) {
    return { dotState: 'missing', statusText: t('settings.modelOverviewMissing'), versionText: '', statusClass: 'missing' };
  }
  const installed = info.hasModelFiles === true || info.allExist === true || info.updateAvailable !== undefined;
  if (!installed) {
    return { dotState: 'missing', statusText: t('settings.modelOverviewMissing'), versionText: '', statusClass: 'missing' };
  }
  if (info.updateAvailable) {
    return { dotState: 'warning', statusText: t('settings.modelOverviewUpdateAvailable'), versionText: _formatVersionLine(info), statusClass: 'warning' };
  }
  return { dotState: 'installed', statusText: t('settings.modelOverviewInstalled'), versionText: _formatVersionLine(info), statusClass: 'installed' };
}

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    // ----- Shell -----
    activeSection: 'section-language',
    appVersion: 'v-',
    // Cache of the last getSettings() result (replaces window._currentSetting).
    savedSettings: null,

    // ----- Language -----
    language: {
      locale: 'en',
    },

    // ----- Theme (select + editor + save-as modal + toast) -----
    theme: {
      themeList: [],
      selectedId: '',
      editorVisible: false,
      editorActive: false,
      editorVersion: 0, // bump to force token-input re-sync after undo/redo/reset
      saveAsVisible: false,
      saveAsId: '',
      saveAsName: '',
      saveAsIdError: '',
      saveAsIdErrorVisible: false,
      toastMessage: '',
      toastKind: 'info',
      toastVisible: false,
    },

    // ----- Inference hardware -----
    inference: {
      provider: 'ortnode',
      deviceMode: 'smart',
      preferredDeviceId: 'auto', // <select> value (string)
      modelDeviceMapping: {}, // { groupId: valueString }
      devices: [], // cachedDevices (filtered by provider)
      webnnState: 'checking', // 'checking' | 'available' | 'unavailable'
      npuState: 'checking',
      gpuState: 'checking',
      hardwareInfo: null,
      currentHardwareText: '',
    },

    // ----- Preview inference params -----
    previewParams: {
      diffSteps: 16,
      sampler: 'euler',
      cfgStrength: 3.0,
      cfgRescale: 0.75,
      chunkEnabled: false,
      chunkFrames: 500,
      chunkOverlapFrames: 50,
    },

    // ----- Export inference params -----
    exportParams: {
      diffSteps: 32,
      sampler: 'euler',
      cfgStrength: 3.0,
      cfgRescale: 0.75,
    },

    // ----- Vocoder chunk -----
    vocoderChunk: {
      mode: 'smart',
      frames: 1008,
      smartInfoText: '', // empty → show default placeholder text
      tableRows: [], // [{ tierGb, budgetGb, approxSeconds, frames, isCurrent }]
      tableLoading: true,
    },

    // ----- ORT advanced -----
    ort: {
      enableMemPattern: true,
      enableCpuMemArena: true,
      graphOptLevel: 'all',
      executionMode: 'sequential',
      forceMemPatternOnDml: false,
      intraOpNumThreads: 0,
      interOpNumThreads: 0,
      logSeverityLevel: 'warning',
    },

    // ----- Audio -----
    audio: {
      outputMode: 'shared',
      outputDevice: '-1', // <select> value (string)
      outputDevices: [], // [{ id, name, hostAPI, defaultSampleRate }]
      sampleRate: '24000',
      bitDepth: 'float32',
      bufferSize: '1024',
      volume: 100, // 0..100
      isAvailable: true,
      modeDisabled: false,
    },

    // ----- MIDI -----
    midi: {
      extractTool: 'basicpitch',
    },

    // ----- Model management -----
    model: {
      precision: 'fp32',
      modelStatusList: [], // [{ prec, ready, missing }]
      vocoderType: 'default',
      vocoderTypeHint: '',
      sifiganOnnxExists: false,
      sifiganStatsExists: false,
      sifiganPrecision: 'fp32',
      japaneseVocalization: 'hybrid',
      releaseDmlVramAfterSynthesis: false,
      releaseDiffStepBeforeVocoder: true,
      overview: {
        main: { dotState: 'checking', statusText: '', versionText: '', statusClass: 'checking' },
        jp: { dotState: 'checking', statusText: '', versionText: '', statusClass: 'checking' },
        sifigan: { dotState: 'checking', statusText: '', versionText: '', statusClass: 'checking' },
      },
      overviewMainPrecision: '',
    },

    // ----- Update -----
    update: {
      channel: 'release',
      autoCheck: true,
      checkBtnText: '',
      checkBtnDisabled: false,
      checkStatusText: '',
      resultVisible: false,
      resultLines: [],
      reEnableReminderVisible: false,
    },
  }),

  getters: {
    // ----- Inference -----
    inferenceProviderHintText(state) {
      return state.inference.provider === 'ortweb'
        ? t('settings.inferenceProviderHintOrtweb')
        : t('settings.inferenceProviderHintOrtnode');
    },
    deviceSelectDisabled(state) {
      return state.inference.deviceMode !== 'manual';
    },
    advancedSettingsVisible(state) {
      return state.inference.deviceMode === 'advanced';
    },
    webnnStatusText(state) {
      return _statusText(state.inference.webnnState, 'settings.webnnAvailable', 'settings.webnnNotAvailable');
    },
    npuStatusText(state) {
      return _statusText(state.inference.npuState, 'settings.npuAvailable', 'settings.npuNotAvailable');
    },
    gpuStatusText(state) {
      return _statusText(state.inference.gpuState, 'settings.webnnGpuAvailable', 'settings.webnnGpuNotAvailable');
    },
    // Discrete GPUs (for "auto prefer discrete" label)
    discreteGpus(state) {
      return state.inference.devices.filter(d => d.deviceType === 'discrete-gpu' || d.isDiscrete);
    },
    autoSelectLabel(state) {
      const provider = state.inference.provider;
      const discrete = state.inference.devices.filter(d => d.deviceType === 'discrete-gpu' || d.isDiscrete);
      return provider === 'ortnode' && discrete.length > 0
        ? t('settings.autoSelectPreferDiscrete', { name: discrete[0].name })
        : t('settings.autoSelect');
    },
    /**
     * Select options for the inference device dropdown: an "auto" option
     * followed by one option per detected device. Each entry carries its
     * deviceType so collectSettings() can derive preferredDeviceType.
     */
    deviceOptions(state) {
      const devices = state.inference.devices;
      const opts = [{ value: 'auto', label: this.autoSelectLabel, deviceType: null }];
      for (const d of devices) {
        opts.push({ value: deviceOptionValue(d), label: getDeviceOptionText(d), deviceType: d.deviceType || (d.isDiscrete ? 'discrete-gpu' : 'integrated-gpu') });
      }
      return opts;
    },

    // ----- Preview params -----
    previewDiffStepChunkGroupVisible(state) {
      return state.previewParams.chunkEnabled;
    },

    // ----- Vocoder chunk -----
    vocoderChunkManualVisible(state) {
      return state.vocoderChunk.mode === 'manual';
    },
    vocoderChunkSmartInfoVisible(state) {
      return state.vocoderChunk.mode !== 'manual';
    },
    vocoderChunkFramesDisplay(state) {
      return state.vocoderChunk.frames;
    },

    // ----- Model -----
    sifiganPrecisionVisible(state) {
      return state.model.vocoderType === 'sifigan';
    },
    sifiganOptionDisabled(state) {
      return !state.model.sifiganOnnxExists;
    },
    sifiganOptionLabel(state) {
      return state.model.sifiganOnnxExists ? 'SiFiGAN' : t('settings.vocoderTypeSifigan');
    },
    modelOverviewMainPrecisionText(state) {
      const prec = state.model.precision || 'int8-npu';
      return PRECISION_LABELS[prec] || prec;
    },

    // ----- Audio -----
    audioExclusiveInfoVisible(state) {
      return state.audio.outputMode === 'exclusive';
    },
    audioBitDepthDisabled(state) {
      const isExclusive = state.audio.outputMode === 'exclusive';
      return !(isExclusive && state.audio.isAvailable);
    },
    volumePercent(state) {
      return state.audio.volume + '%';
    },

    // ----- Theme -----
    builtinThemes(state) {
      return state.theme.themeList.filter(m => m.source === 'builtin');
    },
    userThemes(state) {
      return state.theme.themeList.filter(m => m.source !== 'builtin');
    },
    /**
     * Token groups for the theme editor, grouped by layer → sub-group.
     * Touches theme.editorVersion so the getter re-evaluates after
     * undo/redo/reset-all/reset-token (which bump the version).
     */
    themeEditorGroups(state) {
      void state.theme.editorVersion; // reactivity hook
      const tokens = themeManager.currentTokens()?.tokens || {};
      const byLayer = { global: [], alias: [], component: [], custom: [] };
      for (const [name, meta] of Object.entries(TOKEN_CATALOG)) {
        byLayer[meta.layer || 'custom'].push({ name, meta });
      }
      for (const name of Object.keys(tokens)) {
        if (!TOKEN_CATALOG[name] && !byLayer.custom.find(x => x.name === name)) {
          byLayer.custom.push({ name, meta: { layer: 'custom', group: 'other', type: 'string', label: name } });
        }
      }
      const out = [];
      for (const layerKey of ['global', 'alias', 'component', 'custom']) {
        if (!byLayer[layerKey].length) continue;
        const groups = {};
        for (const item of byLayer[layerKey]) {
          const g = item.meta.group || 'other';
          if (!groups[g]) groups[g] = [];
          groups[g].push(item);
        }
        out.push({ layerKey, layerLabel: layerLabel(layerKey), groups: Object.entries(groups).map(([groupName, items]) => ({ groupName, items })) });
      }
      return out;
    },
  },

  actions: {
    // ==================== Sidebar ====================
    setSection(id) {
      this.activeSection = id;
    },

    // ==================== Toast ====================
    showToast(message, kind = 'info') {
      this.theme.toastMessage = message;
      this.theme.toastKind = kind;
      this.theme.toastVisible = true;
      if (_toastTimer) clearTimeout(_toastTimer);
      _toastTimer = setTimeout(() => {
        this.theme.toastVisible = false;
      }, 3000);
    },

    // ==================== Save / load ====================
    /**
     * Build the settings object from current store state (port of collectSettings()).
     */
    collectSettings() {
      const inf = this.inference;
      const deviceMode = inf.deviceMode;
      const inferenceProvider = inf.provider;

      let preferredDeviceId;
      let preferredDeviceType;
      if (deviceMode === 'manual') {
        const inferenceValue = inf.preferredDeviceId;
        preferredDeviceId = inferenceValue === 'auto'
          ? null
          : (inferenceValue === 'npu' || inferenceValue === 'webnn-gpu' ? inferenceValue : parseInt(inferenceValue));
        preferredDeviceType = null;
        if (preferredDeviceId !== null) {
          if (preferredDeviceId === 'npu' || preferredDeviceId === 'webnn-gpu') {
            preferredDeviceType = preferredDeviceId;
          } else {
            const matched = inf.devices.find(d => deviceOptionValue(d) === String(inferenceValue));
            preferredDeviceType = matched?.deviceType || (matched?.isDiscrete ? 'discrete-gpu' : 'integrated-gpu') || null;
          }
        }
      }

      let modelDeviceMapping = {};
      if (deviceMode === 'advanced') {
        for (const [groupId, val] of Object.entries(inf.modelDeviceMapping)) {
          modelDeviceMapping[groupId] = val === 'auto'
            ? 'auto'
            : (val === 'npu' || val === 'webnn-gpu' ? val : parseInt(val));
        }
      }

      const a = this.audio;
      const m = this.model;
      const o = this.ort;
      const p = this.previewParams;
      const e = this.exportParams;
      const v = this.vocoderChunk;

      return {
        deviceMode,
        inferenceProvider,
        preferredDeviceId,
        preferredDeviceType,
        modelDeviceMapping,
        deviceId: preferredDeviceId,
        previewDiffSteps: parseInt(p.diffSteps),
        previewCfgStrength: parseFloat(p.cfgStrength),
        previewCfgRescale: parseFloat(p.cfgRescale),
        previewSampler: p.sampler,
        previewDiffStepChunkEnabled: p.chunkEnabled,
        previewDiffStepChunkFrames: parseInt(p.chunkFrames),
        previewDiffStepChunkOverlapFrames: parseInt(p.chunkOverlapFrames),
        exportDiffSteps: parseInt(e.diffSteps),
        exportCfgStrength: parseFloat(e.cfgStrength),
        exportCfgRescale: parseFloat(e.cfgRescale),
        exportSampler: e.sampler,
        audioOutputMode: a.outputMode,
        audioOutputDevice: parseInt(a.outputDevice),
        audioSampleRate: parseInt(a.sampleRate),
        audioBitDepth: a.bitDepth,
        audioBufferSize: parseInt(a.bufferSize),
        audioVolume: parseInt(a.volume) / 100,
        locale: this.language.locale,
        modelPrecision: m.precision,
        midiExtractTool: this.midi.extractTool,
        vocoderType: m.vocoderType,
        sifiganPrecision: m.sifiganPrecision === 'fp16' ? 'fp16' : 'fp32',
        japaneseVocalization: m.japaneseVocalization,
        vocoderChunkMode: v.mode,
        vocoderChunkFrames: parseInt(v.frames),
        releaseDmlVramAfterSynthesis: m.releaseDmlVramAfterSynthesis,
        releaseDiffStepBeforeVocoder: m.releaseDiffStepBeforeVocoder,
        ortEnableMemPattern: o.enableMemPattern,
        ortEnableCpuMemArena: o.enableCpuMemArena,
        ortGraphOptLevel: o.graphOptLevel,
        ortExecutionMode: o.executionMode,
        ortForceMemPatternOnDml: o.forceMemPatternOnDml,
        ortIntraOpNumThreads: parseInt(o.intraOpNumThreads),
        ortInterOpNumThreads: parseInt(o.interOpNumThreads),
        ortLogSeverityLevel: o.logSeverityLevel,
        updateChannel: this.update.channel,
        autoCheckUpdates: this.update.autoCheck,
      };
    },

    async applySettings(options = {}) {
      const settings = this.collectSettings();
      try {
        await window.electronAPI.saveSettings(settings);
        if (options.reloadLocale) {
          setLocale(settings.locale);
          if (window.electronAPI?.reloadMainWindow) {
            window.electronAPI.reloadMainWindow().catch(() => {});
          }
        }
      } catch (err) {
        console.error('Failed to apply settings:', err);
      }
    },

    applySettingsDebounced() {
      if (_saveDebounce) clearTimeout(_saveDebounce);
      _saveDebounce = setTimeout(() => { this.applySettings(); }, 300);
    },

    /**
     * Apply saved settings to store state (port of applySavedSettingsToUI).
     */
    applySavedSettingsToUI(currentSetting) {
      if (!currentSetting) return;
      this.savedSettings = currentSetting;

      // Inference provider
      this.inference.provider = currentSetting.inferenceProvider === 'ortweb' ? 'ortweb' : 'ortnode';

      // Device mode
      this.inference.deviceMode = currentSetting.deviceMode || 'smart';

      // Preview diffusion
      const p = this.previewParams;
      p.diffSteps = currentSetting.previewDiffSteps ?? 16;
      p.cfgStrength = currentSetting.previewCfgStrength ?? 3.0;
      p.cfgRescale = currentSetting.previewCfgRescale ?? 0.75;
      p.sampler = currentSetting.previewSampler || 'euler';
      p.chunkEnabled = currentSetting.previewDiffStepChunkEnabled === true;
      p.chunkFrames = currentSetting.previewDiffStepChunkFrames ?? 500;
      p.chunkOverlapFrames = currentSetting.previewDiffStepOverlapFrames ?? 50;

      // Export diffusion
      const e = this.exportParams;
      e.diffSteps = currentSetting.exportDiffSteps ?? 32;
      e.cfgStrength = currentSetting.exportCfgStrength ?? 3.0;
      e.cfgRescale = currentSetting.exportCfgRescale ?? 0.75;
      e.sampler = currentSetting.exportSampler || 'euler';

      // Audio
      const a = this.audio;
      if (currentSetting.audioOutputMode) a.outputMode = currentSetting.audioOutputMode;
      if (currentSetting.audioSampleRate) a.sampleRate = String(currentSetting.audioSampleRate);
      if (currentSetting.audioBitDepth) a.bitDepth = currentSetting.audioBitDepth;
      if (currentSetting.audioBufferSize) a.bufferSize = String(currentSetting.audioBufferSize);
      if (currentSetting.audioVolume !== undefined) {
        a.volume = Math.round(currentSetting.audioVolume * 100);
      }

      // Language & precision
      this.language.locale = getLocale();
      this.model.precision = currentSetting.modelPrecision || 'fp32';

      // MIDI tool (rosvot stored as rmvpe)
      if (currentSetting.midiExtractTool) {
        this.midi.extractTool = currentSetting.midiExtractTool === 'rosvot' ? 'rmvpe' : currentSetting.midiExtractTool;
      } else {
        this.midi.extractTool = 'basicpitch';
      }

      // Vocoder type
      this.model.vocoderType = currentSetting.vocoderType === 'sifigan' ? 'sifigan' : 'default';
      this.model.sifiganPrecision = currentSetting.sifiganPrecision === 'fp16' ? 'fp16' : 'fp32';

      // Japanese vocalization
      const validJp = ['en-phonemes', 'hybrid', 'jp-lora'];
      this.model.japaneseVocalization = validJp.includes(currentSetting.japaneseVocalization)
        ? currentSetting.japaneseVocalization : 'hybrid';

      // Vocoder chunk mode + frames
      const v = this.vocoderChunk;
      v.mode = currentSetting.vocoderChunkMode === 'manual' ? 'manual' : 'smart';
      v.frames = Number.isFinite(currentSetting.vocoderChunkFrames) ? currentSetting.vocoderChunkFrames : 1008;

      // DML VRAM release options
      this.model.releaseDmlVramAfterSynthesis = currentSetting.releaseDmlVramAfterSynthesis === true;
      this.model.releaseDiffStepBeforeVocoder = currentSetting.releaseDiffStepBeforeVocoder !== false;

      // ORT advanced
      const o = this.ort;
      o.enableMemPattern = currentSetting.ortEnableMemPattern !== false;
      o.enableCpuMemArena = currentSetting.ortEnableCpuMemArena !== false;
      o.graphOptLevel = ['disabled', 'basic', 'extended', 'all'].includes(currentSetting.ortGraphOptLevel)
        ? currentSetting.ortGraphOptLevel : 'all';
      o.executionMode = currentSetting.ortExecutionMode === 'parallel' ? 'parallel' : 'sequential';
      o.forceMemPatternOnDml = currentSetting.ortForceMemPatternOnDml === true;
      o.intraOpNumThreads = Number.isFinite(currentSetting.ortIntraOpNumThreads) && currentSetting.ortIntraOpNumThreads > 0
        ? Math.min(64, Math.floor(currentSetting.ortIntraOpNumThreads)) : 0;
      o.interOpNumThreads = Number.isFinite(currentSetting.ortInterOpNumThreads) && currentSetting.ortInterOpNumThreads > 0
        ? Math.min(64, Math.floor(currentSetting.ortInterOpNumThreads)) : 0;
      o.logSeverityLevel = ['verbose', 'info', 'warning', 'error', 'fatal'].includes(currentSetting.ortLogSeverityLevel)
        ? currentSetting.ortLogSeverityLevel : 'warning';

      // Update channel & auto-check
      this.update.channel = currentSetting.updateChannel === 'nightly' ? 'nightly' : 'release';
      this.update.autoCheck = currentSetting.autoCheckUpdates !== false;

      // Restore preferred device id (validates against current device list)
      const preferredId = currentSetting.preferredDeviceId ?? currentSetting.deviceId ?? null;
      const desiredValue = preferredId !== null ? String(preferredId) : 'auto';
      const validValues = new Set(['auto', ...this.inference.devices.map(deviceOptionValue)]);
      this.inference.preferredDeviceId = validValues.has(desiredValue) ? desiredValue : 'auto';

      // Restore model device mapping (advanced mode)
      const existingMapping = currentSetting.modelDeviceMapping || {};
      const mapping = {};
      for (const group of MODEL_GROUPS) {
        if (existingMapping[group.id] !== undefined) {
          mapping[group.id] = String(existingMapping[group.id]);
        } else {
          mapping[group.id] = 'auto';
        }
      }
      this.inference.modelDeviceMapping = mapping;
    },

    // ==================== Devices / hardware ====================
    async loadDevices() {
      const inf = this.inference;
      // Loading state for WebNN/NPU/GPU indicators
      inf.webnnState = 'checking';
      inf.npuState = 'checking';
      inf.gpuState = 'checking';

      try {
        // First load saved settings and apply to UI
        const currentSetting = await window.electronAPI.getSettings();
        this.applySavedSettingsToUI(currentSetting);
        this.refreshModelOverview().catch(() => {});
        const provider = currentSetting?.inferenceProvider || 'ortnode';

        // Then fetch device list (hardware detection can be slow)
        const allDevices = await window.electronAPI.getDMLDevices();
        const hasNpu = allDevices.some(d => d.deviceType === 'npu');
        const hasWebnnGpu = allDevices.some(d => d.deviceType === 'webnn-gpu');

        inf.webnnState = (hasNpu || hasWebnnGpu) ? 'available' : 'unavailable';
        inf.npuState = hasNpu ? 'available' : 'unavailable';
        inf.gpuState = hasWebnnGpu ? 'available' : 'unavailable';

        const devices = provider === 'ortweb'
          ? allDevices.filter(d => d.deviceType === 'npu' || d.deviceType === 'webnn-gpu')
          : allDevices.filter(d => d.deviceType !== 'npu' && d.deviceType !== 'webnn-gpu');
        inf.devices = devices;

        const hardwareInfo = await window.electronAPI.getCurrentHardware();
        inf.hardwareInfo = hardwareInfo;

        // Re-validate preferred device id now that the device list is loaded
        const preferredId = currentSetting?.preferredDeviceId ?? currentSetting?.deviceId ?? null;
        const desiredValue = preferredId !== null ? String(preferredId) : 'auto';
        const validValues = new Set(['auto', ...devices.map(deviceOptionValue)]);
        inf.preferredDeviceId = validValues.has(desiredValue) ? desiredValue : 'auto';

        this.updateCurrentHardwareDisplay();

        await this.loadAudioDevices();
      } catch (err) {
        console.error('Failed to load device list:', err);
        inf.devices = [];
        inf.preferredDeviceId = 'auto';
      }
    },

    /**
     * Build the "current hardware" text (port of updateCurrentHardwareDisplay).
     * Reads current store state; called after device / mode / provider changes.
     */
    updateCurrentHardwareDisplay() {
      const inf = this.inference;
      const hardwareInfo = inf.hardwareInfo;
      const devices = inf.devices;
      const currentSetting = this.savedSettings || {};
      const deviceMode = currentSetting.deviceMode || inf.deviceMode;
      const provider = currentSetting.inferenceProvider || inf.provider;
      const providerLabel = provider === 'ortweb' ? 'ORTWEB / ' : 'ORTNODE / ';

      if (hardwareInfo) {
        const gpuName = hardwareInfo.gpuDeviceName || t('settings.cpuOnly');
        const dmlCount = hardwareInfo.dmlModelCount || 0;
        const cpuCount = hardwareInfo.cpuModelCount || 0;
        const webnnCount = hardwareInfo.webnnModelCount || 0;
        const total = hardwareInfo.totalModels || 0;

        let deviceTypeLabel = '';
        if (hardwareInfo.isUsingWebNN) {
          deviceTypeLabel = ` ${t('settings.npuLabel')}`;
        } else if (hardwareInfo.dmlDeviceId !== undefined && hardwareInfo.dmlDeviceId !== null) {
          const matchedDevice = devices.find(d => d.dxgiAdapterNumber === hardwareInfo.dmlDeviceId);
          if (matchedDevice) {
            deviceTypeLabel = ` ${getDeviceTypeLabel(matchedDevice.deviceType || (matchedDevice.isDiscrete ? 'discrete-gpu' : 'integrated-gpu'))}`;
          }
        }

        const epParts = [];
        if (webnnCount > 0) epParts.push(t('settings.webnnModels', { count: webnnCount, total }));
        if (dmlCount > 0) epParts.push(t('settings.dmlModels', { count: dmlCount, total }));
        if (cpuCount > 0) epParts.push(t('settings.cpuModels', { count: cpuCount, total }));
        const epDetail = epParts.length > 0 ? ` (${epParts.join(', ')})` : '';

        let deviceIdStr = '';
        if (!hardwareInfo.isUsingWebNN && hardwareInfo.dmlDeviceId !== undefined && hardwareInfo.dmlDeviceId !== null) {
          deviceIdStr = ` [deviceId=${hardwareInfo.dmlDeviceId}]`;
        }

        inf.currentHardwareText = `${providerLabel}${gpuName}${deviceTypeLabel}${deviceIdStr}${epDetail}`;
        return;
      }

      if (!devices || devices.length === 0) {
        inf.currentHardwareText = t('settings.noGpuDetected');
        return;
      }

      const selectedDeviceId = (currentSetting.preferredDeviceId !== undefined && currentSetting.preferredDeviceId !== null)
        ? currentSetting.preferredDeviceId
        : (currentSetting.deviceId !== undefined && currentSetting.deviceId !== null ? currentSetting.deviceId : null);

      if (selectedDeviceId !== null) {
        let selected;
        if (selectedDeviceId === 'npu') {
          selected = devices.find(d => d.deviceType === 'npu');
        } else if (selectedDeviceId === 'webnn-gpu') {
          selected = devices.find(d => d.deviceType === 'webnn-gpu');
        } else {
          selected = devices.find(d => d.dxgiAdapterNumber === selectedDeviceId);
        }
        if (selected) {
          const vramStr = selected.vram ? ` (${selected.vram})` : '';
          const typeLabel = getDeviceTypeLabel(selected.deviceType || (selected.isDiscrete ? 'discrete-gpu' : 'integrated-gpu'));
          const webnnTag = selected.deviceType === 'npu' ? ' [NPU(WebNN)]' : (selected.deviceType === 'webnn-gpu' ? ' [WebNN GPU]' : '');
          inf.currentHardwareText = `${providerLabel}${selected.name}${vramStr} ${typeLabel}${webnnTag} [deviceId=${selectedDeviceId}] ${t('settings.pendingInit')}`;
          return;
        }
      }

      if (provider === 'ortweb') {
        const best = devices.find(d => d.deviceType === 'npu') || devices.find(d => d.deviceType === 'webnn-gpu');
        if (best) {
          const typeLabel = getDeviceTypeLabel(best.deviceType);
          inf.currentHardwareText = `${providerLabel}${t('settings.autoSelect')}: ${best.name} ${typeLabel} ${t('settings.pendingInit')}`;
          return;
        }
      }

      const discrete = devices.filter(d => d.deviceType === 'discrete-gpu' || d.isDiscrete);
      if (discrete.length > 0) {
        const best = discrete.sort((a, b) => (b.vramBytes || 0) - (a.vramBytes || 0))[0];
        inf.currentHardwareText = `${providerLabel}${t('settings.autoSelectPreferDiscrete', { name: best.name })} ${t('settings.pendingInit')}`;
      } else {
        const best = devices.sort((a, b) => (b.vramBytes || 0) - (a.vramBytes || 0))[0];
        const vramStr = best?.vram ? ` (${best.vram})` : '';
        inf.currentHardwareText = best
          ? `${providerLabel}${t('settings.autoSelect')}: ${best.name}${vramStr} ${getDeviceTypeLabel(best.deviceType || (best.isDiscrete ? 'discrete-gpu' : 'integrated-gpu'))} ${t('settings.pendingInit')}`
          : `${providerLabel}${t('settings.noGpuDetected')}`;
      }
    },

    // ==================== Inference handlers ====================
    async setInferenceProvider(provider) {
      this.inference.provider = provider;
      await this.applySettings();
      await this.loadDevices();
    },

    setDeviceMode(mode) {
      this.inference.deviceMode = mode;
      this.applySettings();
      this.updateCurrentHardwareDisplay();
    },

    setPreferredDeviceId(value) {
      this.inference.preferredDeviceId = value;
      this.applySettings();
      this.updateCurrentHardwareDisplay();
    },

    setModelDeviceMapping(groupId, value) {
      this.inference.modelDeviceMapping = { ...this.inference.modelDeviceMapping, [groupId]: value };
      this.applySettings();
    },

    // ==================== Audio ====================
    async loadAudioDevices() {
      try {
        const audioResult = await window.electronAPI.getAudioDevices();
        const audioDevices = audioResult.devices || [];
        const isAudioAvailable = audioResult.isAvailable || false;
        this.audio.isAvailable = isAudioAvailable;

        if (!isAudioAvailable) {
          this.audio.outputMode = 'shared';
          this.audio.modeDisabled = true;
        } else {
          this.audio.modeDisabled = false;
        }

        this.populateAudioDevices(audioDevices);

        // Restore audio output device selection
        const currentSetting = this.savedSettings;
        if (currentSetting && currentSetting.audioOutputDevice !== undefined) {
          const val = String(currentSetting.audioOutputDevice);
          if (this.audio.outputDevices.some(d => String(d.id) === val) || val === '-1') {
            this.audio.outputDevice = val;
          }
        }
      } catch (err) {
        console.error('Failed to load audio device list:', err);
      }
    },

    populateAudioDevices(audioDevices) {
      const list = [{ id: -1, name: t('settings.systemDefault'), hostAPI: '', defaultSampleRate: 0 }];
      for (const d of audioDevices) {
        const hostApiStr = d.hostAPI ? ` [${d.hostAPI}]` : '';
        const srStr = d.defaultSampleRate ? ` (${d.defaultSampleRate}Hz)` : '';
        list.push({ id: d.id, name: `${d.name}${hostApiStr}${srStr}`, hostAPI: d.hostAPI, defaultSampleRate: d.defaultSampleRate });
      }
      this.audio.outputDevices = list;
    },

    async updateAudioDeviceList() {
      try {
        const audioResult = await window.electronAPI.getAudioDevices();
        const audioDevices = audioResult.devices || [];
        const currentValue = this.audio.outputDevice;
        this.populateAudioDevices(audioDevices);
        if (currentValue && this.audio.outputDevices.some(d => String(d.id) === currentValue)) {
          this.audio.outputDevice = currentValue;
        }
      } catch (err) {
        console.error('Failed to update audio device list:', err);
      }
    },

    setAudioOutputMode(mode) {
      this.audio.outputMode = mode;
      this.updateAudioDeviceList();
      this.applySettings();
    },

    setAudioOutputDevice(value) {
      this.audio.outputDevice = value;
      this.applySettings();
    },

    setAudioSampleRate(value) {
      this.audio.sampleRate = value;
      this.applySettings();
    },

    setAudioBitDepth(value) {
      this.audio.bitDepth = value;
      this.applySettings();
    },

    setAudioBufferSize(value) {
      this.audio.bufferSize = value;
      this.applySettings();
    },

    setAudioVolume(value) {
      this.audio.volume = value;
      this.applySettingsDebounced();
    },

    // ==================== Preview / export params ====================
    setPreviewDiffSteps(v) {
      this.previewParams.diffSteps = parseInt(v);
      this.applySettingsDebounced();
    },
    setPreviewCfgStrength(v) {
      this.previewParams.cfgStrength = v;
      this.applySettingsDebounced();
    },
    setPreviewCfgRescale(v) {
      this.previewParams.cfgRescale = v;
      this.applySettingsDebounced();
    },
    setPreviewSampler(v) {
      this.previewParams.sampler = v;
      this.applySettings();
    },
    setPreviewChunkEnabled(v) {
      this.previewParams.chunkEnabled = v;
      this.applySettings();
    },
    setPreviewChunkFrames(v) {
      this.previewParams.chunkFrames = parseInt(v);
      this.applySettingsDebounced();
    },
    setPreviewChunkOverlapFrames(v) {
      this.previewParams.chunkOverlapFrames = parseInt(v);
      this.applySettingsDebounced();
    },
    setExportDiffSteps(v) {
      this.exportParams.diffSteps = parseInt(v);
      this.applySettingsDebounced();
    },
    setExportCfgStrength(v) {
      this.exportParams.cfgStrength = v;
      this.applySettingsDebounced();
    },
    setExportCfgRescale(v) {
      this.exportParams.cfgRescale = v;
      this.applySettingsDebounced();
    },
    setExportSampler(v) {
      this.exportParams.sampler = v;
      this.applySettings();
    },

    // ==================== Vocoder chunk ====================
    setVocoderChunkMode(mode) {
      this.vocoderChunk.mode = mode;
      this.applySettings();
    },
    setVocoderChunkFrames(v) {
      // Force-align to multiple of 8 (compatible with VOCODER_OVERLAP_FRAMES)
      let n = parseInt(v);
      if (!Number.isFinite(n)) n = 1008;
      n = Math.round(n / 8) * 8;
      this.vocoderChunk.frames = n;
      this.applySettingsDebounced();
    },

    async loadVocoderChunkFramesInfo() {
      if (!window.electronAPI?.getVocoderChunkFramesInfo) return;
      try {
        const info = await window.electronAPI.getVocoderChunkFramesInfo();
        if (info.gpuPhase !== 'full') return;
        _vocoderChunkInfoLoaded = true;
        const gb = info.bestVramBytes / (1024 * 1024 * 1024);
        _currentVramGb = gb;
        const gpuName = info.bestGpuName || '';
        const vramStr = gb > 0 ? `${gb.toFixed(1)}GB` : t('settings.unknownGpu');
        this.vocoderChunk.smartInfoText = t('settings.vocoderChunkSmartResult', {
          frames: info.smartFrames,
          vram: vramStr,
          gpu: gpuName || t('settings.unknownGpu'),
        });
        this.loadVocoderChunkFramesTable();
      } catch (err) {
        console.error('[Settings] Failed to load vocoder chunk frames info:', err);
      }
    },

    async loadVocoderChunkFramesTable() {
      if (!window.electronAPI?.getVocoderChunkFramesTable) return;
      try {
        const rows = await window.electronAPI.getVocoderChunkFramesTable();
        this.vocoderChunk.tableLoading = false;
        if (!Array.isArray(rows) || rows.length === 0) {
          this.vocoderChunk.tableRows = [];
          return;
        }
        // Determine current tier from the last loaded smart-info VRAM.
        const currentVramGb = _currentVramGb;
        let currentTierGb = 0;
        if (currentVramGb > 0) {
          for (const r of rows) {
            if (r.tierGb <= currentVramGb) currentTierGb = r.tierGb;
          }
        }
        this.vocoderChunk.tableRows = rows.map(r => ({
          tierGb: r.tierGb,
          budgetGb: r.budgetGb,
          approxSeconds: r.approxSeconds,
          frames: r.frames,
          isCurrent: r.tierGb === currentTierGb && currentTierGb > 0,
        }));
      } catch (err) {
        console.error('[Settings] Failed to load vocoder chunk frames table:', err);
        this.vocoderChunk.tableLoading = false;
        this.vocoderChunk.tableRows = [];
      }
    },

    // ==================== SiFiGAN vocoder ====================
    async checkSifiganVocoderFiles() {
      try {
        const modelDir = await window.electronAPI.getModelDir();
        if (!modelDir) {
          this.updateVocoderTypeUI({ onnxExists: false, statsExists: false });
          return;
        }
        await window.electronAPI.authorizePath(modelDir);
        const base = modelDir.replace(/[\\/]+$/, '');
        const [fp16Exists, fp32DmlExists, fp32PlainExists, statsExists] = await Promise.all([
          window.electronAPI.fileExists(base + '/sifigan_vocoder_dml_fp16.onnx'),
          window.electronAPI.fileExists(base + '/sifigan_vocoder_dml.onnx'),
          window.electronAPI.fileExists(base + '/sifigan_vocoder.onnx'),
          window.electronAPI.fileExists(base + '/sifigan_stats.joblib'),
        ]);
        const onnxExists = !!(fp16Exists || fp32DmlExists || fp32PlainExists);
        this.updateVocoderTypeUI({ onnxExists, statsExists });
      } catch (err) {
        console.error('[Settings] Failed to detect SiFiGAN model files:', err);
        this.updateVocoderTypeUI({ onnxExists: false, statsExists: false });
      }
    },

    updateVocoderTypeUI(fileStatus) {
      const { onnxExists, statsExists } = fileStatus;
      this.model.sifiganOnnxExists = !!onnxExists;
      this.model.sifiganStatsExists = !!statsExists;
      if (onnxExists) {
        this.model.vocoderTypeHint = statsExists
          ? t('settings.vocoderTypeHintSifiganInstalled')
          : t('settings.vocoderTypeHintSifiganStatsMissing');
      } else {
        this.model.vocoderTypeHint = t('settings.vocoderTypeHintSifiganNotDownloaded');
      }
      // If sifigan selected but files missing, fall back to default
      if (this.model.vocoderType === 'sifigan' && !onnxExists) {
        this.model.vocoderType = 'default';
        this.model.vocoderTypeHint = t('settings.vocoderTypeHintSifiganFallback');
      }
    },

    // ==================== Model status ====================
    updateModelStatusDisplay(modelStatus) {
      if (!modelStatus) return;
      const list = [];
      for (const [prec, status] of Object.entries(modelStatus)) {
        list.push({
          prec,
          ready: !!status.ready,
          missing: status.missing,
          label: PRECISION_LABELS[prec] || prec,
          info: status.ready ? t('settings.modelReady') : t('settings.modelMissing', { count: status.missing }),
        });
      }
      this.model.modelStatusList = list;
    },

    async refreshModelOverview() {
      const m = this.model;
      // Checking state
      m.overview.main = { dotState: 'checking', statusText: t('settings.modelOverviewChecking'), versionText: '', statusClass: 'checking' };
      m.overview.jp = { dotState: 'checking', statusText: t('settings.modelOverviewChecking'), versionText: '', statusClass: 'checking' };
      m.overview.sifigan = { dotState: 'checking', statusText: t('settings.modelOverviewChecking'), versionText: '', statusClass: 'checking' };
      m.overviewMainPrecision = PRECISION_LABELS[m.precision] || m.precision;

      if (!window.electronAPI?.modelDownloadCheckAllVersions) return;
      try {
        const precision = m.precision || 'int8-npu';
        const result = await window.electronAPI.modelDownloadCheckAllVersions(precision);
        const mainState = _resolveOverviewState(result?.main);
        m.overview.main = { dotState: mainState.dotState, statusText: mainState.statusText, versionText: mainState.versionText, statusClass: mainState.statusClass };
        const jpState = _resolveOverviewState(result?.jp);
        m.overview.jp = { dotState: jpState.dotState, statusText: jpState.statusText, versionText: jpState.versionText, statusClass: jpState.statusClass };
        const sifiganState = _resolveOverviewState(result?.sifigan);
        m.overview.sifigan = { dotState: sifiganState.dotState, statusText: sifiganState.statusText, versionText: sifiganState.versionText, statusClass: sifiganState.statusClass };
      } catch (err) {
        console.error('[Settings] Failed to refresh model overview:', err);
      }
    },

    // ==================== Model handlers ====================
    async setModelPrecision(prec) {
      this.model.precision = prec;
      await this.applySettings();
      this.updateCurrentHardwareDisplay();
      this.loadVocoderChunkFramesTable();
      _vocoderChunkInfoLoaded = false;
      this.loadVocoderChunkFramesInfo();
      try {
        const modelStatus = await window.electronAPI.checkModels();
        this.updateModelStatusDisplay(modelStatus);
        const status = modelStatus[prec];
        if (status && !status.ready) {
          await window.electronAPI.modelDownloadOpen(prec);
        }
      } catch (_) {}
      this.refreshModelOverview().catch(() => {});
    },

    async setVocoderType(value) {
      if (value === 'sifigan') {
        if (!this.model.sifiganOnnxExists) {
          // Option disabled — protective fallback (browsers normally prevent
          // selecting a disabled option, but guard anyway).
          this.model.vocoderType = 'default';
          this.model.vocoderTypeHint = 'SiFiGAN 不可用，已回退到默认 Vocoder';
          return;
        }
      }
      this.model.vocoderType = value;
      this.applySettings();
      this.loadVocoderChunkFramesTable();
      _vocoderChunkInfoLoaded = false;
      this.loadVocoderChunkFramesInfo();
    },

    setSifiganPrecision(value) {
      this.model.sifiganPrecision = value === 'fp16' ? 'fp16' : 'fp32';
      this.applySettings();
      this.loadVocoderChunkFramesTable();
      _vocoderChunkInfoLoaded = false;
      this.loadVocoderChunkFramesInfo();
    },

    setJapaneseVocalization(value) {
      this.model.japaneseVocalization = value;
      this.applySettings();
    },

    setReleaseDmlVramAfterSynthesis(v) {
      this.model.releaseDmlVramAfterSynthesis = v;
      this.applySettings();
    },

    setReleaseDiffStepBeforeVocoder(v) {
      this.model.releaseDiffStepBeforeVocoder = v;
      this.applySettings();
    },

    async openModelDownloadWindow() {
      const precision = this.model.precision;
      try {
        await window.electronAPI.modelDownloadOpen(precision);
      } catch (err) {
        console.error('Failed to open model download:', err);
      }
    },

    // ==================== ORT handlers ====================
    setOrtEnableMemPattern(v) { this.ort.enableMemPattern = v; this.applySettings(); },
    setOrtEnableCpuMemArena(v) { this.ort.enableCpuMemArena = v; this.applySettings(); },
    setOrtGraphOptLevel(v) { this.ort.graphOptLevel = v; this.applySettings(); },
    setOrtExecutionMode(v) { this.ort.executionMode = v; this.applySettings(); },
    setOrtForceMemPatternOnDml(v) { this.ort.forceMemPatternOnDml = v; this.applySettings(); },
    setOrtIntraOpNumThreads(v) { this.ort.intraOpNumThreads = parseInt(v); this.applySettingsDebounced(); },
    setOrtInterOpNumThreads(v) { this.ort.interOpNumThreads = parseInt(v); this.applySettingsDebounced(); },
    setOrtLogSeverityLevel(v) { this.ort.logSeverityLevel = v; this.applySettings(); },

    // ==================== MIDI / language ====================
    setMidiExtractTool(v) { this.midi.extractTool = v; this.applySettings(); },

    async setLanguage(locale) {
      this.language.locale = locale;
      await this.applySettings({ reloadLocale: true });
    },

    // ==================== Update ====================
    setUpdateChannel(v) { this.update.channel = v; this.applySettings(); },
    setAutoCheckUpdates(v) { this.update.autoCheck = v; this.applySettings(); },

    async checkUpdateNow() {
      const api = window.electronAPI && window.electronAPI.updateAPI;
      if (!api || typeof api.checkNow !== 'function') return;
      this.update.checkBtnDisabled = true;
      this.update.checkBtnText = t('update.checking');
      this.update.checkStatusText = '';
      try {
        const result = await api.checkNow();
        this.renderUpdateResult(result);
      } catch (err) {
        console.error('[Update] checkNow failed:', err);
        this.update.resultLines = [t('update.networkError')];
        this.update.resultVisible = true;
      } finally {
        this.update.checkBtnDisabled = false;
        this.update.checkBtnText = t('update.checkNow');
      }
    },

    renderUpdateResult(result) {
      if (!result) {
        this.update.resultLines = [t('update.networkError')];
        this.update.resultVisible = true;
        return;
      }
      const app = result.app || {};
      const lines = [];
      if (app.error) {
        lines.push(app.error === 'rate_limited' ? t('update.rateLimited') : t('update.networkError'));
      }
      lines.push(`${t('update.currentVersion')}: ${app.currentVersion || '-'}`);
      lines.push(`${t('update.latestVersion')}: ${app.latestVersion || '-'}`);
      if (app.error) {
        // status line already pushed
      } else if (app.updateAvailable) {
        lines.push(t('update.updateAvailable'));
      } else {
        lines.push(t('update.upToDate'));
      }
      this.update.resultLines = lines;
      this.update.resultVisible = true;
    },

    async initUpdateSection() {
      const api = window.electronAPI && window.electronAPI.updateAPI;
      this.update.checkBtnText = t('update.checkNow');
      if (!api || typeof api.getStatus !== 'function') return;
      let status;
      try {
        status = await api.getStatus();
      } catch (err) {
        console.error('[Update] getStatus failed:', err);
        return;
      }
      if (!status) return;
      if (status.updateChannel) {
        this.update.channel = status.updateChannel === 'nightly' ? 'nightly' : 'release';
      }
      if (typeof status.autoCheckUpdates === 'boolean') {
        this.update.autoCheck = status.autoCheckUpdates;
      }
      if (status.dontRemindAppUpdates === true) {
        this.update.reEnableReminderVisible = true;
      }
      if (status.lastUpdateCheckTime) {
        const d = new Date(status.lastUpdateCheckTime);
        this.update.checkStatusText = `${t('update.lastCheck')}: ${d.toLocaleString()}`;
      }
    },

    async reEnableReminder() {
      try {
        const current = await window.electronAPI.getSettings();
        current.dontRemindAppUpdates = false;
        current.skippedAppVersion = null;
        await window.electronAPI.saveSettings(current);
      } catch (err) {
        console.error('[Update] re-enable reminder failed:', err);
      }
      this.update.reEnableReminderVisible = false;
    },

    // ==================== Theme list / actions ====================
    buildThemeListFallback() {
      let list = (window.electronAPI?.themeAPI?.list
        ? []
        : BUILTIN_THEMES.map(t => ({ ...t, source: 'builtin' })));
      try {
        const live = themeManager.list();
        if (live && live.length) list = live;
      } catch (_) { /* keep fallback */ }
      this.theme.themeList = list;
    },

    populateThemeSelect() {
      // selection restored by caller; here we just keep themeList current.
    },

    async refreshThemeList() {
      if (window.electronAPI?.themeAPI?.list) {
        try {
          this.theme.themeList = await window.electronAPI.themeAPI.list();
        } catch (e) {
          console.error('Failed to list themes:', e);
          this.theme.themeList = BUILTIN_THEMES.map(t => ({ ...t, source: 'builtin' }));
        }
      } else {
        this.buildThemeListFallback();
      }
      // Preserve current selection if still present
      const current = this.getCurrentThemeId();
      if (current && this.theme.themeList.some(m => m.id === current)) {
        this.theme.selectedId = current;
      } else if (this.theme.themeList.length > 0) {
        this.theme.selectedId = this.theme.themeList[0].id;
      }
    },

    getCurrentThemeId() {
      if (window.electronAPI?.themeAPI?.current) {
        // Async in nature but we cannot await in a sync getter; the bootstrap
        // path resolves it once and sets selectedId. For sync callers return
        // the stored selection.
        return this.theme.selectedId || null;
      }
      return themeManager.current()?.themeId || null;
    },

    async applyThemeViaAPI(themeId) {
      if (window.electronAPI?.themeAPI?.apply) {
        try {
          await window.electronAPI.themeAPI.apply(themeId, { scope: 'global' });
        } catch (e) {
          console.error('Failed to apply theme:', e);
        }
      } else if (themeId && themeManager.get(themeId)) {
        try {
          themeManager.activate(themeId);
        } catch (e) {
          console.error('Failed to apply theme:', e);
        }
      }
    },

    async selectTheme(id) {
      if (!id) return;
      this.theme.selectedId = id;
      await this.applyThemeViaAPI(id);
      const meta = this.theme.themeList.find(m => m.id === id);
      this.showToast(t('settings.theme.selectLabel') + ': ' + getThemeDisplayName(meta), 'info');
    },

    async resetTheme() {
      const defaultMeta = this.theme.themeList.find(m => m.id === 'dark-aurora') || { id: 'dark-aurora', name: 'Aurora Dark' };
      const confirmed = await showConfirm(t('settings.theme.confirmReset', { defaultTheme: getThemeDisplayName(defaultMeta) }));
      if (!confirmed) return;
      if (window.electronAPI?.themeAPI?.reset) {
        try {
          await window.electronAPI.themeAPI.reset();
        } catch (e) {
          console.error('Failed to reset theme:', e);
        }
      } else {
        try {
          themeManager.activate('dark-aurora');
        } catch (_) { /* ignore */ }
      }
      await this.refreshThemeList();
      this.showToast(t('settings.theme.reset'), 'info');
    },

    async importTheme() {
      if (!window.electronAPI?.themeAPI?.import) {
        this.showToast(t('settings.theme.importFailed', { error: 'IPC not available' }), 'error');
        return;
      }
      try {
        const result = await window.electronAPI.themeAPI.import();
        if (!result || !result.ok) {
          this.showToast(t('settings.theme.importFailed', { error: (result && result.error) || 'unknown' }), 'error');
          return;
        }
        this.showToast(t('settings.theme.importSuccess', { name: getThemeDisplayName(result.theme) || result.theme?.id || '' }), 'success');
        await this.refreshThemeList();
      } catch (e) {
        this.showToast(t('settings.theme.importFailed', { error: e.message || String(e) }), 'error');
      }
    },

    async exportTheme() {
      const id = this.theme.selectedId;
      if (!id) {
        this.showToast(t('settings.theme.exportFailed', { error: 'no theme selected' }), 'error');
        return;
      }
      if (!window.electronAPI?.themeAPI?.export) {
        this.showToast(t('settings.theme.exportFailed', { error: 'IPC not available' }), 'error');
        return;
      }
      try {
        const result = await window.electronAPI.themeAPI.export(id);
        if (!result || !result.ok) {
          this.showToast(t('settings.theme.exportFailed', { error: (result && result.error) || 'unknown' }), 'error');
          return;
        }
        this.showToast(t('settings.theme.exportSuccess', { path: result.filePath || '' }), 'success');
      } catch (e) {
        this.showToast(t('settings.theme.exportFailed', { error: e.message || String(e) }), 'error');
      }
    },

    async deleteTheme() {
      const id = this.theme.selectedId;
      if (!id) return;
      const meta = this.theme.themeList.find(m => m.id === id);
      if (!meta) return;
      if (meta.source === 'builtin') {
        this.showToast(t('settings.theme.cannotDeleteBuiltin'), 'error');
        return;
      }
      const confirmed = await showConfirm(t('settings.theme.confirmDelete', { name: getThemeDisplayName(meta) }));
      if (!confirmed) return;
      if (window.electronAPI?.themeAPI?.delete) {
        try {
          await window.electronAPI.themeAPI.delete(id);
        } catch (e) {
          console.error('Failed to delete theme:', e);
          return;
        }
      }
      await this.refreshThemeList();
    },

    // ==================== Theme editor ====================
    openThemeEditor() {
      this.theme.editorActive = true;
      this.theme.editorVisible = true;
      this.theme.editorVersion++;
    },

    async closeThemeEditor(force = false) {
      if (!force && this.theme.editorActive) {
        const confirmed = await showConfirm(t('settings.theme.editor.closeConfirm'));
        if (!confirmed) return;
      }
      this.theme.editorVisible = false;
      this.theme.editorActive = false;
    },

    resolveToken(tokenName) {
      // Used by editor rows to read the current value (touches editorVersion
      // via the themeEditorGroups getter indirectly).
      return resolveTokenValue(tokenName);
    },

    hexForToken(tokenName) {
      return toHexForColorInput(resolveTokenValue(tokenName));
    },

    applyTokenChange(tokenName, value) {
      if (_editDebounce) clearTimeout(_editDebounce);
      _editDebounce = setTimeout(() => {
        try {
          themeManager.setOverrideValue(tokenName, value);
        } catch (e) {
          console.error('Failed to set token:', e);
        }
      }, 80);
    },

    editorUndo() {
      if (themeManager.undo()) this.theme.editorVersion++;
    },

    editorRedo() {
      if (themeManager.redo()) this.theme.editorVersion++;
    },

    async editorResetAll() {
      const confirmed = await showConfirm(t('settings.theme.editor.resetAll') + '?');
      if (!confirmed) return;
      themeManager.clearOverrides();
      this.theme.editorVersion++;
    },

    editorResetToken(tokenName) {
      const def = TOKEN_CATALOG[tokenName]?.default || '';
      this.applyTokenChange(tokenName, def);
      // Apply immediately (bypass debounce) so the re-render reflects the default.
      try {
        themeManager.setOverrideValue(tokenName, def);
      } catch (e) {
        console.error('Failed to set token:', e);
      }
      this.theme.editorVersion++;
    },

    // ==================== Save-as modal ====================
    openSaveAsModal() {
      this.theme.saveAsVisible = true;
      this.theme.saveAsId = '';
      const selectedMeta = this.theme.themeList.find(m => m.id === this.theme.selectedId);
      this.theme.saveAsName = selectedMeta ? getThemeDisplayName(selectedMeta) : '';
      this.theme.saveAsIdError = '';
      this.theme.saveAsIdErrorVisible = false;
    },

    closeSaveAsModal() {
      this.theme.saveAsVisible = false;
    },

    clearSaveAsIdError() {
      this.theme.saveAsIdErrorVisible = false;
    },

    async confirmSaveAs() {
      const id = this.theme.saveAsId.trim();
      const name = this.theme.saveAsName.trim() || id;
      if (!isValidThemeId(id)) {
        this.theme.saveAsIdError = t('settings.theme.saveAsInvalidId');
        this.theme.saveAsIdErrorVisible = true;
        return;
      }
      if (this.theme.themeList.some(m => m.id === id)) {
        this.theme.saveAsIdError = t('settings.theme.saveAsIdExists', { id });
        this.theme.saveAsIdErrorVisible = true;
        return;
      }
      const cur = themeManager.currentTokens();
      const baseTheme = cur ? themeManager.get(this.theme.selectedId) : null;
      const tokens = { ...(baseTheme?.tokens || {}), ...(cur?.overrides || {}) };
      const newTheme = {
        id,
        name,
        version: '1.0.0',
        isDark: computeIsDark(tokens),
        tokens,
      };
      const result = validate(newTheme, { getThemeById: (id2) => themeManager.get(id2) });
      if (!result.ok) {
        this.theme.saveAsIdError = result.errors.map(e => e.message).join('; ');
        this.theme.saveAsIdErrorVisible = true;
        return;
      }
      const normalized = normalize(newTheme);
      if (window.electronAPI?.themeAPI?.save) {
        try {
          const saveResult = await window.electronAPI.themeAPI.save(normalized);
          if (!saveResult || !saveResult.ok) {
            this.theme.saveAsIdError = (saveResult && saveResult.error) || 'save failed';
            this.theme.saveAsIdErrorVisible = true;
            return;
          }
        } catch (e) {
          this.theme.saveAsIdError = e.message || String(e);
          this.theme.saveAsIdErrorVisible = true;
          return;
        }
      } else {
        try {
          themeManager.register({ ...normalized, source: 'user' });
        } catch (e) {
          this.theme.saveAsIdError = e.message || String(e);
          this.theme.saveAsIdErrorVisible = true;
          return;
        }
      }
      this.closeSaveAsModal();
      await this.closeThemeEditor(true);
      await this.refreshThemeList();
      this.theme.selectedId = id;
      this.showToast(t('settings.theme.saveAsTitle') + ': ' + name, 'success');
    },

    // ==================== Bootstrap ====================
    async initThemeList() {
      try {
        if (window.electronAPI?.themeAPI?.list) {
          const current = await window.electronAPI.themeAPI.current({ scope: 'global' });
          this.theme.themeList = await window.electronAPI.themeAPI.list();
          if (current && current.themeId) this.theme.selectedId = current.themeId;
        } else {
          themeManager.registerBuiltins(BUILTIN_THEMES);
          this.buildThemeListFallback();
          const cur = themeManager.current()?.themeId || null;
          if (cur) this.theme.selectedId = cur;
        }
      } catch (e) {
        console.error('Failed to initialize theme list:', e);
      }
    },

    async init() {
      // App version
      (async () => {
        try {
          const version = await window.electronAPI.getAppVersion();
          this.appVersion = `v${version}`;
        } catch (_) {
          this.appVersion = 'v1.0.0';
        }
      })();

      // Load devices + saved settings, check SiFiGAN availability (parallel)
      this.loadDevices().catch(() => {});
      this.checkSifiganVocoderFiles().catch(() => {});

      // Vocoder chunk frames table (independent of GPU detection)
      this.loadVocoderChunkFramesTable();

      // Smart allocation result — retry until gpuPhase === 'full' (max 30s)
      (async () => {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          await this.loadVocoderChunkFramesInfo();
          if (_vocoderChunkInfoLoaded) break;
          await new Promise(r => setTimeout(r, 2000));
        }
      })();

      // Check model availability on load
      if (window.electronAPI?.checkModels) {
        window.electronAPI.checkModels().then(modelStatus => {
          this.updateModelStatusDisplay(modelStatus);
        }).catch(() => {});
      }

      // Model overview (after i18n — but initI18n already ran in the entry)
      this.refreshModelOverview().catch(() => {});

      // Update section
      this.initUpdateSection().catch(() => {});

      // Theme list
      this.initThemeList().catch(() => {});

      // Listen for theme list changes from main process
      if (window.electronAPI?.themeAPI?.onListChanged) {
        const cleanup = window.electronAPI.themeAPI.onListChanged(async () => {
          await this.refreshThemeList();
        });
        if (cleanup) _cleanups.push(cleanup);
      }

      // Listen for model-download window close: refresh overview + status + SiFiGAN
      if (window.electronAPI?.onModelDownloadWindowClosed) {
        const cleanup = window.electronAPI.onModelDownloadWindowClosed(() => {
          this.refreshModelOverview().catch(() => {});
          if (window.electronAPI?.checkModels) {
            window.electronAPI.checkModels().then(modelStatus => {
              this.updateModelStatusDisplay(modelStatus);
            }).catch(() => {});
          }
          this.checkSifiganVocoderFiles().catch(() => {});
        });
        if (cleanup) _cleanups.push(cleanup);
      }
    },

    destroy() {
      for (const fn of _cleanups) {
        try { fn && fn(); } catch (_) {}
      }
      _cleanups.length = 0;
      if (_saveDebounce) { clearTimeout(_saveDebounce); _saveDebounce = null; }
      if (_editDebounce) { clearTimeout(_editDebounce); _editDebounce = null; }
      if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
    },
  },
});

function _statusText(state, availableKey, unavailableKey) {
  if (state === 'available') return t(availableKey);
  if (state === 'unavailable') return t(unavailableKey);
  return t('settings.webnnChecking');
}

// Lazy import of the confirm dialog to avoid a circular dependency at module
// load time (alertDialogService imports Vue + i18n; this store imports themes).
let _confirmImpl = null;
async function showConfirm(message) {
  if (!_confirmImpl) {
    const mod = await import('../../components/alertDialogService.js');
    _confirmImpl = mod.showConfirmDialog;
  }
  return _confirmImpl(message);
}
