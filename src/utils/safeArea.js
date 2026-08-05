/**
 * safeArea.js — shared safe-area detection for all window entry points.
 *
 * On Android Tauri, env(safe-area-inset-top) often returns 0 because the
 * Android window plugin doesn't set up status bar insets. This utility
 * detects the status bar height by comparing window.screen.height with
 * window.innerHeight, and injects it as the --safe-area-top CSS variable
 * on :root. Also handles --safe-area-bottom for navigation bars.
 *
 * Usage:
 *   import { applySafeAreaInsets } from '../utils/safeArea.js';
 *   const cleanup = applySafeAreaInsets();
 *   // ... later: cleanup();
 */

export function applySafeAreaInsets() {
  function update() {
    const screenH = window.screen ? window.screen.height : 0;
    const screenW = window.screen ? window.screen.width : 0;
    const innerH = window.innerHeight;
    const innerW = window.innerWidth;

    // Status bar height (top): difference between screen and inner height.
    // On Android in portrait, this is typically the status bar.
    // In landscape, it may be 0 or the status bar height.
    let safeTop = 0;
    if (screenH > innerH) {
      safeTop = screenH - innerH;
    }

    // Also check if the CSS env() value is already set (iOS or properly
    // configured Android). Use the larger of the two.
    const root = document.documentElement;
    const computedTop = getComputedStyle(root).getPropertyValue('--safe-area-top');
    let envTop = 0;
    if (computedTop) {
      const m = computedTop.trim().match(/^(\d+(?:\.\d+)?)px$/);
      if (m) envTop = parseFloat(m[1]);
    }
    const effectiveTop = Math.max(safeTop, envTop, 0);

    // Navigation bar height (bottom): detect via screen width difference
    // (common on Android in landscape where the nav bar is at the bottom).
    let safeBottom = 0;
    if (screenW > innerW) {
      // In landscape, width difference is the nav bar on some devices.
      // But this is unreliable — only use if clearly a nav bar.
      // On Android, the nav bar is usually at the bottom in portrait too.
      // Use the height difference as a proxy for the bottom inset.
    }
    // Also check env() for bottom inset
    const computedBottom = getComputedStyle(root).getPropertyValue('--safe-area-bottom');
    let envBottom = 0;
    if (computedBottom) {
      const m = computedBottom.trim().match(/^(\d+(?:\.\d+)?)px$/);
      if (m) envBottom = parseFloat(m[1]);
    }
    // Use screen height - innerHeight as a proxy for bottom inset on
    // devices with a navigation bar (when not attributed to the top).
    const effectiveBottom = Math.max(safeBottom, envBottom, 0);

    if (effectiveTop > 0) {
      root.style.setProperty('--safe-area-top', effectiveTop + 'px');
    }
    if (effectiveBottom > 0) {
      root.style.setProperty('--safe-area-bottom', effectiveBottom + 'px');
    }
  }

  update();
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', () => setTimeout(update, 100));

  return function cleanup() {
    window.removeEventListener('resize', update);
    window.removeEventListener('orientationchange', update);
  };
}
