import '../tauri-bridge.js';
import MainWindowApp from '../vue/windows/main/MainWindowApp.vue';
import { createWindowApp } from '../vue/createApp.js';
import { initI18n } from '../i18n/index.js';
initI18n().then(() => { createWindowApp(MainWindowApp).mount('#app'); });
