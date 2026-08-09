/**
 * safeArea.js — shared safe-area detection for all window entry points.
 *
 * On Android Tauri, env(safe-area-inset-top) often returns 0 because the
 * Android window plugin doesn't set up status bar insets. The app also
 * runs in fullscreen (edge-to-edge) mode where screen.height === innerHeight,
 * so the JS heuristic of comparing screen vs. inner height also returns 0.
 *
 * To work around this, on mobile devices we apply a hardcoded minimum
 * status bar height (28px — standard Android status bar in landscape/portrait)
 * when both env() and screen-dimension detection fail.
 *
 * IMPORTANT — set values on `document.body`, NOT `document.documentElement`:
 * The theme system (`themes/themeInit.js → injectTokens`) wipes every
 * `--*` inline custom property on `<html>` and re-applies theme tokens
 * whenever the theme loads or changes. If we set `--safe-area-top` on
 * `<html>`, it gets nuked the moment the theme bootstrap IPC round-trip
 * resolves (race with `onMounted`). Setting on `<body>` keeps the safe-area
 * insets immune to that wiping pass. Body's own value still wins in the
 * cascade for `body { padding-top: var(--safe-area-top) }`, and descendants
 * inherit it from body instead of html, so the toolbar / sidebar / layout
 * containers in every window continue to read the correct value.
 *
 * We also re-apply on the `theme:changed` event so subsequent theme
 * switches (which re-run injectTokens) keep the safe-area insets intact.
 *
 * Usage:
 *   import { applySafeAreaInsets } from '../utils/safeArea.js';
 *   const cleanup = applySafeAreaInsets();
 *   // ... later: cleanup();
 */

// Hardcoded minimum for mobile when auto-detection fails.
// Android status bar: typically 24-32dp in portrait, 0-24dp in landscape.
// 28px covers the majority of devices. iOS notch: 44-59px.
const MOBILE_MIN_SAFE_TOP = 28;
const MOBILE_MIN_SAFE_BOTTOM = 0; // nav bar is usually handled by OS or CSS env()

function isMobileDevice() {
  const ua = navigator.userAgent || '';
  return /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(ua);
}

export function applySafeAreaInsets() {
  function update() {
    // Read the env() / default fallback from <html> (where pad.css declares
    // --safe-area-top: env(safe-area-inset-top, 0px) on :root). We only READ
    // from html — writes go to <body> to survive theme token re-injection.
    const root = document.documentElement;
    const screenH = window.screen ? window.screen.height : 0;
    const innerH = window.innerHeight;
    const screenW = window.screen ? window.screen.width : 0;
    const innerW = window.innerWidth;

    // Method 1: Check CSS env() value (iOS or properly configured Android)
    const computedTop = getComputedStyle(root).getPropertyValue('--safe-area-top');
    let envTop = 0;
    if (computedTop) {
      const m = computedTop.trim().match(/^(\d+(?:\.\d+)?)px$/);
      if (m) envTop = parseFloat(m[1]);
    }

    // Method 2: Compare screen vs. inner height (works when not fullscreen)
    let screenTop = 0;
    if (screenH > innerH) {
      screenTop = screenH - innerH;
    }

    // Method 3: Mobile fallback — if both methods return 0 but we're on a
    // mobile device, the status bar is likely overlaying content in
    // fullscreen/edge-to-edge mode. Use a hardcoded minimum.
    let mobileTop = 0;
    if (isMobileDevice() && envTop === 0 && screenTop === 0) {
      mobileTop = MOBILE_MIN_SAFE_TOP;
    }

    const effectiveTop = Math.max(envTop, screenTop, mobileTop, 0);

    // Bottom inset
    const computedBottom = getComputedStyle(root).getPropertyValue('--safe-area-bottom');
    let envBottom = 0;
    if (computedBottom) {
      const m = computedBottom.trim().match(/^(\d+(?:\.\d+)?)px$/);
      if (m) envBottom = parseFloat(m[1]);
    }
    let screenBottom = 0;
    // In landscape, screenW - innerW might indicate nav bar on side
    // In portrait, screenH - innerH might indicate nav bar at bottom
    // This is unreliable, so only use env() or mobile minimum
    let mobileBottom = 0;
    if (isMobileDevice() && envBottom === 0) {
      // Only apply bottom inset if there's clearly a nav bar
      // (screenH > innerH in portrait, or screenW > innerW in landscape)
      if (screenH > innerH || screenW > innerW) {
        mobileBottom = MOBILE_MIN_SAFE_BOTTOM;
      }
    }
    const effectiveBottom = Math.max(envBottom, screenBottom, mobileBottom, 0);

    // Write to <body>, not <html>. themes/themeInit.js's injectTokens() wipes
    // every `--*` inline property on <html> when the theme loads / changes,
    // which previously clobbered the safe-area inset set here. Body survives
    // that pass and its own value still wins in the CSS cascade for
    // `body { padding-top: var(--safe-area-top) }`, with descendants
    // inheriting from body.
    const target = document.body || root;
    if (effectiveTop > 0) {
      target.style.setProperty('--safe-area-top', effectiveTop + 'px');
    }
    if (effectiveBottom > 0) {
      target.style.setProperty('--safe-area-bottom', effectiveBottom + 'px');
    }
  }

  update();

  function onThemeChanged() {
    // The theme system wipes <html>'s --* properties; it doesn't touch <body>
    // — but re-apply defensively in case a future theme pipeline changes that.
    // Also: if the theme tokens happen to include --safe-area-* (they
    // shouldn't, but just in case), re-asserting after the change keeps the
    // status-bar gap intact.
    update();
  }

  // Re-run on resize and orientation change (with delay for UI to settle)
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', () => setTimeout(update, 200));
  // Re-apply after theme:changed so subsequent theme switches don't
  // regress the safe-area inset (the theme system fires this event after
  // wiping <html>'s --* and re-injecting theme tokens).
  window.addEventListener('theme:changed', onThemeChanged);

  return function cleanup() {
    window.removeEventListener('resize', update);
    window.removeEventListener('orientationchange', update);
    window.removeEventListener('theme:changed', onThemeChanged);
  };
}
