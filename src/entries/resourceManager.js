import '../tauri-bridge.js';
import ResourceManagerApp from '../vue/windows/resourceManager/ResourceManagerApp.vue';
import { createWindowApp } from '../vue/createApp.js';
import { initI18n } from '../i18n/index.js';

initI18n().then(() => {
  createWindowApp(ResourceManagerApp).mount('#app');
});
