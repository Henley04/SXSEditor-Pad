/**
 * Vue i18n plugin — exposes the existing src/i18n t()/tOr() functions
 * to Vue components via $t / $tOr and a v-i18n directive.
 *
 * Translations themselves still live in src/i18n/zh-CN.js + en.js.
 * Locale is reactive: setLocale() dispatches a 'localeChanged' CustomEvent;
 * this plugin listens and triggers a re-render of v-i18n bindings.
 */
import { t, tOr, setLocale, getLocale, initI18n, applyLocale } from '../../i18n/index.js';
import { ref } from 'vue';

const localeRef = ref(getLocale());

function install(app) {
  app.config.globalProperties.$t = t;
  app.config.globalProperties.$tOr = tOr;
  app.config.globalProperties.$locale = localeRef;

  app.directive('i18n', {
    mounted(el, binding) {
      applyI18nAttr(el, binding);
    },
    updated(el, binding) {
      applyI18nAttr(el, binding);
    },
  });

  // Keep localeRef in sync so v-i18n re-evaluates on locale change.
  document.addEventListener('localeChanged', () => {
    localeRef.value = getLocale();
  });
}

function applyI18nAttr(el, binding) {
  // Touch localeRef so Vue re-runs this when locale changes.
  void localeRef.value;
  const key = typeof binding.value === 'string' ? binding.value : binding.arg;
  if (key) {
    el.textContent = t(key);
  }
}

export { t, tOr, setLocale, getLocale, initI18n, applyLocale, install as default };
