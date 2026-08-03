<!--
  AudioSection.vue — audio output settings (mode, device, sample rate, bit
  depth, buffer size, master volume, WASAPI exclusive info).
  Mirrors #section-audio markup.
-->
<template>
  <div class="settings-section">
    <div class="setting-group">
      <label for="audioOutputMode">{{ $t('settings.outputMode') }}</label>
      <select id="audioOutputMode" :value="store.audio.outputMode"
        :disabled="store.audio.modeDisabled" @change="store.setAudioOutputMode($event.target.value)">
        <option value="shared">{{ $t('settings.sharedMode') }}</option>
        <option value="exclusive">{{ $t('settings.exclusiveMode') }}</option>
      </select>
      <p class="hint">{{ $t('settings.exclusiveModeHint') }}</p>
    </div>

    <div class="setting-group">
      <label for="audioOutputDevice">{{ $t('settings.outputDevice') }}</label>
      <select id="audioOutputDevice" :value="store.audio.outputDevice" @change="store.setAudioOutputDevice($event.target.value)">
        <option v-for="d in store.audio.outputDevices" :key="d.id" :value="String(d.id)">{{ d.name }}</option>
      </select>
      <p class="hint">{{ $t('settings.outputDeviceHint') }}</p>
    </div>

    <div class="setting-group">
      <label for="audioSampleRate">{{ $t('settings.sampleRate') }}</label>
      <select id="audioSampleRate" :value="store.audio.sampleRate" @change="store.setAudioSampleRate($event.target.value)">
        <option value="22050">22050 Hz</option>
        <option value="24000">24000 Hz (模型原生)</option>
        <option value="44100">44100 Hz (CD 品质)</option>
        <option value="48000">48000 Hz (标准)</option>
        <option value="96000">96000 Hz (高品质)</option>
        <option value="192000">192000 Hz (录音棚)</option>
      </select>
      <p class="hint">{{ $t('settings.sampleRateHint') }}</p>
    </div>

    <div class="setting-group">
      <label for="audioBitDepth">{{ $t('settings.bitDepth') }}</label>
      <select id="audioBitDepth" :value="store.audio.bitDepth" :disabled="store.audioBitDepthDisabled"
        @change="store.setAudioBitDepth($event.target.value)">
        <option value="float32">32-bit Float (推荐)</option>
        <option value="int32">32-bit Integer</option>
        <option value="int24">24-bit Integer</option>
        <option value="int16">16-bit Integer (CD 品质)</option>
      </select>
      <p class="hint">{{ $t('settings.bitDepthHint') }}</p>
    </div>

    <div class="setting-group">
      <label for="audioBufferSize">{{ $t('settings.bufferSize') }}</label>
      <select id="audioBufferSize" :value="store.audio.bufferSize" @change="store.setAudioBufferSize($event.target.value)">
        <option value="64">64 采样 (~1.3ms)</option>
        <option value="128">128 采样 (~2.7ms)</option>
        <option value="256">256 采样 (~5.3ms)</option>
        <option value="512">512 采样 (~10.7ms)</option>
        <option value="1024">1024 采样 (~21.3ms)</option>
        <option value="2048">2048 采样 (~42.7ms)</option>
        <option value="4096">4096 采样 (~85.3ms)</option>
      </select>
      <p class="hint">{{ $t('settings.bufferSizeHint') }}</p>
    </div>

    <div class="setting-group">
      <label for="audioVolume">
        <span>{{ $t('settings.masterVolume') }}</span>
        <span class="volume-display">{{ store.volumePercent }}</span>
      </label>
      <input type="range" id="audioVolume" min="0" max="100" step="1"
        :value="store.audio.volume" @input="store.setAudioVolume(Number($event.target.value))">
      <p class="hint">{{ $t('settings.volumeHint') }}</p>
    </div>

    <div v-show="store.audioExclusiveInfoVisible" class="setting-group">
      <div class="info-box">
        <strong>{{ $t('settings.wasapiExclusiveInfo') }}</strong>
        <ul>
          <li>{{ $t('settings.wasapiInfo1') }}</li>
          <li>{{ $t('settings.wasapiInfo2') }}</li>
          <li>{{ $t('settings.wasapiInfo3') }}</li>
          <li>{{ $t('settings.wasapiInfo4') }}</li>
          <li>{{ $t('settings.wasapiInfo5') }}</li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useSettingsStore } from './store.js';
const store = useSettingsStore();
</script>
