<!--
  UpdateSection.vue — app update channel / auto-check / check-now / result.
  Mirrors #section-update markup. On mobile, the "installer download"
  channel concept doesn't apply — updates are delivered via the Tauri
  APK. The channel select and installer-specific hints are hidden; the
  auto-check toggle and check-now button remain (they check for model
  updates from ModelScope, which is relevant on all platforms).
-->
<template>
  <div class="settings-section">
    <!-- Desktop-only: update channel (release/nightly installer builds).
         On mobile, updates are delivered via APK / app store, not installer. -->
    <div class="setting-group" v-if="!isMobile">
      <label for="updateChannelSelect">{{ $t('update.channel') }}</label>
      <select id="updateChannelSelect" :value="store.update.channel" @change="store.setUpdateChannel($event.target.value)">
        <option value="release">{{ $t('update.channelRelease') }}</option>
        <option value="nightly">{{ $t('update.channelNightly') }}</option>
      </select>
      <p class="hint">{{ $t('update.channelHint') }}</p>
    </div>

    <div class="setting-group">
      <label class="device-mode-radio">
        <input type="checkbox" :checked="store.update.autoCheck"
          @change="store.setAutoCheckUpdates($event.target.checked)">
        <span class="radio-label">{{ $t('update.autoCheck') }}</span>
      </label>
      <p class="hint">{{ isMobile
        ? 'Automatically check for model updates from ModelScope on app launch.'
        : $t('update.autoCheckHint') }}</p>
    </div>

    <div class="setting-group">
      <button class="btn-open-model-download" :disabled="store.update.checkBtnDisabled"
        @click="store.checkUpdateNow">{{ store.update.checkBtnText || $t('update.checkNow') }}</button>
      <span class="hint">{{ store.update.checkStatusText }}</span>
    </div>

    <div v-show="store.update.resultVisible" class="setting-group">
      <div class="info-box">
        <div v-for="(line, i) in store.update.resultLines" :key="i">{{ line }}</div>
      </div>
    </div>

    <div v-show="store.update.reEnableReminderVisible" class="setting-group">
      <button class="btn-open-model-download" @click="store.reEnableReminder">{{ $t('update.reEnableReminder') }}</button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useSettingsStore } from './store.js';
const store = useSettingsStore();

const isMobile = computed(() => {
  const ua = navigator.userAgent || '';
  return /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(ua);
});
</script>
