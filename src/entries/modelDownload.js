/**
 * model_download_window entry — Vue 3 + Pinia replacement for the vanilla-JS
 * src/modelDownload.js bootstrap.
 */
import '../tauri-bridge.js';
import ModelDownloadApp from '../vue/windows/modelDownload/ModelDownloadApp.vue';
import { createWindowApp } from '../vue/createApp.js';
import { initI18n } from '../i18n/index.js';
initI18n().then(() => { createWindowApp(ModelDownloadApp).mount('#app'); });
