<!--
  ThemeSaveAsModal.vue — "save current theme as new theme" dialog. Mirrors
  #themeSaveAsModal markup: theme ID (kebab-case) + display name inputs,
  per-field validation error, and cancel/confirm actions.
-->
<template>
  <div v-if="store.theme.saveAsVisible" class="theme-saveas-modal">
    <div class="theme-saveas-overlay" @click="store.closeSaveAsModal"></div>
    <div class="theme-saveas-panel" role="dialog" aria-modal="true" aria-labelledby="themeSaveAsTitle">
      <h3 id="themeSaveAsTitle">{{ $t('settings.theme.saveAsTitle') }}</h3>
      <div class="setting-group">
        <label for="themeSaveAsId">{{ $t('settings.theme.saveAsIdLabel') }}</label>
        <input type="text" id="themeSaveAsId"
          :value="store.theme.saveAsId"
          :placeholder="$tOr('settings.theme.saveAsIdPlaceholder', 'my-custom-theme')"
          @input="onIdInput">
        <p v-if="store.theme.saveAsIdErrorVisible" class="hint theme-saveas-error">{{ store.theme.saveAsIdError }}</p>
      </div>
      <div class="setting-group">
        <label for="themeSaveAsName">{{ $t('settings.theme.saveAsNameLabel') }}</label>
        <input type="text" id="themeSaveAsName"
          :value="store.theme.saveAsName"
          :placeholder="$tOr('settings.theme.saveAsNamePlaceholder', '我的自定义主题')"
          @input="onNameInput">
      </div>
      <div class="theme-saveas-actions">
        <button class="btn-theme-editor" @click="store.closeSaveAsModal">{{ $t('settings.theme.saveAsCancel') }}</button>
        <button class="btn-theme-editor btn-theme-editor-primary" @click="store.confirmSaveAs">{{ $t('settings.theme.saveAsConfirm') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useSettingsStore } from './store.js';

const store = useSettingsStore();

function onIdInput(e) {
  store.theme.saveAsId = e.target.value;
  if (store.theme.saveAsIdErrorVisible) store.clearSaveAsIdError();
}

function onNameInput(e) {
  store.theme.saveAsName = e.target.value;
}
</script>
