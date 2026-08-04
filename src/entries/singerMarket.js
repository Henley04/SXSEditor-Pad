import '../tauri-bridge.js';
import SingerMarketApp from '../vue/windows/singerMarket/SingerMarketApp.vue';
import { createWindowApp } from '../vue/createApp.js';
import { initI18n } from '../i18n/index.js';

initI18n().then(() => {
  createWindowApp(SingerMarketApp).mount('#app');
});
