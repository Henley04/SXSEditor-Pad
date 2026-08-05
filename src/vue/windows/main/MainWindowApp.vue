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

  The ONLY Vue-managed additions are:
    1. `#btn-toolbar-overflow` — the mobile overflow menu button (a "more"
       icon visible only on small screens via pad.css media queries) that
       opens a dropdown containing the items normally found in the desktop
       OS menu bar (Settings, Resource Manager, About). This is required
       because mobile platforms have no menu bar, so without an in-app
       affordance those entries would be unreachable.
    2. `#toolbar-overflow-menu` — the dropdown panel itself.
    3. `#about-dialog` — a lightweight about modal (the desktop "About…"
       menu item is implemented natively; mobile has no native equivalent).

  Lifecycle:
    onMounted  → initWindowTheme(cleanups), then `await import('../../../renderer/index.js')`.
                 By the time the dynamic import runs, Vue has already rendered
                 the full DOM, so the bootstrap's getElementById calls find the
                 Vue-rendered elements and wires up canvas drawing, audio
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
    <div class="toolbar-group toolbar-group--overflow-candidate">
      <button id="btn-load" data-i18n="main.load" data-icon="folder-open">加载</button>
      <button id="btn-export" data-i18n="main.export" data-icon="upload">导出</button>
    </div>
    <div class="toolbar-divider"></div>
    <div class="toolbar-group toolbar-group--overflow-candidate">
      <button id="btn-audio-to-midi" data-i18n="main.audioToMidi" data-icon="music">音频转MIDI</button>
      <button id="btn-import-midi" data-i18n="main.importMidi" data-icon="file-music">导入MIDI</button>
    </div>
    <div class="toolbar-divider"></div>
    <div class="toolbar-group toolbar-group--overflow-candidate">
      <button id="btn-open-singer-market" data-i18n="main.openSingerMarket" data-icon="market">歌手市场</button>
    </div>
    <div class="toolbar-divider"></div>
    <div class="toolbar-group toolbar-group--overflow-candidate">
      <span id="version-display" class="version-badge">v-</span>
    </div>

    <!-- Mobile / narrow-viewport overflow menu.
         Hidden on desktop by `#btn-toolbar-overflow { display: none }` in
         index.css; revealed by pad.css media queries (≤900px). The dropdown
         surfaces Settings / Resource Manager / About — the entries that
         normally live in the desktop OS menu bar (File → Settings, etc.) and
         would otherwise be unreachable on touch-only platforms. -->
    <div class="toolbar-group toolbar-overflow-wrap">
      <button
        id="btn-toolbar-overflow"
        type="button"
        :aria-expanded="overflowOpen ? 'true' : 'false'"
        aria-haspopup="menu"
        data-i18n-aria-label="main.more"
        :aria-label="$t('main.more')"
        @click="toggleOverflow"
      >
        <Icon name="more-vertical" :size="18" />
      </button>
      <div
        v-if="overflowOpen"
        id="toolbar-overflow-menu"
        role="menu"
        @click.stop
      >
        <button type="button" class="overflow-item" role="menuitem" @click="onOpenSettings">
          <Icon name="settings" :size="16" />
          <span>{{ $t('main.settings') }}</span>
        </button>
        <button type="button" class="overflow-item" role="menuitem" @click="onOpenResourceManager">
          <Icon name="grid" :size="16" />
          <span>{{ $t('main.resourceManager') }}</span>
        </button>
        <button type="button" class="overflow-item" role="menuitem" @click="onOpenAbout">
          <Icon name="info" :size="16" />
          <span>{{ $t('main.about') }}</span>
        </button>
      </div>
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

  <!-- About dialog (mobile-friendly replacement for the native About…
       OS menu entry, which is unavailable on touch platforms). -->
  <div v-if="aboutOpen" id="about-dialog-overlay" class="dialog-overlay" @click.self="closeAbout">
    <div id="about-dialog" class="dialog-box" role="dialog" aria-modal="true">
      <div class="about-dialog-icon"><Icon name="music" :size="36" /></div>
      <h2 class="about-dialog-title">{{ $t('main.aboutTitle') }}</h2>
      <p class="about-dialog-desc">{{ $t('main.aboutDescription') }}</p>
      <div class="about-dialog-version">
        <span>{{ $t('main.aboutVersion') }}:</span>
        <span id="about-version-value">{{ aboutVersion }}</span>
      </div>
      <div class="about-dialog-actions">
        <button type="button" class="about-dialog-close-btn" @click="closeAbout">
          {{ $t('main.closeAbout') }}
        </button>
      </div>
    </div>
  </div>

  <!-- First-launch onboarding overlay (intro + hardware check + model download) -->
  <OnboardingOverlay />
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { initWindowTheme } from '../../../themes/themeInit.js';
import * as spa from '../../../spa/router.js';
import OnboardingOverlay from './OnboardingOverlay.vue';

