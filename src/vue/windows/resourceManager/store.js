/**
 * resourceManager Pinia store — reactive state for the Resource Manager window.
 *
 * Holds GPU info, model groups, and load-status flags. All IPC calls
 * (window.electronAPI.resmgr*) and the dedup/refresh logic that previously
 * lived in src/resourceManager.js live here as actions.
 */
import { defineStore } from 'pinia';

// Dedupe token for in-flight loadData() calls (kept out of reactive state so
// storing a Promise does not perturb Vue's reactivity tracking).
let _loadDataPromise = null;

export const useResourceManagerStore = defineStore('resourceManager', {
  state: () => ({
    // GPU info
    gpus: [],
    gpuFailed: false,

    // Model groups
    groups: [],
    modelsFailed: false,

    // Lifecycle flags
    initialized: false, // false until the first loadData() resolves
    refreshing: false,  // refresh-button loading state
  }),

  getters: {
    /**
     * Aggregate summary computed from the current groups + gpus.
     * Mirrors renderSummary() in the old vanilla-JS bootstrap.
     * Returns null when there is no model data.
     */
    summary(state) {
      const groups = state.groups;
      if (!groups || groups.length === 0) return null;

      let totalModels = 0;
      let loadedModels = 0;
      let estimatedVram = 0;

      for (const group of groups) {
        totalModels += group.models.length;
        for (const model of group.models) {
          if (model.loaded) {
            loadedModels++;
            if (model.ep !== 'cpu' && model.fileSize > 0) {
              estimatedVram += model.fileSize;
            }
          }
        }
      }

      let totalBudget = 0;
      if (state.gpus && state.gpus.length > 0) {
        totalBudget = state.gpus.reduce((sum, g) => sum + (g.budgetBytes || 0), 0);
      }

      return { totalModels, loadedModels, estimatedVram, totalBudget };
    },
  },

  actions: {
    /**
     * Manual / first load. Sets the refresh button into loading state, fetches
     * GPU info + model groups in parallel, and records per-section failure
     * flags so the UI can render a "load failed" message. Dedupes concurrent
     * callers onto a single in-flight promise.
     */
    async loadData() {
      if (_loadDataPromise) return _loadDataPromise;
      this.refreshing = true;

      _loadDataPromise = (async () => {
        try {
          const [gpuResult, modelResult] = await Promise.all([
            window.electronAPI.resmgrGetGPUInfo(),
            window.electronAPI.resmgrGetModelGroups(),
          ]);

          if (gpuResult.success) {
            this.gpus = gpuResult.gpus || [];
            this.gpuFailed = false;
          } else {
            this.gpus = [];
            this.gpuFailed = true;
          }

          if (modelResult.success) {
            this.groups = modelResult.groups || [];
            this.modelsFailed = false;
          } else {
            this.groups = [];
            this.modelsFailed = true;
          }
        } catch (err) {
          console.error('Failed to load data:', err);
          this.gpus = [];
          this.groups = [];
          this.gpuFailed = true;
          this.modelsFailed = true;
        } finally {
          this.refreshing = false;
          this.initialized = true;
          _loadDataPromise = null;
        }
      })();

      return _loadDataPromise;
    },

    /**
     * Silent background refresh (30s timer). Only overwrites state on success;
     * on failure the previous data is left untouched. Never flips the
     * refreshing flag so the refresh button stays calm.
     */
    async autoRefresh() {
      try {
        const [gpuResult, modelResult] = await Promise.all([
          window.electronAPI.resmgrGetGPUInfo(),
          window.electronAPI.resmgrGetModelGroups(),
        ]);

        if (gpuResult.success) {
          this.gpus = gpuResult.gpus || [];
          this.gpuFailed = false;
        }

        if (modelResult.success) {
          this.groups = modelResult.groups || [];
          this.modelsFailed = false;
        }
      } catch (_) {
        // silent refresh
      }
    },
  },
});
