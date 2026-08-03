/**
 * Vue i18n plugin — exposes the existing src/i18n t()/tOr() functions
 * to Vue components via $t / $tOr global properties.
 *
 * Translations themselves still live in src/i18n/zh-CN.js + en.js.
 * Components use {{ $t('key') }} / {{ $tOr('key', 'fallback') }} in
 * templates, or import t/tOr directly in <script setup>.
 *
 * Note: the canvas windows (renderer, fragmentEditor, audioPreprocess)
 * use data-i18n attributes hydrated by the vanilla i18n applyLocale()
 * pass, NOT this plugin — they keep working via dynamic import.
 */
import { t, tOr, setLocale, getLocale, initI18n, applyLocale } from '../../i18n/index.js';

function install(app) {
  app.config.globalProperties.$t = t;
  app.config.globalProperties.$tOr = tOr;
}

export { t, tOr, setLocale, getLocale, initI18n, applyLocale, install as default };
