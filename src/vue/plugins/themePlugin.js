/**
 * Vue theme plugin — wraps src/themes/themeInit.js initWindowTheme().
 *
 * Each window's root App component calls this in onMounted; the plugin
 * also provides $initTheme for components that need to (re)apply theme.
 */
import { initWindowTheme } from '../../themes/themeInit.js';

const ipcCleanups = [];

function install(app) {
  app.config.globalProperties.$initTheme = () => initWindowTheme(ipcCleanups);
  app.provide('themeCleanups', ipcCleanups);
}

export default install;
export { initWindowTheme };
