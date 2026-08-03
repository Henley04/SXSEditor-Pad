/**
 * fragment_editor_window entry — Vue + existing fragment editor bootstrap.
 *
 * See src/entries/main.js for the import-order rationale.
 */
import '../tauri-bridge.js';
import '../fragmentEditor/index.js';

import { mountVueShell } from '../vue-shell.js';
mountVueShell();
