<!--
  AudioPreprocessApp.vue — Vue 3 migration of the audioPreprocess window.

  The full UI markup (toolbar + waveform section + resize handle + midi
  section with canvas + scrollbars) lives in this template. The bootstrap
  at src/audioPreprocess/index.js (initDomRefs / setupEventHandlers /
  setupIpcHandlers / pianoRoll + waveform + midi canvas setup) is loaded
  via dynamic import() in onMounted — by then Vue has rendered the DOM, so
  the bootstrap's getElementById calls succeed. No Pinia store is used;
  state.js continues to own state via the dynamically imported modules.
-->
<template>
  <div id="toolbar">
    <div class="toolbar-group">
      <button id="btn-play-pause" class="btn-toolbar" data-i18n="preprocess.play" data-icon="play">播放</button>
    </div>
    <div class="toolbar-divider"></div>
    <div class="toolbar-group">
      <button id="btn-extract-f0" class="btn-toolbar btn-primary" data-i18n="preprocess.rmvpeExtractF0" data-icon="sliders">RMVPE提取F0</button>
      <button id="btn-extract-f0-basic-pitch" class="btn-toolbar btn-success" data-i18n="preprocess.basicPitchExtractMidi" data-icon="music">提取MIDI</button>
      <button id="btn-import-midi" class="btn-toolbar" data-i18n="preprocess.importMidi" data-icon="file-music">导入MIDI</button>
    </div>
    <div class="toolbar-divider"></div>
    <div class="toolbar-group">
      <span id="page-title" data-i18n="preprocess.audioPreprocess">音频预处理</span>
    </div>
    <div style="flex:1"></div>
    <div class="toolbar-group">
      <button id="btn-save" class="btn-toolbar btn-success" data-i18n="preprocess.save" data-icon="save">保存</button>
      <button id="btn-back" class="btn-toolbar" data-i18n="preprocess.back" data-icon="close">返回</button>
    </div>
  </div>
  <div id="main-content">
    <div id="waveform-section">
      <div id="waveform-header">
        <span class="section-title" data-i18n="preprocess.wavWaveform">WAV 波形</span>
        <span id="wav-file-name" class="file-info">-</span>
      </div>
      <div id="waveform-container">
        <canvas id="waveform-canvas" role="img" aria-label="WAV波形"></canvas>
      </div>
    </div>
    <div id="resize-handle"></div>
    <div id="midi-section">
      <div id="midi-header">
        <span class="section-title" data-i18n="preprocess.midiEditor">MIDI 编辑器</span>
        <span id="midi-info" class="file-info" data-i18n="preprocess.waitingForExtraction">-</span>
      </div>
      <div id="midi-body">
        <div id="midi-container">
          <canvas id="midi-canvas" role="img" aria-label="MIDI编辑器"></canvas>
        </div>
        <div id="midi-vscroll" class="scrollbar scrollbar-vertical" role="scrollbar" aria-orientation="vertical" tabindex="-1">
          <div id="midi-vscroll-thumb" class="scrollbar-thumb"></div>
        </div>
      </div>
      <div id="midi-hscroll" class="scrollbar scrollbar-horizontal" role="scrollbar" aria-orientation="horizontal" tabindex="-1">
        <div id="midi-hscroll-thumb" class="scrollbar-thumb"></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue';
import { initWindowTheme } from '../../../themes/themeInit.js';

const cleanups = [];

onMounted(async () => {
  initWindowTheme(cleanups);
  await import('../../../audioPreprocess/index.js');
});

onUnmounted(() => {
  for (const cleanup of cleanups) {
    try { cleanup && cleanup(); } catch (_) {}
  }
});
</script>
