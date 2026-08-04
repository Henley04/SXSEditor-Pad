<!--
  ResourceManagerApp.vue — Vue 3 + Pinia replacement for the vanilla-JS
  src/resourceManager.js bootstrap.

  The template fully replaces the static body of src/resourceManager.html.
  All IPC calls, dynamic card generation (GPU cards, model groups, summary),
  button loading states, expand/collapse animation, and auto-refresh live here.
-->
<template>
  <div class="rm-container">
    <h2>{{ $t('resourceManager.title') }}</h2>

    <!-- ==================== GPU Info ==================== -->
    <div class="rm-section gpu-section">
      <h3 class="section-title">{{ $t('resourceManager.gpuInfo') }}</h3>
      <div class="gpu-info-content">
        <div v-if="!store.initialized" class="loading-hint">{{ $t('resourceManager.loading') }}</div>
        <div v-else-if="store.gpuFailed" class="gpu-no-data">{{ $t('resourceManager.loadFailed') }}</div>
        <div v-else-if="store.gpus.length === 0" class="gpu-no-data">{{ $t('resourceManager.noGpuDetected') }}</div>
        <template v-else>
          <div
            v-for="(gpu, idx) in store.gpus"
            :key="gpu.name || idx"
            class="gpu-card"
          >
            <div class="gpu-card-header">
              <span class="gpu-name" :title="gpu.name">{{ gpu.name }}</span>
              <div class="gpu-badges">
                <span class="gpu-badge" :class="gpuTypeBadgeClass(gpu)">{{ gpuTypeBadgeText(gpu) }}</span>
                <span v-if="gpu.vendor" class="gpu-badge vendor">{{ gpu.vendor }}</span>
              </div>
            </div>
            <div class="vram-bar-container">
              <div class="vram-label">
                <span class="vram-used">{{ formatBytes(gpu.currentUsageBytes) }} {{ $t('resourceManager.used') }}</span>
                <span class="vram-total">{{ formatBytes(gpu.budgetBytes) }} {{ $t('resourceManager.total') }}</span>
              </div>
              <div class="vram-bar">
                <div
                  class="vram-bar-fill"
                  :class="vramBarClass(gpu)"
                  :style="{ width: usagePercent(gpu).toFixed(1) + '%' }"
                ></div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- ==================== Model Management ==================== -->
    <div class="rm-section models-section">
      <h3 class="section-title">{{ $t('resourceManager.modelManagement') }}</h3>
      <p class="section-desc">{{ $t('resourceManager.modelManagementDesc') }}</p>
      <div class="model-groups-content">
        <div v-if="!store.initialized" class="loading-hint">{{ $t('resourceManager.loading') }}</div>
        <div v-else-if="store.modelsFailed" class="gpu-no-data">{{ $t('resourceManager.loadFailed') }}</div>
        <div v-else-if="store.groups.length === 0" class="gpu-no-data">{{ $t('resourceManager.noModels') }}</div>
        <template v-else>
          <div
            v-for="group in store.groups"
            :key="group.id"
            class="model-group"
            :data-group-id="group.id"
          >
            <!-- Header (click toggles expand) -->
            <div class="model-group-header" @click="toggleGroup(group)">
              <span class="group-arrow" :class="{ expanded: isGroupExpanded(group.id) }">
                <Icon name="chevron-right" :size="12" />
              </span>
              <span class="group-name">{{ getLocalizedName(group) }}</span>
              <span class="group-loaded-badge" :class="groupBadgeClass(group)">
                {{ loadedCount(group) }}/{{ totalCount(group) }}
              </span>
              <div class="group-actions">
                <button
                  class="group-action-btn load-all"
                  :class="{ loading: isLoadingGroupAction(group.id, 'load') }"
                  :disabled="isLoadAllDisabled(group)"
                  @click.stop="onLoadAll(group)"
                >{{ loadAllBtnText(group) }}</button>
                <button
                  class="group-action-btn unload-all"
                  :class="{ loading: isLoadingGroupAction(group.id, 'unload') }"
                  :disabled="isUnloadAllDisabled(group)"
                  @click.stop="onUnloadAll(group)"
                >{{ unloadAllBtnText(group) }}</button>
              </div>
            </div>

            <!-- Body (animated via imperative max-height, see toggleGroup) -->
            <div
              class="model-group-body"
              :class="{ expanded: isGroupExpanded(group.id) }"
              :ref="el => setGroupBodyRef(el, group.id)"
            >
              <div class="model-list">
                <div
                  v-for="model in group.models"
                  :key="model.id"
                  class="model-item"
                >
                  <div class="model-info">
                    <div class="model-name">{{ getLocalizedName(model) }}</div>
                    <div v-if="getLocalizedDesc(model)" class="model-desc">{{ getLocalizedDesc(model) }}</div>
                  </div>
                  <div class="model-meta">
                    <span v-if="model.fileSize > 0" class="model-size">{{ formatBytes(model.fileSize) }}</span>
                    <span v-if="!model.filesExist" class="model-missing">{{ $t('resourceManager.filesMissing') }}</span>
                    <span class="ep-badge" :class="getEPBadgeClass(model.ep)">
                      {{ model.loaded ? getEPLabel(model.ep) : '—' }}
                    </span>
                    <button
                      class="model-btn"
                      :class="modelBtnClassObj(group, model)"
                      :disabled="modelBtnDisabled(group, model)"
                      @click="onModelBtnClick(group, model)"
                    >{{ modelBtnText(group, model) }}</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- ==================== Summary ==================== -->
    <div class="rm-section summary-section">
      <h3 class="section-title">{{ $t('resourceManager.summary') }}</h3>
      <div class="summary-content">
        <template v-if="store.summary">
          <div class="summary-row">
            <span class="summary-label">{{ $t('resourceManager.loadedModelsCount') }}</span>
            <span class="summary-value accent">{{ store.summary.loadedModels }} / {{ store.summary.totalModels }}</span>
          </div>
          <div class="summary-row">
            <span class="summary-label">{{ $t('resourceManager.estimatedVramUsage') }}</span>
            <span class="summary-value green">{{ summaryVramText }}</span>
          </div>
        </template>
        <div v-else-if="store.initialized && !store.modelsFailed" class="gpu-no-data">{{ $t('resourceManager.noModels') }}</div>
      </div>
    </div>

    <!-- ==================== Actions ==================== -->
    <div class="rm-actions">
      <button
        id="refreshBtn"
        :disabled="store.refreshing"
        :class="{ loading: store.refreshing }"
        @click="onRefresh"
      >{{ refreshBtnText }}</button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useResourceManagerStore } from './store.js';
