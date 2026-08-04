/**
 * singerCreator Pinia store — reactive state for the Singer Creator window.
 *
 * Holds singer basic info (name, color, avatar), WAV file info + decoded
 * AudioBuffer, preprocess state, the WAV trim dialog state, and save state.
 * IPC actions (saveSingerFile, openAudioPreprocess) live here; the
 * onPreprocessDataSaved / onSingerCreatorSaveRequest listeners are wired by
 * the component (they need component lifecycle cleanup).
 *
 * Canvas drawing and audio playback stay component-local because they need
 * DOM/canvas refs and AudioContext nodes tied to the component lifecycle.
 *
 * AudioBuffer / ArrayBuffer values are wrapped with markRaw so Vue's
 * reactivity does not proxy non-plain Web Audio objects (which would break
 * getChannelData / createBufferSource).
 */
import { defineStore } from 'pinia';
import { ref, computed, markRaw } from 'vue';
import { t } from '../../../i18n/index.js';

export const MAX_TRIM_DURATION = 30;

export const useSingerCreatorStore = defineStore('singerCreator', () => {
  // ----- Singer basic info -----
  const singerName = ref('');
  const singerColor = ref('#3498db');
  const avatarMode = ref('color');     // 'color' | 'image'
  const avatarImageData = ref(null);   // data URL string
  const avatarImageName = ref('');

  // ----- WAV file -----
  // Non-serializable values; only reference reactivity is needed so template
  // bindings (hasWav, wavInfoVisible) update on assignment.
  const wavFileBuffer = ref(null);     // raw WAV ArrayBuffer (saved + preprocessed)
  const wavAudioBuffer = ref(null);    // decoded AudioBuffer (preview playback)
  const wavFileName = ref('');
  const wavDuration = ref(0);
  // Drives upload-area / wav-info / preprocess-actions visibility. Decoupled
  // from hasWav because a >30s wav is loaded into the trim dialog before being
  // committed to the main display.
  const wavInfoVisible = ref(false);

  // ----- Preprocess -----
  const isPreprocessed = ref(false);
  const preprocessResult = ref(null);

  // ----- Trim dialog -----
  const trimVisible = ref(false);
  const trimAudioBuffer = ref(null);   // full AudioBuffer being trimmed
  const trimFileName = ref('');        // pending filename (committed on confirm)
  const trimStart = ref(0);
  const trimLength = ref(MAX_TRIM_DURATION);
  const trimTotalDuration = ref(0);

  // ----- Save state -----
  // Tracks the file path so subsequent saves (Ctrl+S) write to the original
  // file silently instead of prompting with a Save As dialog.
  const currentSingerFilePath = ref(null);
  // Whether the main window has already been notified about this singer so
  // repeated saves don't add duplicate singer entries.
  const singerCreatedNotified = ref(false);
  const isSaving = ref(false);

  // ----- Computed -----
  const hasWav = computed(() => !!wavFileBuffer.value);
  const useAvatarImage = computed(
    () => avatarMode.value === 'image' && !!avatarImageData.value
  );

  function getEffectiveSingerName() {
    return singerName.value.trim() || t('singerCreator.unnamedSinger');
  }

  // ----- Avatar actions -----
  function setSingerName(v) { singerName.value = v; }
  function setSingerColor(v) { singerColor.value = v; }
  function setAvatarMode(mode) { avatarMode.value = mode; }
  function setAvatarImage(data, name) {
    avatarImageData.value = data;
    avatarImageName.value = name;
  }
  function clearAvatar() {
    avatarImageData.value = null;
    avatarImageName.value = '';
  }

  // ----- WAV actions -----
  function setWavData({ arrayBuffer, audioBuffer, duration, fileName }) {
    wavFileBuffer.value = markRaw(arrayBuffer);
    wavAudioBuffer.value = markRaw(audioBuffer);
    wavDuration.value = duration;
    wavFileName.value = fileName;
    wavInfoVisible.value = true;
    isPreprocessed.value = false;
    preprocessResult.value = null;
  }

  function clearWav() {
    wavFileBuffer.value = null;
    wavAudioBuffer.value = null;
    wavFileName.value = '';
    wavDuration.value = 0;
    wavInfoVisible.value = false;
    isPreprocessed.value = false;
    preprocessResult.value = null;
  }

  function setPreprocessResult(result) {
    preprocessResult.value = result;
    isPreprocessed.value = true;
  }

  // ----- Trim actions -----
  // prepareTrim does NOT touch the main wav state — the trimmed clip is only
  // committed to the main display on confirm. On cancel the main wav state is
  // cleared separately by the component (matching the original behavior).
  function prepareTrim(audioBuffer, fileName, duration) {
    trimAudioBuffer.value = markRaw(audioBuffer);
    trimFileName.value = fileName;
    trimTotalDuration.value = duration;
    trimStart.value = 0;
    trimLength.value = Math.min(MAX_TRIM_DURATION, duration);
    trimVisible.value = true;
  }

  function closeTrim() {
    trimVisible.value = false;
    trimAudioBuffer.value = null;
    trimFileName.value = '';
    trimTotalDuration.value = 0;
  }

  function clampTrimValues() {
    trimStart.value = Math.max(0, trimStart.value);
    trimLength.value = Math.max(0.1, trimLength.value);
    trimLength.value = Math.min(MAX_TRIM_DURATION, trimLength.value);
    trimLength.value = Math.min(trimLength.value, trimTotalDuration.value - trimStart.value);
    if (trimStart.value + trimLength.value > trimTotalDuration.value) {
      trimStart.value = trimTotalDuration.value - trimLength.value;
    }
    trimStart.value = Math.max(0, trimStart.value);
  }

  function commitTrim(trimmedBuffer, wavArrayBuffer) {
    wavFileBuffer.value = markRaw(wavArrayBuffer);
    wavAudioBuffer.value = markRaw(trimmedBuffer);
    wavDuration.value = trimLength.value;
    wavFileName.value = trimFileName.value;
    wavInfoVisible.value = true;
    isPreprocessed.value = false;
    preprocessResult.value = null;
    closeTrim();
  }

  // ----- Save action -----
  async function performSave(isSaveAs = false) {
    if (isSaving.value) return { busy: true };
    if (!wavFileBuffer.value) {
      return { error: t('singerCreator.pleaseSelectWav') };
    }
    if (!window.electronAPI || !window.electronAPI.saveSingerFile) {
      return { error: t('singerCreator.saveUnavailable') };
    }

    const hasFilePath = !!currentSingerFilePath.value && !isSaveAs;
    const notifyMainWindow = !singerCreatedNotified.value;

    isSaving.value = true;
    try {
      const result = await window.electronAPI.saveSingerFile({
        singerName: getEffectiveSingerName(),
        color: singerColor.value,
        avatarImageData: useAvatarImage.value ? avatarImageData.value : null,
        avatarImageName: useAvatarImage.value ? avatarImageName.value : null,
        wavBuffer: wavFileBuffer.value,
        wavFileName: wavFileName.value,
        duration: wavDuration.value,
        isPreprocessed: isPreprocessed.value,
        preprocessResult: preprocessResult.value,
        filePath: hasFilePath ? currentSingerFilePath.value : null,
        notifyMainWindow,
      });

      if (result && result.success) {
        if (result.filePath) currentSingerFilePath.value = result.filePath;
        if (notifyMainWindow) singerCreatedNotified.value = true;
        return { success: true };
      } else if (result && result.canceled) {
        return { canceled: true };
      }
      // W24: use t(key, params) instead of t(key) + ': ' + value concatenation.
      return {
        error: t('singerCreator.createFailedDetail', {
          detail: result && result.error ? result.error : '',
        }),
      };
    } catch (err) {
      console.error(t('singerCreator.saveFailed'), err);
      // W24: use t(key, params) instead of t(key) + ': ' + value concatenation.
      return {
        error: t('singerCreator.createFailedDetail', {
          detail: err && err.message ? err.message : '',
        }),
      };
    } finally {
      isSaving.value = false;
    }
  }

  function openAudioPreprocess() {
    if (!wavFileBuffer.value) return false;
    if (!window.electronAPI || !window.electronAPI.openAudioPreprocess) return false;
    // openAudioPreprocess stashes the payload in the SPA mailbox and navigates
    // to the audio-preprocess view; the result comes back via the
    // onPreprocessDataSaved IPC event (wired by the component).
    window.electronAPI.openAudioPreprocess({
      wavBuffer: wavFileBuffer.value,
      wavFileName: wavFileName.value,
      duration: wavDuration.value,
      singerName: getEffectiveSingerName(),
      singerColor: singerColor.value,
      avatarImageData: avatarImageData.value,
      avatarImageName: avatarImageName.value,
    });
    return true;
  }

  return {
    MAX_TRIM_DURATION,
    // state
    singerName, singerColor, avatarMode, avatarImageData, avatarImageName,
    wavFileBuffer, wavAudioBuffer, wavFileName, wavDuration, wavInfoVisible,
    isPreprocessed, preprocessResult,
    trimVisible, trimAudioBuffer, trimFileName, trimStart, trimLength, trimTotalDuration,
    currentSingerFilePath, singerCreatedNotified, isSaving,
    // computed
    hasWav, useAvatarImage,
    // helpers
    getEffectiveSingerName,
    // avatar
    setSingerName, setSingerColor, setAvatarMode, setAvatarImage, clearAvatar,
    // wav
    setWavData, clearWav, setPreprocessResult,
    // trim
    prepareTrim, closeTrim, clampTrimValues, commitTrim,
    // ipc
    performSave, openAudioPreprocess,
  };
});
