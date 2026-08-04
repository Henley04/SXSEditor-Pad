<!--
  AlertDialog.vue — Vue implementation of the imperative alert/confirm
  dialogs previously built via document.createElement in alertDialog.js.

  Not used directly in templates; the composable in alertDialogService.js
  mounts this onto a temporary element for imperative showAlertDialog /
  showConfirmDialog / showProjectInfoImportDialog calls.
-->
<template>
  <div class="alert-dialog-overlay" @keydown="onKeydown" tabindex="-1" ref="overlayRef">
    <div class="alert-dialog-box" :class="variantClass">
      <div v-if="title" class="alert-dialog-title">{{ title }}</div>
      <div class="alert-dialog-message">{{ message }}</div>

      <!-- project info import checkboxes -->
      <div v-if="projectInfo" class="alert-dialog-options">
        <label v-if="projectInfo.bpm != null" class="alert-option-row">
          <input type="checkbox" v-model="applyBpm" />
          <span><strong>{{ $tOr('main.midiProjectInfoBpm', 'BPM') }}</strong>: {{ projectInfo.bpm }} → {{ current.currentBpm }}</span>
        </label>
        <label v-if="projectInfo.timeSignature != null" class="alert-option-row">
          <input type="checkbox" v-model="applyTimeSig" />
          <span><strong>{{ $tOr('main.midiProjectInfoTimeSig', 'Time Signature') }}</strong>: {{ projectInfo.timeSignature.join('/') }} → {{ current.currentTimeSignature.join('/') }}</span>
        </label>
      </div>

      <div class="alert-dialog-actions">
        <button v-if="showCancel" class="alert-btn alert-btn-cancel" @click="onCancel" ref="cancelBtnRef">{{ cancelText }}</button>
        <button class="alert-btn alert-btn-ok" :class="okBtnClass" @click="onOk" ref="okBtnRef">{{ okText }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, nextTick, computed } from 'vue';

const props = defineProps({
  message: { type: String, required: true },
  title: { type: String, default: '' },
  variant: { type: String, default: 'alert' }, // 'alert' | 'confirm' | 'project-info'
  okText: { type: String, default: '' },
  cancelText: { type: String, default: '' },
  projectInfo: { type: Object, default: null },
  current: { type: Object, default: null },
});

const emit = defineEmits(['ok', 'cancel']);

const overlayRef = ref(null);
const okBtnRef = ref(null);
const cancelBtnRef = ref(null);
const applyBpm = ref(true);
const applyTimeSig = ref(true);

const showCancel = computed(() => props.variant !== 'alert');
const variantClass = computed(() => `variant-${props.variant}`);
const okBtnClass = computed(() => props.variant === 'confirm' ? 'alert-btn-danger' : '');

onMounted(async () => {
  await nextTick();
  const focusTarget = props.variant === 'confirm' ? cancelBtnRef.value : okBtnRef.value;
  if (focusTarget) focusTarget.focus();
});

function onOk() {
  if (props.variant === 'project-info') {
    emit('ok', { applyBpm: applyBpm.value, applyTimeSig: applyTimeSig.value });
  } else {
    emit('ok');
  }
}

function onCancel() {
  emit('cancel');
}

function onKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    onOk();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    onCancel();
  }
}
</script>

<style scoped>
.alert-dialog-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: var(--overlay-scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  backdrop-filter: blur(4px);
  animation: sxs-overlay-in 0.25s ease;
}
.alert-dialog-box {
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  clip-path: var(--clip-panel, none);
  padding: 20px;
  min-width: 280px;
  max-width: 460px;
  color: var(--fg-primary);
  box-shadow: 0 16px 48px var(--shadow-color-strong), 0 0 40px var(--accent-softer);
  animation: sxs-dialog-enter 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
.alert-dialog-title { margin-bottom: 12px; font-size: 15px; font-weight: 600; }
.alert-dialog-message { margin-bottom: 16px; line-height: 1.5; white-space: pre-wrap; }
.alert-dialog-options { margin-bottom: 16px; }
.alert-option-row {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border: 1px solid var(--border);
  border-radius: 6px; cursor: pointer; margin-top: 8px;
}
.alert-option-row:first-child { margin-top: 0; }
.alert-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
.alert-btn {
  padding: 6px 20px;
  border-radius: 6px;
  clip-path: var(--clip-button, none);
  cursor: pointer;
  font-weight: 500;
  transition: background-color 0.15s, box-shadow 0.15s, transform 0.15s;
}
.alert-btn-ok {
  background: var(--bg-button-primary, var(--accent, #4a90e2));
  border: none;
  color: var(--fg-on-accent, #fff);
}
.alert-btn-danger {
  background: var(--bg-button-danger);
  border: none;
  color: var(--fg-on-accent, #fff);
}
.alert-btn-cancel {
  background: var(--bg-button);
  border: 1px solid var(--border-strong);
  color: var(--fg-muted);
}
.alert-btn:hover { transform: translateY(-1px); }
.alert-btn:active { transform: translateY(0) scale(0.97); }

@keyframes sxs-overlay-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes sxs-dialog-enter {
  from { opacity: 0; transform: translateY(12px) scale(0.97); filter: blur(4px); }
  to { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
}
</style>
