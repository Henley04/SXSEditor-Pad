import { state, dom } from './state.js';
import { t } from '../i18n/index.js';
import { showAlertDialog } from '../alertDialog.js';
import { drawWaveformWithPlayhead } from './canvasRenderer.js';
import { initPianoRoll } from './pianoRoll.js';
import { processWavBuffer } from './audioLoader.js';
import { consumeMail } from '../spa/router.js';

// W21: IPC cleanup tracking array (mirrors renderer/fragmentEditor _ipcCleanups
// pattern). Each registered IPC listener pushes its unsubscribe function here
// so beforeunload can remove the listeners.
state._ipcCleanups = state._ipcCleanups || [];

/** base64 → ArrayBuffer (handoff payloads carry the wav buffer as base64). */
function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** Accept either the flat SPA shape or the legacy { wavBuffer, data: {...} } shape. */
function normalizeHandoff(data) {
  if (!data) return null;
  const inner = data.data && typeof data.data === 'object' ? data.data : data;
  let wavBuffer = data.wavBuffer != null ? data.wavBuffer : inner.wavBuffer;
  if (!wavBuffer && data.wavBufferB64) {
    wavBuffer = base64ToArrayBuffer(data.wavBufferB64);
  } else if (!wavBuffer && inner.wavBufferB64) {
    wavBuffer = base64ToArrayBuffer(inner.wavBufferB64);
  }
  if (!wavBuffer) return null;
  return {
    wavBuffer,
    wavFileName: inner.wavFileName || 'audio.wav',
    singerName: inner.singerName || '未命名歌手',
    singerColor: inner.singerColor || '#3498db',
    avatarImageData: inner.avatarImageData,
    avatarImageName: inner.avatarImageName,
  };
}

export function setupIpcHandlers() {
  window.addEventListener('DOMContentLoaded', async () => {
    try {
      const ipc = window.electronAPI;

      function initializeWithData(data) {
        const normalized = normalizeHandoff(data);
        if (!normalized) {
          showAlertDialog(t('preprocess.noAudioReceived'));
          return;
        }

        state.wavFileBuffer = normalized.wavBuffer;
        state.wavFileName = normalized.wavFileName;
        state.singerName = normalized.singerName;
        state.singerColor = normalized.singerColor;
        state.avatarImageData = normalized.avatarImageData;
        state.avatarImageName = normalized.avatarImageName;

        dom.wavFileNameEl.textContent = state.wavFileName;
        dom.midiInfoEl.textContent = t('preprocess.waitingForExtraction');

        processWavBuffer(state.wavFileBuffer).then((buffer) => {
          state.wavAudioBuffer = buffer;
          state.wavDuration = state.wavAudioBuffer.duration;

          drawWaveformWithPlayhead(0);

          initPianoRoll().then(() => {
            console.log(t('preprocess.consoleStarted'));
          });
        }).catch((err) => {
          console.error(t('preprocess.initFailed'), err);
          showAlertDialog(t('preprocess.initFailed') + ': ' + err.message);
        });
      }

      // Primary path: the Rust handoff file written by openAudioPreprocess
      // (singer-creator → here). Survives the multi-page SPA navigation and
      // carries song-sized buffers the SPA mailbox cannot mirror.
      let initialData = null;
      try {
        if (ipc && ipc.loadPreprocessHandoff) {
          const handoff = await ipc.loadPreprocessHandoff();
          if (handoff && handoff.kind === 'preprocess-input') {
            initialData = handoff.data;
          }
        }
      } catch (handoffErr) {
        console.warn('[preprocess] load_preprocess_handoff unavailable:', handoffErr);
      }

      // Fallbacks: SPA mailbox (same-page / dev), legacy injected global, then
      // the legacy IPC event (kept for compatibility with older callers).
      if (!initialData) {
        initialData = consumeMail('audio-preprocess');
      }
      if (!initialData) {
        initialData = window._pendingPreprocessData;
      }
      if (initialData) {
        initializeWithData(initialData);
      } else if (ipc && ipc.onLoadPreprocessData) {
        // W21: capture the unsubscribe function returned by onLoadPreprocessData
        // and track it so beforeunload can remove the IPC listener.
        const cleanupLoad = ipc.onLoadPreprocessData((data) => {
          initializeWithData(data);
        });
        if (cleanupLoad) state._ipcCleanups.push(cleanupLoad);
      } else {
        showAlertDialog(t('preprocess.noAudioReceived'));
      }
    } catch (err) {
      console.error(t('preprocess.initFailed'), err);
      showAlertDialog(t('preprocess.initFailed') + ': ' + err.message);
    }
  });
}
