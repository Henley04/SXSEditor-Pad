/**
 * Shared theme initialization for all renderer windows.
 *
 * Usage:
 *   import { initWindowTheme } from '../themes/themeInit.js';
 *   initWindowTheme(ipcCleanupsArray);
 */

// Cache theme tokens in localStorage so that when a new window/SPA page
// loads, the theme can be applied immediately from cache before the IPC
// bootstrap round-trip completes. This prevents a flash of the default
// theme (from themeBootstrap.js) when navigating between windows.
const THEME_CACHE_KEY = 'sxseditor.themeCache';

function saveThemeToCache(themeObj) {
    try {
        if (themeObj && themeObj.tokens) {
            localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({
                themeId: themeObj.id || themeObj.themeId || null,
                tokens: themeObj.tokens,
            }));
        }
    } catch (_) { /* non-fatal */ }
}

function loadThemeFromCache() {
    try {
        const raw = localStorage.getItem(THEME_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.tokens) return parsed;
    } catch (_) { /* non-fatal */ }
    return null;
}

function injectTokens(tokens) {
    if (!tokens || typeof document === 'undefined') return;
    const root = document.documentElement;
    // Clear previous inline CSS variables to avoid stale tokens
    const toRemove = [];
    for (let i = 0; i < root.style.length; i++) {
        if (root.style[i].startsWith('--')) toRemove.push(root.style[i]);
    }
    for (const prop of toRemove) root.style.removeProperty(prop);
    // Apply new theme tokens
    for (const [k, v] of Object.entries(tokens)) {
        try { root.style.setProperty(k, v); } catch (_) {}
    }
    // Notify canvas renderers to invalidate cached colors and re-render
    try { window.dispatchEvent(new CustomEvent('theme:changed')); } catch (_) {}
}

/**
 * Initialize theme for the current renderer window.
 *
 * 1. Applies cached theme from localStorage immediately (no FOUC)
 * 2. Fetches the current theme via themeAPI.bootstrap() (includes tokens)
 * 3. Applies its tokens to :root and updates the cache
 * 4. Listens for theme:changed IPC and re-applies
 *
 * @param {Array} [ipcCleanups] - Optional array to push cleanup fns into
 */
export async function initWindowTheme(ipcCleanups) {
    const api = window.electronAPI;

    // Try cache first for instant theme application (prevents FOUC when
    // navigating between SPA pages — the inline :root tokens are lost on
    // page navigation, so without cache the fallback theme shows until IPC
    // resolves, causing a visible flash or permanent theme reset if IPC fails).
    const cached = loadThemeFromCache();
    if (cached) {
        injectTokens(cached.tokens);
    }

    if (!api?.themeAPI) {
        // No Tauri theme API available — cache fallback already applied
        return;
    }

    async function applyTheme(themeId) {
        if (!themeId) return;
        try {
            const themeObj = await api.themeAPI.get(themeId);
            if (themeObj && themeObj.tokens) {
                injectTokens(themeObj.tokens);
                saveThemeToCache({ id: themeId, tokens: themeObj.tokens });
            }
        } catch (_) {}
    }

    try {
        const bootstrap = await api.themeAPI.bootstrap();
        if (bootstrap) {
            // Use theme from bootstrap response (avoids second IPC call)
            if (bootstrap.currentTheme && bootstrap.currentTheme.tokens) {
                injectTokens(bootstrap.currentTheme.tokens);
                saveThemeToCache(bootstrap.currentTheme);
            } else if (bootstrap.themeId) {
                await applyTheme(bootstrap.themeId);
            }
        }
    } catch (_) {
        // IPC failed — cache fallback already applied above
    }

    if (api.themeAPI.onChanged) {
        const cleanup = api.themeAPI.onChanged(async (data) => {
            if (data && data.themeId) {
                await applyTheme(data.themeId);
            }
        });
        if (cleanup && ipcCleanups) ipcCleanups.push(cleanup);
    }
}
