/**
 * vue-shell.js — mounts the shared Vue 3 application shell.
 *
 * Each window entry (src/entries/*.js) imports the existing vanilla-JS
 * bootstrap first (which manipulates the static DOM in the window's HTML),
 * then calls mountVueShell() to bring up a Vue instance on #vue-root.
 *
 * The Vue app does NOT take over the existing #app DOM — it mounts on a
 * separate #vue-root element so existing document.getElementById lookups,
 * canvas contexts, and event listeners are preserved. This is the lowest-
 * risk way to introduce Vue into a large vanilla-JS codebase: the shell
 * is available for incremental component migration without disturbing
 * the existing renderer pipeline (canvas, audio, ONNX inference).
 */

import { createApp } from 'vue';
import App from './App.vue';

/**
 * Mount the Vue shell on #vue-root. Safe to call before the element exists
 * (e.g. if a window's HTML hasn't added it yet) — returns null in that case.
 *
 * @returns {import('vue').App<Element> | null} The mounted Vue app instance,
 *          or null if #vue-root was not found.
 */
export function mountVueShell() {
  const root = document.getElementById('vue-root');
  if (!root) {
    // Not fatal — the window still works via its vanilla-JS bootstrap.
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[vue-shell] #vue-root not found; Vue shell not mounted.');
    }
    return null;
  }
  return createApp(App).mount(root);
}

export default mountVueShell;
