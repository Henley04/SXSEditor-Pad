/**
 * splash_window entry — Vue + existing splash enrichment.
 *
 * Splash is special: it has no themeBootstrap <script> (no themed UI),
 * no tauri-bridge dependency (splash.js reads window.splashAPI which is
 * injected by the Rust side, not the bridge), and the existing splash.js
 * only enriches an already-painted inline SVG. We still mount the Vue
 * shell for consistency, but it renders nothing visible.
 */
import '../splash.js';

import { mountVueShell } from '../vue-shell.js';
mountVueShell();
