import '../tauri-bridge.js';
import FragmentEditorApp from '../vue/windows/fragmentEditor/FragmentEditorApp.vue';
import { createWindowApp } from '../vue/createApp.js';
import { initI18n } from '../i18n/index.js';
initI18n().then(() => { createWindowApp(FragmentEditorApp).mount('#app'); });
