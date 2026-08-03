/**
 * createApp factory — builds a Vue 3 app pre-configured with Pinia and
 * the shared i18n / theme / icon plugins. Each window's entry calls
 * this instead of calling vue-shell's mountVueShell().
 *
 * Usage:
 *   import { createWindowApp } from '../vue/createApp.js';
 *   import MainWindow from '../vue/windows/main/MainWindow.vue';
 *   createWindowApp(MainWindow).mount('#app');
 */
import { createApp as vueCreateApp } from 'vue';
import { createPinia } from 'pinia';
import i18nPlugin from './plugins/i18nPlugin.js';
import themePlugin from './plugins/themePlugin.js';
import iconPlugin from './plugins/iconPlugin.js';

export function createWindowApp(rootComponent, rootProps) {
  const app = vueCreateApp(rootComponent, rootProps);
  const pinia = createPinia();
  app.use(pinia);
  app.use(i18nPlugin);
  app.use(themePlugin);
  app.use(iconPlugin);
  return app;
}

export default createWindowApp;
