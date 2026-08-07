<!--
  SingerCreatorApp.vue — full Vue 3 migration of src/singerCreator.js.

  Replaces the entire static HTML body of singerCreator.html. All UI markup
  (toolbar, left form panel: name/color/avatar/wav upload+info+waveform,
  right preview panel, wav trim overlay with canvas + selection controls)
  lives in this template; all logic (name input, avatar color/image
  selection, wav upload via file picker + drag-drop, wav info display,
  waveform canvas drawing + click-to-seek, play/pause preview, clear wav,
  preprocess action, save/save-as, wav trim overlay with canvas waveform +
  drag selection + numeric inputs + clip preview, WAV encoding) lives in
  <script setup>. The Pinia store at ./store.js owns the reactive domain
  state + IPC actions; this component owns canvas refs, AudioContext nodes,
  playback runtime state, drag state, and document-level listeners.
-->
<template>
  <!-- Top toolbar -->
  <div id="toolbar">
    <div class="toolbar-group">
      <button id="btn-cancel" @click="onCancel">
        <Icon name="close" :size="14" />
        {{ $t('singerCreator.cancel') }}
      </button>
    </div>
    <div class="toolbar-divider"></div>
    <div class="toolbar-group">
      <span id="page-title">{{ $t('singerCreator.title') }}</span>
    </div>
    <div class="toolbar-spacer"></div>
    <div class="toolbar-group">
      <button id="btn-save" class="btn-primary" @click="onSave">
        <Icon name="save" :size="14" />
        {{ $t('singerCreator.save') }}
      </button>
    </div>
  </div>

  <!-- Main content -->
  <div id="main-content">
    <!-- Left form panel -->
    <div id="left-panel">
      <div class="panel-section">
        <div class="section-title">{{ $t('singerCreator.basicInfo') }}</div>
        <div class="form-group">
          <label for="singer-name-input">{{ $t('singerCreator.singerName') }}</label>
          <input
            type="text"
            id="singer-name-input"
            :value="store.singerName"
            @input="store.setSingerName($event.target.value)"
            :placeholder="$t('singerCreator.singerNamePlaceholder')"
          />
        </div>
        <div class="form-group">
          <label>{{ $t('singerCreator.avatar') }}</label>
          <div id="avatar-options">
            <div class="avatar-option">
              <label class="radio-label">
                <input
                  type="radio"
                  name="avatar-type"
                  value="color"
                  :checked="store.avatarMode === 'color'"
                  @change="store.setAvatarMode('color')"
                />
                <span>{{ $t('singerCreator.color') }}</span>
              </label>
              <input
                type="color"
                id="singer-color-input"
                v-model="store.singerColor"
                :disabled="store.useAvatarImage"
              />
            </div>
            <div class="avatar-option">
              <label class="radio-label">
                <input
                  type="radio"
                  name="avatar-type"
                  value="image"
                  :checked="store.avatarMode === 'image'"
                  @change="store.setAvatarMode('image')"
                />
                <span>{{ $t('singerCreator.image') }}</span>
              </label>
              <input
                type="file"
                id="avatar-file-input"
                accept="image/*"
                hidden
                ref="avatarFileInputRef"
                @change="onAvatarFileChange"
              />
              <button id="btn-select-avatar" class="btn-small" @click="avatarFileInputRef && avatarFileInputRef.click()">
                {{ $t('singerCreator.selectImage') }}
              </button>
            </div>
          </div>
          <div
            id="avatar-preview"
            class="avatar-preview"
            v-if="store.avatarImageData"
          >
            <img id="avatar-preview-img" :src="store.avatarImageData" :alt="$t('singerCreator.avatarPreview')" />
            <button id="btn-clear-avatar" class="btn-small btn-danger" @click="onClearAvatar">
              {{ $t('singerCreator.clear') }}
            </button>
          </div>
        </div>
      </div>

      <div class="panel-section">
        <div class="section-title">{{ $t('singerCreator.refAudioWav') }}</div>
        <div
          class="upload-area"
          id="wav-upload-area"
          v-if="!store.wavInfoVisible"
          :style="{ borderColor: wavDragOver ? 'var(--accent)' : 'var(--border-default)' }"
          @click="onWavAreaClick"
          @dragover.prevent="wavDragOver = true"
          @dragleave="wavDragOver = false"
          @drop.prevent="onWavDrop"
        >
          <div class="upload-icon"><Icon name="music" :size="28" /></div>
          <div class="upload-text">{{ $t('singerCreator.uploadWav') }}</div>
          <div class="upload-hint">{{ $t('singerCreator.wavHint') }}</div>
          <input
            type="file"
            id="wav-file-input"
            accept=".wav,.mp3,.flac,.aac,.m4a,.ogg,.webm,.aiff,.opus"
            hidden
            ref="wavFileInputRef"
            @change="onWavFileChange"
          />
        </div>
        <div id="wav-info" class="info-box" v-if="store.wavInfoVisible">
          <div class="info-row">
            <span class="info-label">{{ $t('singerCreator.file') }}</span>
            <span id="wav-filename" class="info-value">{{ store.wavFileName || '-' }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">{{ $t('singerCreator.duration') }}</span>
            <span id="wav-duration" class="info-value">{{ store.wavDuration.toFixed(2) }}{{ $t('singerCreator.seconds') }}</span>
          </div>
          <div id="waveform-container">
            <canvas
              id="waveform-canvas"
              ref="waveformCanvasRef"
              role="img"
              :aria-label="$t('singerCreator.waveformPreviewAriaLabel')"
              @mousedown="onWaveformMouseDown"
            ></canvas>
          </div>
          <div class="info-actions">
            <button id="btn-play-preview" class="btn-small" @click="onPlayPreviewClick">
              <Icon name="play" :size="14" />
              {{ playButtonText }}
            </button>
            <button id="btn-clear-wav" class="btn-small btn-danger" @click="onClearWav">
              {{ $t('singerCreator.clear') }}
            </button>
          </div>
        </div>
        <div class="info-actions" id="preprocess-actions" v-if="store.wavInfoVisible" style="margin-top: 12px;">
          <button id="btn-start-preprocess" class="btn-small btn-primary" @click="onStartPreprocess">
            <Icon name="sliders" :size="14" />
            {{ $t('singerCreator.startPreprocess') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Right preview panel -->
    <div id="right-panel">
      <div id="preview-container">
        <div class="preview-title">{{ $t('singerCreator.singerPreview') }}</div>
        <div id="preview-placeholder" class="preview-placeholder" v-if="!store.hasWav">
          <div class="placeholder-icon"><Icon name="microphone" :size="48" /></div>
          <div class="placeholder-text">{{ $t('singerCreator.previewPlaceholder') }}</div>
        </div>
        <div id="preview-content" v-if="store.hasWav">
          <div id="preview-singer-info">
            <div
              id="preview-avatar"
              class="preview-avatar"
              :style="{ backgroundColor: store.useAvatarImage ? 'transparent' : store.singerColor }"
            >
              <img
                v-if="store.useAvatarImage"
                :src="store.avatarImageData"
                :alt="store.singerName.trim() || $t('singerCreator.unnamedSinger')"
              />
              <Icon v-else name="microphone" :size="22" />
            </div>
            <div id="preview-details">
              <div id="preview-name">{{ store.singerName.trim() || $t('singerCreator.unnamedSinger') }}</div>
              <div id="preview-status">
                <span id="preview-wav-status" class="status-badge" :class="{ ready: store.hasWav }">
                  {{ store.hasWav ? $t('singerCreator.wavReady') : $t('singerCreator.wavStatus') }}
                </span>
                <span id="preview-preprocess-status" class="status-badge" :class="{ ready: store.isPreprocessed }">
                  {{ store.isPreprocessed ? $t('singerCreator.preprocessReady') : $t('singerCreator.preprocessStatus') }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 音频截取模态框 -->
  <div id="wav-trim-overlay" class="modal-overlay" v-if="store.trimVisible">
    <div id="wav-trim-dialog" class="modal-dialog">
      <div class="modal-title">{{ $t('singerCreator.wavTrimTitle') }}</div>
      <div class="modal-hint">{{ $t('singerCreator.wavTrimHint') }}</div>
      <div
        id="wav-trim-waveform-wrapper"
        ref="trimWrapperRef"
        @mousedown="onTrimWrapperMouseDown"
        @touchstart="onTrimWrapperTouchStart"
      >
        <canvas id="wav-trim-canvas" ref="trimCanvasRef"></canvas>
        <div id="wav-trim-selection" :style="trimSelectionStyle">
          <div id="wav-trim-handle-left" class="trim-handle"></div>
          <div id="wav-trim-handle-right" class="trim-handle"></div>
          <div id="wav-trim-label-start" class="trim-label">{{ store.trimStart.toFixed(1) }}s</div>
          <div id="wav-trim-label-end" class="trim-label">{{ (store.trimStart + store.trimLength).toFixed(1) }}s</div>
        </div>
      </div>
      <div id="wav-trim-time-axis" ref="trimTimeAxisRef">
        <div
          v-for="tick in trimTimeTicks"
          :key="tick.time"
          class="trim-tick"
          :style="{
            position: 'absolute',
            left: tick.pct + '%',
            bottom: '0',
            fontSize: '9px',
            color: 'var(--fg-muted)',
            transform: 'translateX(-50%)'
          }"
        >{{ tick.time }}s</div>
      </div>
      <div id="wav-trim-controls">
        <div class="trim-control-group">
          <label>{{ $t('singerCreator.wavTrimStart') }}</label>
          <input
            type="number"
            id="trim-start-input"
            min="0"
            step="0.1"
            :max="trimStartMax"
            ref="trimStartInputRef"
            @input="onTrimStartInput"
          />
          <span class="trim-unit">s</span>
        </div>
        <div class="trim-control-group">
          <label>{{ $t('singerCreator.wavTrimLength') }}</label>
          <input
            type="number"
            id="trim-length-input"
            min="0.1"
            :max="store.MAX_TRIM_DURATION"
            step="0.1"
            ref="trimLengthInputRef"
            @input="onTrimLengthInput"
          />
          <span class="trim-unit">s</span>
        </div>
      </div>
      <div id="wav-trim-actions">
        <button id="btn-trim-preview" class="btn-small btn-primary" @click="onTrimPreviewClick">
          <Icon name="play" :size="14" />
          {{ trimPreviewButtonText }}
        </button>
        <button id="btn-trim-confirm" class="btn-small btn-primary" @click="onTrimConfirm">
          {{ $t('singerCreator.wavTrimConfirm') }}
        </button>
        <button id="btn-trim-cancel" class="btn-small btn-danger" @click="onTrimCancel">
          {{ $t('singerCreator.wavTrimCancel') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { useSingerCreatorStore, MAX_TRIM_DURATION } from './store.js';
import { initWindowTheme } from '../../../themes/themeInit.js';
import { t, getLocale } from '../../../i18n/index.js';
import { showAlertDialog } from '../../components/alertDialogService.js';
import * as spa from '../../../spa/router.js';

// Pull in the CSS the vanilla-JS bootstrap imported so the existing
// #toolbar / .upload-area / .info-box / .modal-overlay / #wav-trim-* styles
// still apply.
import '../../../common.css';
import '../../../singerCreator.css';

const store = useSingerCreatorStore();

// ==================== Canvas / element refs ====================
const waveformCanvasRef = ref(null);
const trimCanvasRef = ref(null);
const trimWrapperRef = ref(null);
const trimTimeAxisRef = ref(null);
const trimStartInputRef = ref(null);
const trimLengthInputRef = ref(null);
const wavFileInputRef = ref(null);
const avatarFileInputRef = ref(null);

// ==================== Component-local UI state ====================
const wavDragOver = ref(false);
const isPlayingPreview = ref(false);
const isTrimPreviewPlaying = ref(false);

// Selection wrapper width (measured from DOM; drives trimSelectionStyle).
const trimWrapperWidth = ref(0);

// ==================== Playback runtime state (non-reactive) ====================
// AudioContext / source nodes / RAF ids / play offsets are transient and tied
// to the component lifecycle — kept as plain `let`s so Vue does not track them.
let previewAudioContext = null;
let previewAudioSource = null;
let previewPlayStartContextTime = 0;
let previewPlayStartOffset = 0;
let previewRaf = null;

let trimPreviewContext = null;
let trimPreviewSource = null;

// ==================== Drag state (non-reactive) ====================
let _waveformDragging = false;
let trimDragging = null; // 'selection' | 'left' | 'right'
let trimDragStartX = 0;
let trimDragStartValue = 0;

// ==================== IPC listener cleanups ====================
let _preprocessCleanup = null;
let _saveReqCleanup = null;
let _saveAsReqCleanup = null;
const _themeCleanups = [];

// ==================== Computed ====================
const playButtonText = computed(() =>
  isPlayingPreview.value
    ? t('singerCreator.pausePreview')
    : t('singerCreator.preview')
);

const trimPreviewButtonText = computed(() =>
  isTrimPreviewPlaying.value
    ? t('singerCreator.wavTrimStopPreview')
    : t('singerCreator.wavTrimPreview')
);

const trimStartMax = computed(() =>
  store.trimTotalDuration ? (store.trimTotalDuration - 0.1).toFixed(1) : 0
);

const trimSelectionStyle = computed(() => {
  const total = store.trimTotalDuration;
  if (!total || !trimWrapperWidth.value) {
    return { left: '0px', width: '0px' };
  }
  const leftPx = (store.trimStart / total) * trimWrapperWidth.value;
  const rightPx = ((store.trimStart + store.trimLength) / total) * trimWrapperWidth.value;
  return { left: leftPx + 'px', width: (rightPx - leftPx) + 'px' };
});

// Time-axis ticks for the trim waveform. Positioned by percentage so no DOM
// width measurement is needed (unlike the original px-based ticks).
const trimTimeTicks = computed(() => {
  const total = store.trimTotalDuration;
  if (!total) return [];
  let interval = 5;
  if (total <= 60) interval = 5;
  else if (total <= 120) interval = 10;
  else interval = 15;
  const ticks = [];
  for (let time = 0; time <= total; time += interval) {
    ticks.push({ time, pct: (time / total) * 100 });
  }
  return ticks;
});

// ==================== Avatar handlers ====================
function onAvatarFileChange(e) {
  if (e.target.files.length > 0) {
    handleAvatarFile(e.target.files[0]);
  }
}

function handleAvatarFile(file) {
  if (!file.type.startsWith('image/')) {
    showAlertDialog(t('singerCreator.pleaseSelectImage'));
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    store.setAvatarImage(e.target.result, file.name);
  };
  reader.onerror = () => {
    showAlertDialog(t('singerCreator.imageReadFailed'));
  };
  reader.readAsDataURL(file);
}

function onClearAvatar() {
  store.clearAvatar();
  if (avatarFileInputRef.value) avatarFileInputRef.value.value = '';
}

// ==================== WAV upload handlers ====================
function onWavAreaClick() {
  if (wavFileInputRef.value) wavFileInputRef.value.click();
}

function onWavFileChange(e) {
  if (e.target.files.length > 0) {
    handleWavFile(e.target.files[0]);
  }
  e.target.value = '';
}

function onWavDrop(e) {
  wavDragOver.value = false;
  if (e.dataTransfer.files.length > 0) {
    handleWavFile(e.dataTransfer.files[0]);
  }
}

async function handleWavFile(file) {
  // Accept all common audio formats — Web Audio API's decodeAudioData
  // handles WAV, MP3, M4A, AAC, OGG, FLAC, WebM, etc. depending on the
  // platform's media framework. If a format isn't supported, the
  // decodeAudioData call will throw and we show a clear error.
  const supportedExtensions = ['.wav', '.mp3', '.flac', '.aac', '.m4a', '.ogg', '.webm', '.aiff', '.opus', '.wma'];
  const lowerName = file.name.toLowerCase();
  const isSupported = supportedExtensions.some(ext => lowerName.endsWith(ext));
  if (!isSupported) {
    showAlertDialog(t('singerCreator.unsupportedFormatDetail', {
      formats: supportedExtensions.join(', ')
    }));
    return;
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    let audioBuffer;
    try {
      audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    } catch (decodeErr) {
      // decodeAudioData failed — the format may not be supported by the
      // platform's media framework (e.g. FLAC on some Android WebViews).
      audioCtx.close();
      throw new Error(t('singerCreator.decodeFailedDetail', {
        format: lowerName.match(/\.[^.]+$/)?.[0] || file.name,
        detail: decodeErr.message || decodeErr
      }));
    }
    const duration = audioBuffer.duration;
    audioCtx.close();

    if (duration > MAX_TRIM_DURATION) {
      // Load into the trim dialog without committing to the main display.
      store.prepareTrim(audioBuffer, file.name, duration);
      nextTick(() => requestAnimationFrame(() => {
        drawTrimWaveform();
        updateTrimSelectionUI();
      }));
      return;
    }

    store.setWavData({ arrayBuffer, audioBuffer, duration, fileName: file.name });
    nextTick(() => requestAnimationFrame(() => drawWaveform(0)));
  } catch (err) {
    console.error(t('singerCreator.wavParseError'), err);
    // W24: use t(key, params) instead of t(key) + ': ' + value concatenation.
    showAlertDialog(t('singerCreator.wavParseFailedDetail', { detail: err.message }));
    store.clearWav();
  }
}

function onClearWav() {
  stopPreviewPlayback();
  store.clearWav();
}

// ==================== Waveform canvas drawing ====================
function drawWaveform(currentTime) {
  const audioBuffer = store.wavAudioBuffer;
  if (!audioBuffer) return;

  const canvas = waveformCanvasRef.value;
  if (!canvas) return;
  const container = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const width = container.clientWidth;
  const height = container.clientHeight || 60;

  if (width <= 0 || height <= 0) {
    requestAnimationFrame(() => drawWaveform(currentTime));
    return;
  }

  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  canvas.width = width * dpr;
  canvas.height = height * dpr;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(0, 0, width, height);

  const data = audioBuffer.getChannelData(0);
  const samplesPerPixel = data.length / width;
  const mid = height / 2;
  const wavDuration = store.wavDuration;

  ctx.fillStyle = '#3498db';
  for (let i = 0; i < width; i++) {
    const startSample = Math.floor(i * samplesPerPixel);
    const endSample = Math.floor((i + 1) * samplesPerPixel);
    let min = 1.0;
    let max = -1.0;
    for (let j = startSample; j < endSample; j++) {
      const datum = data[j];
      if (datum < min) min = datum;
      if (datum > max) max = datum;
    }
    const barHeight = Math.max(1, ((max - min) / 2) * height);
    ctx.fillRect(i, mid - barHeight / 2, 1, barHeight);
  }

  if (currentTime !== undefined && currentTime >= 0 && currentTime <= wavDuration) {
    const playheadX = (currentTime / wavDuration) * width;

    ctx.fillStyle = 'rgba(52, 152, 219, 0.25)';
    ctx.fillRect(0, 0, playheadX, height);

    ctx.strokeStyle = '#ff4444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();

    ctx.fillStyle = '#ff4444';
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX - 5, -2);
    ctx.lineTo(playheadX + 5, -2);
    ctx.closePath();
    ctx.fill();
  }
}

function getWaveformTime(clientX) {
  const canvas = waveformCanvasRef.value;
  if (!canvas) return 0;
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const width = rect.width;
  return Math.max(0, Math.min(store.wavDuration, (x / width) * store.wavDuration));
}

function onWaveformMouseDown(e) {
  if (!store.wavAudioBuffer || !store.wavDuration) return;
  e.preventDefault();
  _waveformDragging = true;
  const time = getWaveformTime(e.clientX);
  if (isPlayingPreview.value) stopPreviewPlayback();
  previewPlayStartOffset = time;
  drawWaveform(time);
}

function onWaveformDragMove(clientX) {
  if (!_waveformDragging) return;
  const time = getWaveformTime(clientX);
  previewPlayStartOffset = time;
  drawWaveform(time);
}

// ==================== Preview playback ====================
async function onPlayPreviewClick() {
  if (!store.wavAudioBuffer) return;
  if (isPlayingPreview.value) {
    pausePreviewPlayback();
  } else {
    await playPreviewWav();
  }
}

async function playPreviewWav() {
  const audioBuffer = store.wavAudioBuffer;
  if (!audioBuffer) return;

  try {
    if (!previewAudioContext || previewAudioContext.state === 'closed') {
      previewAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    if (previewAudioContext.state === 'suspended') {
      await previewAudioContext.resume();
    }

    const source = previewAudioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(previewAudioContext.destination);

    let startOffset = (previewPlayStartOffset > 0 && previewPlayStartOffset < audioBuffer.duration)
      ? previewPlayStartOffset
      : 0;
    previewPlayStartOffset = startOffset;

    // Schedule playback slightly in the future so the audio system has time to
    // prepare the first buffer. Aligning the baseline to scheduledStartTime +
    // outputLatency keeps the playhead in sync with what is actually heard.
    const SCHEDULE_AHEAD = 0.05;
    const scheduledStartTime = previewAudioContext.currentTime + SCHEDULE_AHEAD;
    const outputLatency = (previewAudioContext.outputLatency != null
      ? previewAudioContext.outputLatency
      : previewAudioContext.baseLatency) || 0;
    source.start(scheduledStartTime, startOffset);

    source.onended = () => {
      if (isPlayingPreview.value) {
        isPlayingPreview.value = false;
        previewPlayStartOffset = 0;
        stopPreviewRaf();
        drawWaveform(0);
      }
    };

    previewAudioSource = source;
    isPlayingPreview.value = true;
    previewPlayStartContextTime = scheduledStartTime + outputLatency;
    startPreviewPlaybackLoop();
  } catch (err) {
    console.error(t('singerCreator.previewPlayFailed'), err);
  }
}

function pausePreviewPlayback() {
  if (!isPlayingPreview.value) return;

  isPlayingPreview.value = false;
  if (previewAudioSource) {
    try {
      previewAudioSource.onended = null;
      previewAudioSource.stop();
    } catch (e) {}
    previewAudioSource = null;
  }

  const elapsed = Math.max(0, previewAudioContext.currentTime - previewPlayStartContextTime);
  previewPlayStartOffset += elapsed;

  if (previewPlayStartOffset >= store.wavDuration) {
    previewPlayStartOffset = 0;
  }

  stopPreviewRaf();
  drawWaveform(previewPlayStartOffset);
}

function startPreviewPlaybackLoop() {
  if (!isPlayingPreview.value) return;

  // Clamp to 0 so the playhead stays put until the scheduled (audible) start
  // time is reached, instead of running ahead of the audio.
  const elapsed = Math.max(0, previewAudioContext.currentTime - previewPlayStartContextTime);
  const currentTime = previewPlayStartOffset + elapsed;

  drawWaveform(currentTime);

  previewRaf = requestAnimationFrame(() => startPreviewPlaybackLoop());
}

function stopPreviewRaf() {
  if (previewRaf) {
    cancelAnimationFrame(previewRaf);
    previewRaf = null;
  }
}

function stopPreviewPlayback() {
  stopPreviewRaf();
  if (previewAudioSource) {
    try {
      previewAudioSource.onended = null;
      previewAudioSource.stop();
    } catch (e) {}
    previewAudioSource = null;
  }
  if (previewAudioContext && previewAudioContext.state !== 'closed') {
    previewAudioContext.close().catch(() => {});
    previewAudioContext = null;
  }
  isPlayingPreview.value = false;
  previewPlayStartOffset = 0;
  if (store.wavAudioBuffer) {
    drawWaveform(0);
  }
}

// ==================== Preprocess / save handlers ====================
function onStartPreprocess() {
  if (!store.wavFileBuffer) {
    showAlertDialog(t('singerCreator.pleaseUploadWav'));
    return;
  }
  if (!window.electronAPI || !window.electronAPI.openAudioPreprocess) {
    showAlertDialog(t('singerCreator.preprocessUnavailable'));
    return;
  }
  stopPreviewPlayback();
  store.openAudioPreprocess();
}

async function onSave() {
  await performSave(false);
}

async function performSave(isSaveAs = false) {
  const result = await store.performSave(isSaveAs);
  if (!result) return;
  if (result.success) {
    showAlertDialog(t('singerCreator.saved'));
  } else if (result.canceled || result.busy) {
    // User cancelled the Save As dialog or a save is already in-flight — no-op.
  } else if (result.error) {
    showAlertDialog(result.error);
  }
}

function onCancel() {
  stopPreviewPlayback();
  cleanupIpcListeners();
  // The singer-creator view is an SPA route inside the single Tauri WebView,
  // NOT a separate OS window. `window.close()` is a no-op here — navigate back
  // to the main route instead. `history.back()` is the fallback so a deep-link
  // entry (no SPA history) still escapes; if even that fails, navigate forward
  // to `main` explicitly.
  if (typeof window !== 'undefined' && window.history && window.history.length > 1) {
    try { window.history.back(); return; } catch (_) { /* fall through */ }
  }
  spa.navigate('main');
}

// ==================== WAV trim dialog: drawing ====================
function drawWaveformBars(ctx, data, fromX, toX, samplesPerPixel, height, mid, color, canvasWidth) {
  ctx.fillStyle = color;
  const maxX = canvasWidth != null ? canvasWidth : toX;
  for (let i = fromX; i < toX; i++) {
    if (i < 0 || i >= maxX) continue;
    const startSample = Math.floor(i * samplesPerPixel);
    const endSample = Math.floor((i + 1) * samplesPerPixel);
    let min = 1.0;
    let max = -1.0;
    for (let j = startSample; j < endSample; j++) {
      const datum = data[j];
      if (datum < min) min = datum;
      if (datum > max) max = datum;
    }
    const barHeight = Math.max(1, ((max - min) / 2) * height);
    ctx.fillRect(i, mid - barHeight / 2, 1, barHeight);
  }
}

function drawTrimWaveform() {
  const audioBuffer = store.trimAudioBuffer;
  if (!audioBuffer) return;

  const canvas = trimCanvasRef.value;
  if (!canvas) return;
  const wrapper = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const width = wrapper.clientWidth;
  const height = wrapper.clientHeight || 100;

  if (width <= 0 || height <= 0) {
    requestAnimationFrame(() => drawTrimWaveform());
    return;
  }

  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  canvas.width = width * dpr;
  canvas.height = height * dpr;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#14141f';
  ctx.fillRect(0, 0, width, height);

  const data = audioBuffer.getChannelData(0);
  const samplesPerPixel = data.length / width;
  const mid = height / 2;

  const total = store.trimTotalDuration;
  const selLeft = (store.trimStart / total) * width;
  const selRight = ((store.trimStart + store.trimLength) / total) * width;

  // 基础波形
  drawWaveformBars(ctx, data, 0, width, samplesPerPixel, height, mid, '#3a3a52');

  // 选区外暗化
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.fillRect(0, 0, selLeft, height);
  ctx.fillRect(selRight, 0, width - selRight, height);

  // 选区内高亮波形
  drawWaveformBars(ctx, data, Math.floor(selLeft), Math.ceil(selRight), samplesPerPixel, height, mid, '#5b8def', width);
}

function updateTrimSelectionUI() {
  if (!store.trimTotalDuration) return;
  const wrapper = trimWrapperRef.value;
  if (!wrapper) return;
  const width = wrapper.clientWidth;
  if (width <= 0) {
    requestAnimationFrame(() => updateTrimSelectionUI());
    return;
  }
  trimWrapperWidth.value = width;
  // Sync the numeric inputs with the clamped values (uncontrolled inputs).
  if (trimStartInputRef.value) trimStartInputRef.value.value = store.trimStart.toFixed(1);
  if (trimLengthInputRef.value) trimLengthInputRef.value.value = store.trimLength.toFixed(1);
}

// ==================== WAV trim dialog: selection drag ====================
function handleTrimPointerDown(clientX) {
  if (!store.trimAudioBuffer) return;

  const wrapper = trimWrapperRef.value;
  if (!wrapper) return;
  const rect = wrapper.getBoundingClientRect();
  const x = clientX - rect.left;
  const width = rect.width;
  const total = store.trimTotalDuration;

  const selLeft = (store.trimStart / total) * width;
  const selRight = ((store.trimStart + store.trimLength) / total) * width;

  const handleZone = 8;

  if (Math.abs(x - selLeft) < handleZone) {
    trimDragging = 'left';
  } else if (Math.abs(x - selRight) < handleZone) {
    trimDragging = 'right';
  } else if (x > selLeft && x < selRight) {
    trimDragging = 'selection';
    trimDragStartX = clientX;
    trimDragStartValue = store.trimStart;
  } else {
    const clickTime = (x / width) * total;
    store.trimStart = Math.max(0, Math.min(clickTime - store.trimLength / 2, total - store.trimLength));
    store.clampTrimValues();
    drawTrimWaveform();
    updateTrimSelectionUI();
    trimDragging = 'selection';
    trimDragStartX = clientX;
    trimDragStartValue = store.trimStart;
  }
}

function handleTrimPointerMove(clientX) {
  if (!trimDragging || !store.trimAudioBuffer) return;

  const wrapper = trimWrapperRef.value;
  if (!wrapper) return;
  const width = wrapper.clientWidth;
  const total = store.trimTotalDuration;

  if (trimDragging === 'left') {
    const rect = wrapper.getBoundingClientRect();
    const x = clientX - rect.left;
    const fixedEnd = store.trimStart + store.trimLength;
    store.trimStart = Math.max(0, (x / width) * total);
    store.trimLength = fixedEnd - store.trimStart;
    if (store.trimLength > MAX_TRIM_DURATION) {
      store.trimLength = MAX_TRIM_DURATION;
      store.trimStart = fixedEnd - MAX_TRIM_DURATION;
    }
    if (store.trimLength < 0.1) {
      store.trimLength = 0.1;
      store.trimStart = fixedEnd - 0.1;
    }
    store.clampTrimValues();
  } else if (trimDragging === 'right') {
    const rect = wrapper.getBoundingClientRect();
    const x = clientX - rect.left;
    const currentEnd = (x / width) * total;
    store.trimLength = Math.min(MAX_TRIM_DURATION, currentEnd - store.trimStart);
    store.clampTrimValues();
  } else if (trimDragging === 'selection') {
    const dx = clientX - trimDragStartX;
    const dTime = (dx / width) * total;
    store.trimStart = trimDragStartValue + dTime;
    store.clampTrimValues();
  }

  drawTrimWaveform();
  updateTrimSelectionUI();
}

function handleTrimPointerUp() {
  trimDragging = null;
}

function onTrimWrapperMouseDown(e) {
  handleTrimPointerDown(e.clientX);
  e.preventDefault();
}

function onTrimWrapperTouchStart(e) {
  if (e.touches.length === 1) {
    handleTrimPointerDown(e.touches[0].clientX);
    e.preventDefault();
  }
}

function onTrimStartInput(e) {
  const val = parseFloat(e.target.value);
  if (isNaN(val)) return;
  store.trimStart = val;
  store.clampTrimValues();
  drawTrimWaveform();
  updateTrimSelectionUI();
}

function onTrimLengthInput(e) {
  const val = parseFloat(e.target.value);
  if (isNaN(val)) return;
  store.trimLength = val;
  store.clampTrimValues();
  drawTrimWaveform();
  updateTrimSelectionUI();
}

// ==================== WAV trim dialog: clip preview ====================
async function onTrimPreviewClick() {
  if (isTrimPreviewPlaying.value) {
    stopTrimPreview();
    return;
  }

  const audioBuffer = store.trimAudioBuffer;
  if (!audioBuffer) return;

  try {
    trimPreviewContext = new (window.AudioContext || window.webkitAudioContext)();
    const sampleRate = audioBuffer.sampleRate;
    const startSample = Math.floor(store.trimStart * sampleRate);
    const lengthSamples = Math.floor(store.trimLength * sampleRate);
    const channels = audioBuffer.numberOfChannels;

    const previewBuffer = trimPreviewContext.createBuffer(channels, lengthSamples, sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      const srcData = audioBuffer.getChannelData(ch);
      const dstData = previewBuffer.getChannelData(ch);
      for (let i = 0; i < lengthSamples; i++) {
        dstData[i] = srcData[startSample + i] || 0;
      }
    }

    const source = trimPreviewContext.createBufferSource();
    source.buffer = previewBuffer;
    source.connect(trimPreviewContext.destination);
    source.start();
    source.onended = () => {
      isTrimPreviewPlaying.value = false;
    };

    trimPreviewSource = source;
    isTrimPreviewPlaying.value = true;
  } catch (err) {
    console.error('Trim preview failed:', err);
  }
}

function stopTrimPreview() {
  if (trimPreviewSource) {
    try { trimPreviewSource.onended = null; trimPreviewSource.stop(); } catch (e) {}
    trimPreviewSource = null;
  }
  if (trimPreviewContext && trimPreviewContext.state !== 'closed') {
    trimPreviewContext.close().catch(() => {});
    trimPreviewContext = null;
  }
  isTrimPreviewPlaying.value = false;
}

// ==================== WAV trim dialog: confirm / cancel ====================
function onTrimConfirm() {
  const audioBuffer = store.trimAudioBuffer;
  if (!audioBuffer) return;

  stopTrimPreview();

  try {
    const sampleRate = audioBuffer.sampleRate;
    const startSample = Math.floor(store.trimStart * sampleRate);
    const lengthSamples = Math.floor(store.trimLength * sampleRate);
    const channels = audioBuffer.numberOfChannels;

    // 创建截取后的 AudioBuffer
    const trimmedBuffer = new AudioBuffer({
      length: lengthSamples,
      sampleRate: sampleRate,
      numberOfChannels: channels,
    });
    for (let ch = 0; ch < channels; ch++) {
      const srcData = audioBuffer.getChannelData(ch);
      const dstData = trimmedBuffer.getChannelData(ch);
      for (let i = 0; i < lengthSamples; i++) {
        dstData[i] = srcData[startSample + i] || 0;
      }
    }

    // 编码为 WAV ArrayBuffer
    const wavArrayBuffer = encodeAudioBufferToWav(trimmedBuffer);

    store.commitTrim(trimmedBuffer, wavArrayBuffer);
    nextTick(() => requestAnimationFrame(() => drawWaveform(0)));
  } catch (err) {
    console.error('Trim encode failed:', err);
    // W24: use t(key, params) instead of t(key) + ': ' + value concatenation.
    showAlertDialog(t('singerCreator.wavTrimEncodeFailedDetail', { detail: err.message }));
  }
}

function onTrimCancel() {
  stopTrimPreview();
  store.closeTrim();
  // 清空已加载的WAV数据 (matches original: cancel clears the pending wav).
  store.clearWav();
}

// ==================== WAV encoding ====================
function encodeAudioBufferToWav(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = length * numChannels * (bitsPerSample / 8);
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // 交错写入采样数据
  let offset = 44;
  const channels = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(audioBuffer.getChannelData(ch));
  }

  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      let sample = channels[ch][i];
      sample = Math.max(-1, Math.min(1, sample));
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return buffer;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// ==================== Document-level listeners ====================
// Single document listeners serve both waveform dragging and trim selection
// dragging (mouse + touch), matching the original's document-level handlers.
function onDocMouseMove(e) {
  onWaveformDragMove(e.clientX);
  handleTrimPointerMove(e.clientX);
}

function onDocMouseUp() {
  _waveformDragging = false;
  handleTrimPointerUp();
}

function onDocTouchMove(e) {
  // Only hijack the touchmove gesture (and preventDefault to block page
  // scroll) while an actual trim-handle / waveform drag is in progress.
  // Without this guard the document-level `touchmove` listener would
  // swallow every single-finger pan — including the user trying to scroll
  // the #left-panel form on mobile, manifesting as "touch slide doesn't
  // work on the singer creator page".
  if (e.touches.length !== 1) return;
  if (!_waveformDragging && !trimDragging) return;
  handleTrimPointerMove(e.touches[0].clientX);
  e.preventDefault();
}

function onDocTouchEnd() {
  handleTrimPointerUp();
}

function registerDocListeners() {
  document.addEventListener('mousemove', onDocMouseMove);
  document.addEventListener('mouseup', onDocMouseUp);
  document.addEventListener('touchmove', onDocTouchMove, { passive: false });
  document.addEventListener('touchend', onDocTouchEnd);
  document.addEventListener('touchcancel', onDocTouchEnd);
}

function removeDocListeners() {
  document.removeEventListener('mousemove', onDocMouseMove);
  document.removeEventListener('mouseup', onDocMouseUp);
  document.removeEventListener('touchmove', onDocTouchMove);
  document.removeEventListener('touchend', onDocTouchEnd);
  document.removeEventListener('touchcancel', onDocTouchEnd);
}

// ==================== IPC listeners ====================
function registerIpcListeners() {
  if (window.electronAPI && window.electronAPI.onPreprocessDataSaved) {
    _preprocessCleanup = window.electronAPI.onPreprocessDataSaved((result) => {
      // 只有当WAV文件存在时才接受预处理数据，防止清除WAV后预处理窗口仍回调覆盖状态
      if (!store.wavFileBuffer) return;
      store.setPreprocessResult(result);
    });
  }
  // Menu-driven save / save-as requests (sent from the main process menu).
  // The menu also registers the Ctrl+S / Ctrl+Shift+S accelerators, which
  // trigger these same requests — no separate keydown listener is needed.
  if (window.electronAPI && window.electronAPI.onSingerCreatorSaveRequest) {
    _saveReqCleanup = window.electronAPI.onSingerCreatorSaveRequest(() => {
      performSave(false);
    });
  }
  if (window.electronAPI && window.electronAPI.onSingerCreatorSaveAsRequest) {
    _saveAsReqCleanup = window.electronAPI.onSingerCreatorSaveAsRequest(() => {
      performSave(true);
    });
  }
}

function cleanupIpcListeners() {
  if (_preprocessCleanup) { _preprocessCleanup(); _preprocessCleanup = null; }
  if (_saveReqCleanup) { _saveReqCleanup(); _saveReqCleanup = null; }
  if (_saveAsReqCleanup) { _saveAsReqCleanup(); _saveAsReqCleanup = null; }
}

// ==================== Lifecycle ====================
onMounted(() => {
  // Mirror the original bootstrap's document lang + theme + i18n hydration.
  document.documentElement.lang = getLocale();
  initWindowTheme(_themeCleanups);
  registerIpcListeners();
  registerDocListeners();
  console.log(t('singerCreator.pageStarted'));
});

onUnmounted(() => {
  stopPreviewPlayback();
  stopTrimPreview();
  cleanupIpcListeners();
  removeDocListeners();
  _themeCleanups.forEach((fn) => {
    try { fn && fn(); } catch (_) {}
  });
});
</script>

<style scoped>
/*
  Window-specific styles live in the globally-imported singerCreator.css
  (which targets #toolbar / .upload-area / .info-box / .modal-overlay /
  #wav-trim-* by id and class). Scoped styles here are intentionally empty —
  adding scoped styles would force a data-v-* attribute onto every element
  and break the id-based selectors in the global stylesheet.
*/
</style>
