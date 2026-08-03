<!--
  App.vue — Vue application shell.

  This is intentionally minimal: it provides a mounted Vue instance so
  individual windows can incrementally migrate vanilla-JS UI fragments
  into Vue components (imported here or in a per-window App.vue override)
  without rewriting the existing renderer in one shot.

  The existing window UIs (toolbar, canvas, inspector, …) continue to live
  in the static HTML of each window and are wired up by the side-effect
  imports each entry runs (see src/entries/*.js → src/vue-shell.js).
-->
<template>
  <div class="vue-shell-root" aria-hidden="true"></div>
</template>

<script setup>
// No reactive state yet. Future Vue components register themselves here
// (e.g. <SettingsPanel /> once settings.js is incrementally migrated).
</script>
