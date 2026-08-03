<!--
  LanguageSection.vue — language picker. Mirrors #section-language markup.
-->
<template>
  <div class="settings-section">
    <div class="setting-group">
      <label for="languageSelect">{{ $t('settings.language') }}</label>
      <select id="languageSelect" :value="store.language.locale" @change="onChange">
        <option value="zh-CN">中文 (简体)</option>
        <option value="en">English</option>
      </select>
      <p class="hint">{{ $t('settings.languageHint') }}</p>
    </div>
  </div>
</template>

<script setup>
import { useSettingsStore } from './store.js';
const store = useSettingsStore();

function onChange(e) {
  store.setLanguage(e.target.value);
}
</script>
