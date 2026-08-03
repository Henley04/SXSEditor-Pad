import '../tauri-bridge.js';
import UpdateNotificationApp from '../vue/windows/updateNotification/UpdateNotificationApp.vue';
import { createWindowApp } from '../vue/createApp.js';
import { initI18n } from '../i18n/index.js';

initI18n().then(() => {
  createWindowApp(UpdateNotificationApp).mount('#app');
});