import { t, getLocale } from '../../../i18n/index.js';
import { formatBytes } from '../../../utils/formatBytes.js';
import { initWindowTheme } from '../../../themes/themeInit.js';

// Pull in the CSS the vanilla-JS bootstrap imported so the existing
// .rm-container / .gpu-card / .model-group / .summary-row styles still apply.
import '../../../common.css';
import '../../../resourceManager.css';

const store = useResourceManagerStore();

// ==================== Component-local UI state ====================

// Per-button loading flags. Keyed by `${groupId}` for group actions (with a
// 'load'/'unload' suffix) and `${groupId}:${modelId}` for model buttons.
const loadingGroupActions = ref(new Set());
const loadingModelActions = ref(new Set());

// Expand/collapse state per group id.
const expandedGroups = ref(new Set());
// Body element refs keyed by group id (needed for imperative max-height).
const groupBodyEls = new Map();

// IPC + window event cleanups collected here, flushed in onUnmounted.
const cleanups = [];

// ==================== i18n / localization helpers ====================

function getLocalizedName(item) {
  if (getLocale() === 'en' && item.nameEn) return item.nameEn;
  return item.name;
}

function getLocalizedDesc(item) {
  if (getLocale() === 'en' && item.descriptionEn) return item.descriptionEn;
  return item.description;
}