// Cleanup functions collected during the component's life (theme:changed
// listener registered by initWindowTheme, etc.). The renderer's own IPC
// cleanups live in state._ipcCleanups and are torn down via beforeunload.
const cleanups = [];

// ==================== Mobile overflow menu state ====================
// The overflow button + dropdown is purely client-side: it lives in the
// toolbar, opens on click, and routes to the Settings / Resource Manager
// SPA views (which already exist as separate HTML entries) via the SPA
// router. About is shown as an in-app modal so it works on platforms with
// no native About dialog (mobile, web).
const overflowOpen = ref(false);
const aboutOpen = ref(false);
const aboutVersion = ref('');

function toggleOverflow() {
  overflowOpen.value = !overflowOpen.value;
}

function closeOverflow() {
  overflowOpen.value = false;
}

function onOpenSettings() {
  closeOverflow();
  // Route to the existing settings SPA view. The desktop OS menu bar
  // already wires `Settings` to this same route via Rust; on mobile we
  // trigger it directly from the in-app overflow menu.
  spa.navigate('settings');
}

function onOpenResourceManager() {
  closeOverflow();
  // `electronAPI.resmgrOpen()` is the canonical entry — it routes to the
  // resource-manager SPA view. Call it directly so we don't duplicate the
  // navigation logic.
  if (window.electronAPI && typeof window.electronAPI.resmgrOpen === 'function') {
    window.electronAPI.resmgrOpen();
  } else {
    spa.navigate('resource-manager');
  }
}

async function onOpenAbout() {
  closeOverflow();
  // Resolve the app version via the existing bridge method (the renderer
  // already uses this to populate the #version-display badge). Fall back
  // to a hard-coded value if the bridge is unavailable (e.g. in tests).
  try {
    const v = window.electronAPI && typeof window.electronAPI.getAppVersion === 'function'
      ? await window.electronAPI.getAppVersion()
      : null;
    aboutVersion.value = v ? `v${v}` : 'v1.0.0';
  } catch (_) {
    aboutVersion.value = 'v1.0.0';
  }
  aboutOpen.value = true;
}

function closeAbout() {
  aboutOpen.value = false;
}

// Close the overflow dropdown when the user clicks outside it or presses
// Escape — standard dropdown semantics. The document listener is attached
// only while the component is mounted.
function onDocClick(e) {
  if (!overflowOpen.value) return;
  const wrap = document.querySelector('.toolbar-overflow-wrap');
  if (wrap && !wrap.contains(e.target)) {
    closeOverflow();
  }
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    if (overflowOpen.value) closeOverflow();
    if (aboutOpen.value) closeAbout();
  }
}

onMounted(async () => {
  // Apply theme tokens before the first canvas render so timelineRenderer
  // reads the correct CSS variables.
  initWindowTheme(cleanups);

  // Attempt to set the window to fullscreen on mobile to hide the Android
  // status bar. Tauri 2's `setFullscreen` may not be implemented for Android
  // (the Android window plugin is incomplete). Try it anyway as a no-op on
  // platforms that don't support it — the CSS safe-area fallback below
  // handles the status bar area if fullscreen isn't available.
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    await win.setFullscreen(true);
  } catch (_) {
    // Tauri API might not be available in dev/web mode or not implemented
    // for Android. Fall through to CSS/JS safe-area handling.
  }

  // Attempt to lock orientation to landscape on mobile (best-effort —
  // the Screen Orientation API may not be available on all devices).
  // Portrait is still accepted if the user rotates manually.
  try {
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('landscape').catch(() => {
        // Orientation lock may fail if the document isn't fullscreen
        // or the API requires user gesture. Non-fatal — portrait still works.
      });
    }
  } catch (_) { /* no-op */ }

  // CSS fallback: if env(safe-area-inset-top) returns 0 (common on Android
  // where Tauri doesn't set the status bar insets), detect the status bar
  // height and inject it as a CSS custom property on :root.
  // Uses the shared utility so all windows (main, settings, model download)
  // get the same safe-area detection logic.
  const { applySafeAreaInsets } = await import('../../../utils/safeArea.js');
  const safeAreaCleanup = applySafeAreaInsets();
  cleanups.push(safeAreaCleanup);

  // Overflow menu / about dialog listeners.
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKeydown);

  // Vue has already rendered the full DOM by now. Dynamically importing the
  // existing renderer bootstrap lets its getElementById calls find the
  // Vue-rendered elements and sets up canvas drawing, event handlers, IPC
  // handlers and audio playback on them.
  await import('../../../renderer/index.js');
});

onUnmounted(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onKeydown);
  for (const cleanup of cleanups) {
    try { cleanup(); } catch (_) { /* noop */ }
  }
  cleanups.length = 0;
});
</script>
