/**
 * splash_window entry — Vue splash app.
 *
 * Splash keeps its inline SVG in the HTML for instant paint (before JS
 * loads). This entry mounts a Vue app on #app whose onMounted enriches
 * the version/build-date text. No tauri-bridge (splash.js reads
 * window.splashAPI injected by Rust).
 */
import SplashApp from '../vue/windows/splash/SplashApp.vue';
import { createWindowApp } from '../vue/createApp.js';

createWindowApp(SplashApp).mount('#app');
