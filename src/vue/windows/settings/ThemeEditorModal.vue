<!--
  ThemeEditorModal.vue — theme token editor modal. Mirrors
  #themeEditorModal markup: header (title + undo/redo/reset-all/save-as/close
  toolbar) and body (token rows grouped by layer → sub-group).

  Each token row renders a color swatch + text input (for color tokens) or a
  wide text input (for other tokens) plus a per-token reset button. Local
  "pending" input values are tracked so typing/picking updates the field
  immediately even though themeManager.setOverrideValue is debounced (80ms).
  Undo / redo / reset-all / reset-token bump store.theme.editorVersion; a
  watcher clears the local pending map so the inputs re-sync to the
  themeManager's current values.
-->
<template>
  <div v-if="store.theme.editorVisible" class="theme-editor-modal">
    <div class="theme-editor-overlay" @click="store.closeThemeEditor(false)"></div>
    <div class="theme-editor-panel" role="dialog" aria-modal="true" aria-labelledby="themeEditorTitle">
      <div class="theme-editor-header">
        <h3 id="themeEditorTitle">{{ $t('settings.theme.editor.title') }}</h3>
        <div class="theme-editor-toolbar">
          <button class="btn-theme-editor" @click="store.editorUndo">
            <Icon name="undo" :size="14" />
            {{ $t('settings.theme.editor.undo') }}
          </button>
          <button class="btn-theme-editor" @click="store.editorRedo">
            <Icon name="redo" :size="14" />
            {{ $t('settings.theme.editor.redo') }}
          </button>
          <button class="btn-theme-editor" @click="store.editorResetAll">
            <Icon name="refresh" :size="14" />
            {{ $t('settings.theme.editor.resetAll') }}
          </button>
          <button class="btn-theme-editor btn-theme-editor-primary" @click="store.openSaveAsModal">
            <Icon name="save" :size="14" />
            {{ $t('settings.theme.saveAs') }}
          </button>
          <button class="btn-theme-editor btn-theme-editor-close" :aria-label="$t('settings.theme.editor.close')" @click="store.closeThemeEditor(false)">
            <Icon name="close" :size="14" />
          </button>
        </div>
      </div>
      <div class="theme-editor-body">
        <div v-for="layer in store.themeEditorGroups" :key="layer.layerKey" class="theme-editor-section">
          <h4 class="theme-editor-section-title">{{ layer.layerLabel }}</h4>
          <div v-for="group in layer.groups" :key="group.groupName" class="theme-editor-group">
            <h5 class="theme-editor-group-title">{{ group.groupName }}</h5>
            <div v-for="item in group.items" :key="item.name" class="theme-editor-row">
              <label class="theme-editor-label" :title="item.name">{{ item.meta.label || item.name }}</label>
              <div class="theme-token-field">
                <template v-if="item.meta.type === 'color'">
                  <input type="color" class="theme-token-color-swatch"
                    :value="swatchValue(item.name)"
                    :title="$t('settings.theme.editor.colorPicker')"
                    @input="onSwatchInput(item.name, $event.target.value)">
                  <input type="text" class="theme-token-text"
                    :value="textValue(item.name)"
                    spellcheck="false"
                    @input="onTextInput(item.name, $event.target.value)">
                </template>
                <template v-else>
                  <input type="text" class="theme-token-text theme-token-text-wide"
                    :value="textValue(item.name)"
                    spellcheck="false"
                    @input="onTextInput(item.name, $event.target.value)">
                </template>
                <button type="button" class="theme-token-reset"
                  :title="$t('settings.theme.editor.resetToken')"
                  :aria-label="$t('settings.theme.editor.resetToken')"
                  @click="store.editorResetToken(item.name)">
                  <Icon name="refresh" :size="14" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, watch, onMounted, onUnmounted } from 'vue';
import { useSettingsStore } from './store.js';

const store = useSettingsStore();

// Local "pending" values per token. The store's applyTokenChange() is
// debounced (80ms) and reads from themeManager, so without a local cache the
// text input would lag behind keystrokes. We mirror the original vanilla-JS
// behavior: text.value = swatch.value; applyTokenChange(...).
const pending = reactive({});

// When undo / redo / reset-all / reset-token bump editorVersion, drop the
// local pending map so inputs re-sync to themeManager's current values.
watch(
  () => store.theme.editorVersion,
  () => {
    for (const k of Object.keys(pending)) delete pending[k];
  }
);

function textValue(tokenName) {
  if (Object.prototype.hasOwnProperty.call(pending, tokenName)) {
    return pending[tokenName];
  }
  return store.resolveToken(tokenName);
}

function swatchValue(tokenName) {
  if (Object.prototype.hasOwnProperty.call(pending, tokenName)) {
    return toHex(pending[tokenName]);
  }
  return store.hexForToken(tokenName);
}

function onTextInput(tokenName, value) {
  pending[tokenName] = value;
  store.applyTokenChange(tokenName, value);
}

function onSwatchInput(tokenName, value) {
  pending[tokenName] = value;
  store.applyTokenChange(tokenName, value);
}

// hex parser mirroring store.toHexForColorInput (kept local to avoid extra
// store method surface for a display-only path).
function toHex(value) {
  if (typeof value !== 'string') return '#000000';
  const v = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    return '#' + v.slice(1).split('').map(c => c + c).join('');
  }
  if (/^#[0-9a-fA-F]{8}$/.test(v)) return v.slice(0, 7);
  const m = v.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map(s => parseFloat(s.trim()));
    if (parts.length >= 3) {
      const toHex2 = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
      return '#' + toHex2(parts[0]) + toHex2(parts[1]) + toHex2(parts[2]);
    }
  }
  return '#000000';
}

// Keyboard shortcuts: Esc closes, Ctrl/Cmd+Z undo, Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z redo.
// Matches handleEditorKey() in the original settings.js.
function onKeydown(e) {
  if (!store.theme.editorVisible) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    store.closeThemeEditor(false);
  } else if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    store.editorUndo();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
    e.preventDefault();
    store.editorRedo();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
});
</script>
