<!--
  SettingsApp.vue — full Vue 3 migration of the settings window.

  Replaces the entire static body of src/settings.html. Owns the sidebar
  navigation + section switching, and mounts the theme editor / save-as
  modals + toast. All 11 settings sections are sub-components; all reactive
  state + IPC actions live in the Pinia store at ./store.js.

  Sections stay mounted via v-show (mirrors the original vanilla-JS pattern
  of toggling a `hidden` class), so internal focus / scroll state survives
  tab switches and the store-driven IPC bootstrap runs once.
-->
<template>
  <div class="settings-layout">
    <!-- ==================== Sidebar ==================== -->
    <nav class="settings-sidebar">
      <div class="sidebar-nav">
        <div class="sidebar-category">{{ $t('settings.catGeneral') }}</div>
        <div class="sidebar-item"
          :class="{ active: store.activeSection === 'section-language' }"
          @click="store.setSection('section-language')">
          <span>{{ $t('settings.language') }}</span>
        </div>
        <div class="sidebar-item"
          :class="{ active: store.activeSection === 'section-theme' }"
          @click="store.setSection('section-theme')">
          <span>{{ $t('settings.theme.title') }}</span>
        </div>

        <div class="sidebar-category">{{ $t('settings.catInference') }}</div>
        <div class="sidebar-item"
          :class="{ active: store.activeSection === 'section-inference' }"
          @click="store.setSection('section-inference')">
          <span>{{ $t('settings.inferenceHardware') }}</span>
        </div>
        <div class="sidebar-item"
          :class="{ active: store.activeSection === 'section-preview-params' }"
          @click="store.setSection('section-preview-params')">
          <span>{{ $t('settings.previewInferenceParams') }}</span>
        </div>
        <div class="sidebar-item"
          :class="{ active: store.activeSection === 'section-export-params' }"
          @click="store.setSection('section-export-params')">
          <span>{{ $t('settings.exportInferenceParams') }}</span>
        </div>
        <div class="sidebar-item"
          :class="{ active: store.activeSection === 'section-vocoder-chunk' }"
          @click="store.setSection('section-vocoder-chunk')">
          <span>{{ $t('settings.vocoderChunkTitle') }}</span>
        </div>
        <div class="sidebar-item"
          :class="{ active: store.activeSection === 'section-ort' }"
          @click="store.setSection('section-ort')">
          <span>{{ $t('settings.ortSectionTitle') }}</span>
        </div>

        <div class="sidebar-category">{{ $t('settings.catAudio') }}</div>
        <div class="sidebar-item"
          :class="{ active: store.activeSection === 'section-audio' }"
          @click="store.setSection('section-audio')">
          <span>{{ $t('settings.audioOutput') }}</span>
        </div>
        <div class="sidebar-item"
          :class="{ active: store.activeSection === 'section-midi' }"
          @click="store.setSection('section-midi')">
          <span>{{ $t('settings.midiExtractTool') }}</span>
        </div>

        <div class="sidebar-category">{{ $t('settings.catModel') }}</div>
        <div class="sidebar-item"
          :class="{ active: store.activeSection === 'section-model' }"
          @click="store.setSection('section-model')">
          <span>{{ $t('settings.modelManagement') }}</span>
        </div>

        <div class="sidebar-category">{{ $t('update.section') }}</div>
        <div class="sidebar-item"
          :class="{ active: store.activeSection === 'section-update' }"
          @click="store.setSection('section-update')">
          <span>{{ $t('update.section') }}</span>
        </div>
      </div>
      <div class="sidebar-footer">
        <span class="sidebar-version">{{ store.appVersion }}</span>
      </div>
    </nav>

    <!-- ==================== Content ==================== -->
    <main class="settings-content">
      <LanguageSection v-show="store.activeSection === 'section-language'" />
      <ThemeSection v-show="store.activeSection === 'section-theme'" />
      <InferenceSection v-show="store.activeSection === 'section-inference'" />
      <PreviewParamsSection v-show="store.activeSection === 'section-preview-params'" />
      <ExportParamsSection v-show="store.activeSection === 'section-export-params'" />
      <VocoderChunkSection v-show="store.activeSection === 'section-vocoder-chunk'" />
      <OrtSection v-show="store.activeSection === 'section-ort'" />
      <AudioSection v-show="store.activeSection === 'section-audio'" />
      <MidiSection v-show="store.activeSection === 'section-midi'" />
      <ModelSection v-show="store.activeSection === 'section-model'" />
      <UpdateSection v-show="store.activeSection === 'section-update'" />
    </main>
  </div>

  <!-- ==================== Theme Editor Modal ==================== -->
  <ThemeEditorModal />

  <!-- ==================== Save As Theme Modal ==================== -->
  <ThemeSaveAsModal />

  <!-- ==================== Toast ==================== -->
  <div v-if="store.theme.toastVisible"
    class="theme-toast"
    :class="`theme-toast-${store.theme.toastKind}`">{{ store.theme.toastMessage }}</div>
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue';
import { useSettingsStore } from './store.js';
import { initWindowTheme } from '../../../themes/themeInit.js';

// Pull in the CSS the vanilla-JS bootstrap imported so the existing
// .settings-layout / .settings-sidebar / .settings-section / .theme-editor-modal
// / .theme-toast styles still apply.
import '../../../common.css';
import '../../../settings.css';

import LanguageSection from './LanguageSection.vue';
import ThemeSection from './ThemeSection.vue';
import InferenceSection from './InferenceSection.vue';
import PreviewParamsSection from './PreviewParamsSection.vue';
import ExportParamsSection from './ExportParamsSection.vue';
import VocoderChunkSection from './VocoderChunkSection.vue';
import OrtSection from './OrtSection.vue';
import AudioSection from './AudioSection.vue';
import MidiSection from './MidiSection.vue';
import ModelSection from './ModelSection.vue';
import UpdateSection from './UpdateSection.vue';
import ThemeEditorModal from './ThemeEditorModal.vue';
import ThemeSaveAsModal from './ThemeSaveAsModal.vue';

const store = useSettingsStore();

const _cleanups = [];

onMounted(() => {
  // Apply theme tokens + listen for theme changes (cleanup pushed to array).
  initWindowTheme(_cleanups);
  // Kick off all the async IPC bootstrap (devices, settings, models, theme
  // list, update section, vocoder chunk info, IPC listeners).
  store.init().catch((err) => {
    console.error('[SettingsApp] store.init() failed:', err);
  });
});

onUnmounted(() => {
  // Flush IPC listener cleanups collected by initWindowTheme + store.init().
  _cleanups.forEach((fn) => {
    try { fn && fn(); } catch (_) {}
  });
  store.destroy();
});
</script>
