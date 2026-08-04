import '../tauri-bridge.js';
import SingerCreatorApp from '../vue/windows/singerCreator/SingerCreatorApp.vue';
import { createWindowApp } from '../vue/createApp.js';
import { initI18n } from '../i18n/index.js';
initI18n().then(() => { createWindowApp(SingerCreatorApp).mount('#app'); });