// ==================== EP (execution-provider) helpers ====================

function getEPLabel(ep) {
  if (!ep) return '';
  const map = { dml: 'DML', cpu: 'CPU', tfjs: 'TFJS' };
  return map[ep.toLowerCase()] || ep.toUpperCase();
}

function getEPBadgeClass(ep) {
  if (!ep) return 'none';
  const map = { dml: 'dml', cpu: 'cpu', tfjs: 'tfjs' };
  return map[ep.toLowerCase()] || 'none';
}

// ==================== GPU card helpers ====================

function usagePercent(gpu) {
  return gpu.budgetBytes > 0
    ? Math.min(100, (gpu.currentUsageBytes / gpu.budgetBytes) * 100)
    : 0;
}

function vramBarClass(gpu) {
  const p = usagePercent(gpu);
  if (p >= 90) return 'critical';
  if (p >= 70) return 'warning';
  return '';
}

function gpuTypeBadgeClass(gpu) {
  if (gpu.deviceType === 'npu') return 'npu';
  if (gpu.deviceType === 'discrete-gpu' || gpu.isDiscrete === true) return 'discrete';
  if (gpu.deviceType === 'integrated-gpu' || gpu.isDiscrete === false) return 'integrated';
  return '';
}

function gpuTypeBadgeText(gpu) {
  if (gpu.deviceType === 'npu') return 'NPU';
  if (gpu.deviceType === 'discrete-gpu' || gpu.isDiscrete === true) return t('resourceManager.discrete');
  if (gpu.deviceType === 'integrated-gpu' || gpu.isDiscrete === false) return t('resourceManager.integrated');
  return 'CPU';
}

// ==================== Model group helpers ====================

function loadedCount(group) {
  return group.models.filter(m => m.loaded).length;
}

function totalCount(group) {
  return group.models.length;
}

function groupBadgeClass(group) {
  const loaded = loadedCount(group);
  const total = totalCount(group);
  if (loaded === total && total > 0) return 'all-loaded';
  if (loaded === 0) return 'none-loaded';
  return '';
}

// ==================== Group action button helpers ====================

function isLoadingGroupAction(groupId, action) {
  return loadingGroupActions.value.has(groupId + ':' + action);
}

function loadAllBtnText(group) {
  if (isLoadingGroupAction(group.id, 'load')) return t('resourceManager.loading');
  return t('resourceManager.loadAll');
}

function unloadAllBtnText(group) {
  if (isLoadingGroupAction(group.id, 'unload')) return t('resourceManager.loading');
  return t('resourceManager.unloadAll');
}

function isLoadAllDisabled(group) {
  if (isLoadingGroupAction(group.id, 'load')) return true;
  return loadedCount(group) === totalCount(group);
}

function isUnloadAllDisabled(group) {
  if (isLoadingGroupAction(group.id, 'unload')) return true;
  return loadedCount(group) === 0;
}

// ==================== Model button helpers ====================

function isLoadingModelAction(group, model) {
  return loadingModelActions.value.has(group.id + ':' + model.id);
}

function modelBtnClassObj(group, model) {
  return {
    load: !model.loaded,
    unload: model.loaded,
    loading: isLoadingModelAction(group, model),
  };
}

function modelBtnText(group, model) {
  if (isLoadingModelAction(group, model)) return t('resourceManager.loading');
  return model.loaded ? t('resourceManager.unload') : t('resourceManager.load');
}

function modelBtnDisabled(group, model) {
  if (isLoadingModelAction(group, model)) return true;
  if (model.loaded) return false;
  return !model.filesExist;
}

// ==================== Summary computed ====================

const summaryVramText = computed(() => {
  const s = store.summary;
  if (!s) return '';
  return formatBytes(s.estimatedVram) + (s.totalBudget > 0 ? ' / ' + formatBytes(s.totalBudget) : '');
});

// ==================== Refresh button ====================

const refreshBtnText = computed(() =>
  store.refreshing ? t('resourceManager.loading') : t('resourceManager.refresh')
);

