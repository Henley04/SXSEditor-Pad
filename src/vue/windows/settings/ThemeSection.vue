<!--
  ThemeSection.vue — theme picker + actions. Mirrors #section-theme markup:
  the theme <select> (grouped: built-in vs user themes), and the
  edit / import / export / delete / reset action buttons.
-->
<template>
  <div class="settings-section">
    <div class="setting-group">
      <label for="themeSelect">{{ $t('settings.theme.selectLabel') }}</label>
      <select id="themeSelect" :value="store.theme.selectedId" @change="store.selectTheme($event.target.value)">
        <optgroup v-if="store.builtinThemes.length" :label="$tOr('settings.theme.builtinGroup', 'Built-in')">
          <option v-for="meta in store.builtinThemes" :key="meta.id" :value="meta.id">{{ themeName(meta) }}</option>
        </optgroup>
        <optgroup v-if="store.userThemes.length" :label="$tOr('settings.theme.userGroup', 'User')">
          <option v-for="meta in store.userThemes" :key="meta.id" :value="meta.id">{{ themeName(meta) }}</option>
        </optgroup>
      </select>
      <p class="hint">{{ $t('settings.theme.selectLabel') }}</p>
    </div>
    <div class="theme-actions">
      <button class="btn-theme-action" @click="store.openThemeEditor">
        <Icon name="pencil" :size="14" />
        {{ $t('settings.theme.edit') }}
      </button>
      <button class="btn-theme-action" @click="store.importTheme">
        <Icon name="download-tray" :size="14" />
        {{ $t('settings.theme.import') }}
      </button>
      <button class="btn-theme-action" @click="store.exportTheme">
        <Icon name="upload" :size="14" />
        {{ $t('settings.theme.export') }}
      </button>
      <button class="btn-theme-action btn-theme-danger" @click="store.deleteTheme">
        <Icon name="trash" :size="14" />
        {{ $t('settings.theme.delete') }}
      </button>
      <button class="btn-theme-action btn-theme-secondary" @click="store.resetTheme">
        <Icon name="refresh" :size="14" />
        {{ $t('settings.theme.reset') }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { useSettingsStore } from './store.js';
import { t } from '../../../i18n/index.js';

const store = useSettingsStore();

function themeName(meta) {
  if (!meta) return '';
  const key = `settings.theme.names.${meta.id}`;
  const localized = t(key);
  return localized !== key ? localized : (meta.name || meta.id);
}
</script>
