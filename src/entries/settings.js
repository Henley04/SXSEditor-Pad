/**
 * settings_window entry — Vue 3 + Pinia settings app.
 *
 * Replaces the vanilla-JS src/settings.js bootstrap: the full settings UI
 * (sidebar nav, 11 sections, theme editor, save-as modal, toast) now lives
 * in SettingsApp.vue with reactive state in the Pinia store at
 * src/vue/windows/settings/store.js.
 */
import '../tauri-bridge.js';
import SettingsApp from '../vue/windows/settings/SettingsApp.vue';
import { createWindowApp } from '../vue/createApp.js';
import { initI18n } from '../i18n/index.js';

initI18n().then(() => {
  createWindowApp(SettingsApp).mount('#app');
});
