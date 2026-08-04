<!--
  SplashApp.vue — Vue replacement for src/splash.js.

  The inline SVG in splash.html paints immediately on HTML parse (before
  any JS bundle loads), which is the splash's core design (instant popup).
  This component therefore does NOT re-render the SVG — it only enriches
  the existing #splash-version / #splash-build-date text elements in
  onMounted, mirroring the old splash.js enrichment pass.
-->
<template>
  <div style="display:none"></div>
</template>

<script setup>
import { onMounted, ref } from 'vue';

const BUILD_INFO_DEFAULT = {
  productName: 'SXSEditor',
  version: '0.0.0-dev',
  buildDate: '',
  buildDateISO: '',
};

const info = ref({ ...BUILD_INFO_DEFAULT });

onMounted(async () => {
  try {
    if (window.splashAPI && typeof window.splashAPI.getBuildInfo === 'function') {
      info.value = { ...BUILD_INFO_DEFAULT, ...(await window.splashAPI.getBuildInfo()) };
    }
  } catch (_) {
    // Keep defaults — the inline SVG is already visible.
    return;
  }

  const versionEl = document.getElementById('splash-version');
  if (versionEl) {
    versionEl.textContent = info.value.version ? `v${info.value.version}` : '';
  }

  const buildEl = document.getElementById('splash-build-date');
  if (buildEl) {
    buildEl.textContent = info.value.buildDate ? `Build ${info.value.buildDate}` : 'Build dev';
  }
});
</script>
