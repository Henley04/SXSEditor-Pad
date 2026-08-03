/**
 * main_window entry — Vue + existing renderer bootstrap.
 *
 * Import order matters: tauri-bridge must run first (sets window.electronAPI
 * used by every renderer module), then the existing renderer index.js
 * (imports CSS, state, event handlers, IPC handlers, theme init), then the
 * Vue shell is mounted on #vue-root.
 *
 * themeBootstrap.js runs as a non-module <script> in the HTML head (copied
 * by the Vite copyWindowAssets plugin) so it applies CSS variables before
 * first paint, avoiding FOUC. It is NOT imported here for that reason.
 */

// Tauri bridge — sets window.electronAPI (legacy name, kept for compat).
import '../tauri-bridge.js';

// Existing renderer bootstrap (CSS imports, state, eventHandlers,
// ipcHandlers, projectManager, timelineRenderer, themeInit, icons, …).
import '../renderer/index.js';

// Mount the Vue application shell on #vue-root.
import { mountVueShell } from '../vue-shell.js';
mountVueShell();
