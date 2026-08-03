import '../tauri-bridge.js';
import AudioPreprocessApp from '../vue/windows/audioPreprocess/AudioPreprocessApp.vue';
import { createWindowApp } from '../vue/createApp.js';
import { initI18n } from '../i18n/index.js';
initI18n().then(() => { createWindowApp(AudioPreprocessApp).mount('#app'); });
