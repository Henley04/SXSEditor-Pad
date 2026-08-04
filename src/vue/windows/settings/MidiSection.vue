<!--
  MidiSection.vue — MIDI extraction tool picker. Mirrors #section-midi markup.
-->
<template>
  <div class="settings-section">
    <div class="setting-group">
      <label for="midiExtractTool">{{ $t('settings.midiExtractTool') }}</label>
      <select id="midiExtractTool" :value="store.midi.extractTool" @change="onChange">
        <option value="basicpitch">{{ $t('settings.midiExtractToolBasicpitch') }}</option>
        <option value="rmvpe">{{ $t('settings.midiExtractToolRmvpe') }}</option>
      </select>
      <p class="hint">{{ $t('settings.midiExtractToolHint') }}</p>
    </div>
  </div>
</template>

<script setup>
import { useSettingsStore } from './store.js';
const store = useSettingsStore();

function onChange(e) {
  store.setMidiExtractTool(e.target.value);
}
</script>
