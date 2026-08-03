/**
 * resource_manager_window entry — Vue + existing resource manager bootstrap.
 */
import '../tauri-bridge.js';
import '../resourceManager.js';

import { mountVueShell } from '../vue-shell.js';
mountVueShell();