function onRefresh() {
  store.loadData();
}

// ==================== IPC handlers ====================

async function onLoadAll(group) {
  const key = group.id + ':load';
  loadingGroupActions.value.add(key);
  try {
    try {
      await window.electronAPI.resmgrLoadGroup(group.id);
    } catch (err) {
      console.error('Failed to load model group:', err);
    }
    await store.loadData();
  } finally {
    loadingGroupActions.value.delete(key);
  }
}

async function onUnloadAll(group) {
  const key = group.id + ':unload';
  loadingGroupActions.value.add(key);
  try {
    try {
      await window.electronAPI.resmgrUnloadGroup(group.id);
    } catch (err) {
      console.error('Failed to unload model group:', err);
    }
    await store.loadData();
  } finally {
    loadingGroupActions.value.delete(key);
  }
}

async function onModelBtnClick(group, model) {
  const key = group.id + ':' + model.id;
  loadingModelActions.value.add(key);
  try {
    try {
      if (model.loaded) {
        await window.electronAPI.resmgrUnloadModel(group.id, model.id);
      } else {
        await window.electronAPI.resmgrLoadModel(group.id, model.id);
      }
    } catch (err) {
      console.error('Failed to (un)load model:', err);
    }
    await store.loadData();
  } finally {
    loadingModelActions.value.delete(key);
  }
}

// ==================== Expand / collapse ====================

function setGroupBodyRef(el, groupId) {
  if (el) {
    groupBodyEls.set(groupId, el);
  } else {
    groupBodyEls.delete(groupId);
  }
}

function isGroupExpanded(groupId) {
  return expandedGroups.value.has(groupId);
}

// Mirrors the imperative max-height animation from the old bootstrap:
// collapsing sets height to scrollHeight, forces a reflow, then sets 0;
// expanding sets scrollHeight and clears to 'none' on transitionend so the
// body can grow freely afterwards.
function toggleGroup(group) {
  const bodyEl = groupBodyEls.get(group.id);
  if (!bodyEl) return;
  const isExpanded = expandedGroups.value.has(group.id);

  if (isExpanded) {
    // Collapse
    bodyEl.style.maxHeight = bodyEl.scrollHeight + 'px';
    // Force reflow so the next max-height change triggers a transition.
    void bodyEl.offsetHeight; // eslint-disable-line no-unused-expressions
    bodyEl.style.maxHeight = '0px';
    expandedGroups.value.delete(group.id);
  } else {
    // Expand
    expandedGroups.value.add(group.id);
    bodyEl.style.maxHeight = bodyEl.scrollHeight + 'px';
    const onEnd = () => {
      if (expandedGroups.value.has(group.id)) {
        bodyEl.style.maxHeight = 'none';
      }
      bodyEl.removeEventListener('transitionend', onEnd);
    };
    bodyEl.addEventListener('transitionend', onEnd);
  }
}

// ==================== Auto refresh ====================

let autoRefreshTimer = null;

function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshTimer = setInterval(() => {
    store.autoRefresh();
  }, 30000);
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

function handleBeforeUnload() {
  stopAutoRefresh();
}

// ==================== Lifecycle ====================

onMounted(() => {
  initWindowTheme(cleanups);
  document.documentElement.lang = getLocale();
  window.addEventListener('beforeunload', handleBeforeUnload);
  store.loadData();
  startAutoRefresh();
});

onUnmounted(() => {
  stopAutoRefresh();
  window.removeEventListener('beforeunload', handleBeforeUnload);
  for (const cleanup of cleanups) {
    try { cleanup(); } catch (_) { /* noop */ }
  }
  cleanups.length = 0;
  groupBodyEls.clear();
});
</script>

<style scoped>
/* All window styles for the Resource Manager are imported globally from
   src/resourceManager.css + src/common.css (see <script setup> imports), so
   the existing class names reused in the template above apply unchanged.
   This block is intentionally left for component-scoped additions if needed. */
</style>
