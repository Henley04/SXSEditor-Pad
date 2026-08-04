/**
 * Vue theme plugin — re-exports src/themes/themeInit.js initWindowTheme().
 *
 * Each window's root component imports initWindowTheme directly and calls
 * it in onMounted with its own local cleanup array (cleaned up in
 * onUnmounted). This plugin just ensures the function is available app-wide
 * for any component that needs it.
 */
import { initWindowTheme } from '../../themes/themeInit.js';

function install(app) {
  app.config.globalProperties.$initTheme = (cleanups) => initWindowTheme(cleanups);
}

export default install;
export { initWindowTheme };
