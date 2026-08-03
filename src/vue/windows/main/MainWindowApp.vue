<!--
  MainWindowApp.vue — Vue 3 replacement for the vanilla-JS main window
  bootstrap (src/renderer/index.js).

  The template reproduces the ENTIRE body content that used to live in
  src/index.html statically: the #toolbar and #main-content trees. Element
  IDs, data-i18n and data-icon attributes are kept EXACTLY as they were —
  the dynamically imported renderer modules (state.js, eventHandlers.js,
  ipcHandlers.js, timelineRenderer.js, audioPlayback.js, …) look up elements
  via getElementById at module load and attach their own listeners, so this
  component intentionally does NOT bind v-model / @click on the toolbar
  controls.

  Lifecycle:
    onMounted  → initWindowTheme(cleanups), then `await import('../../../renderer/index.js')`.
                 By the time the dynamic import runs, Vue has already rendered
                 the full DOM, so the bootstrap's getElementById calls find the
                 Vue-rendered elements and wire up canvas drawing, audio
                 playback, event handlers and IPC handlers.
    onUnmounted → run the cleanup functions collected in `cleanups`.
-->
<template>
  <div id="toolbar">
    <div class="toolbar-group">
      <button id="btn-play" data-i18n="main.play" data-icon="play">播放</button>
      <button id="btn-pause" data-i18n="main.pause" data-icon="pause">暂停</button>
      <button id="btn-stop" data-i18n="main.stop" data-icon="stop">停止</button>
    </div>
    <div class="toolbar-divider"></div>
    <div class="toolbar-group">
      <span id="time-display">00:00:000</span>
    </div>
    <div class="toolbar-divider"></div>
    <div class="toolbar-group">
      <label>BPM <input id="bpm-input" type="number" value="120" min="1" max="999" /></label>
      <label data-i18n="main.timeSignature">拍号 <input id="time-sig-num" type="number" value="4" min="1" max="32" /> / <input id="time-sig-den" type="number" value="4" min="1" max="32" /></label>
      <label><input type="checkbox" id="auto-shift-check" checked />Auto Shift</label>
    </div>
    <div class="toolbar-divider"></div>
    <div class="toolbar-group">
      <button id="btn-load" data-i18n="main.load" data-icon="folder-open">加载</button>
      <button id="btn-export" data-i18n="main.export" data-icon="upload">导出</button>
    </div>
    <div class="toolbar-divider"></div>
    <div class="toolbar-group">
      <button id="btn-audio-to-midi" data-i18n="main.audioToMidi" data-icon="music">音频转MIDI</button>
      <button id="btn-import-midi" data-i18n="main.importMidi" data-icon="file-music">导入MIDI</button>
    </div>
    <div class="toolbar-divider"></div>
    <div class="toolbar-group">
      <button id="btn-open-singer-market" data-i18n="main.openSingerMarket" data-icon="market">歌手市场</button>
    </div>
    <div class="toolbar-divider"></div>
    <div class="toolbar-group">
      <span id="version-display" class="version-badge">v-</span>
    </div>
  </div>
  <div id="main-content">
    <div id="singer-panel">
      <div id="singer-panel-header">
        <span data-i18n="main.singer">歌手</span>
        <button id="btn-add-singer" aria-label="添加">+</button>
      </div>
      <div id="singer-list" role="list"></div>
    </div>
    <div id="fragment-timeline">
      <div id="fragment-header">
        <span data-i18n="main.fragmentTimeline">分片时间轴</span>
        <span id="bpm-display-badge"><span data-icon="music-note" data-icon-class="icon--md"></span><span id="bpm-display-text">120 BPM</span></span>
      </div>
      <div id="fragment-canvas-container">
        <canvas id="fragment-canvas" role="img" aria-label="分片时间轴"></canvas>
        <canvas id="fragment-playhead-canvas" role="img" aria-label="播放指针"></canvas>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue';
import { initWindowTheme } from '../../../themes/themeInit.js';

// Cleanup functions collected during the component's life (theme:changed
// listener registered by initWindowTheme, etc.). The renderer's own IPC
// cleanups live in state._ipcCleanups and are torn down via beforeunload.
const cleanups = [];

onMounted(async () => {
  // Apply theme tokens before the first canvas render so timelineRenderer
  // reads the correct CSS variables.
  initWindowTheme(cleanups);

  // Vue has already rendered the full DOM by now. Dynamically importing the
  // existing renderer bootstrap lets its getElementById calls find the
  // Vue-rendered elements and sets up canvas drawing, event handlers, IPC
  // handlers and audio playback on them.
  await import('../../../renderer/index.js');
});

onUnmounted(() => {
  for (const cleanup of cleanups) {
    try { cleanup(); } catch (_) { /* noop */ }
  }
  cleanups.length = 0;
});
</script>
