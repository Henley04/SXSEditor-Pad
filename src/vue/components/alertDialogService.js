/**
 * alertDialogService.js — imperative dialog API backed by the Vue
 * AlertDialog component. Replaces the old alertDialog.js which built
 * DOM via document.createElement.
 *
 * Exports the same showAlertDialog / showConfirmDialog /
 * showProjectInfoImportDialog signatures so existing call sites keep
 * working without changes.
 */
import { createApp, h, ref } from 'vue';
import AlertDialog from './AlertDialog.vue';
import i18nPlugin from '../plugins/i18nPlugin.js';
import { tOr } from '../../i18n/index.js';

function mountDialog(props, onResolve) {
  const host = document.createElement('div');
  document.body.appendChild(host);

  const app = createApp({
    setup() {
      return () => h(AlertDialog, {
        ...props,
        onOk: (val) => { teardown(true, val); },
        onCancel: () => { teardown(false, undefined); },
      });
    },
  });
  app.use(i18nPlugin);

  function teardown(ok, val) {
    app.unmount();
    if (host.parentElement) host.remove();
    onResolve(ok, val);
  }

  app.mount(host);
}

export function showAlertDialog(message, onClose) {
  mountDialog(
    { message, variant: 'alert', okText: tOr('common.confirm', 'OK') },
    (ok) => { if (onClose) onClose(); }
  );
}

export function showConfirmDialog(message) {
  return new Promise((resolve) => {
    mountDialog(
      { message, variant: 'confirm', okText: tOr('common.confirm', 'OK'), cancelText: tOr('common.cancel', 'Cancel') },
      (ok) => resolve(ok)
    );
  });
}

export function showProjectInfoImportDialog(projectInfo, current) {
  const hasBpm = projectInfo.bpm != null;
  const hasTimeSig = projectInfo.timeSignature != null;
  if (!hasBpm && !hasTimeSig) return Promise.resolve(null);
  return new Promise((resolve) => {
    mountDialog(
      {
        message: tOr('main.midiProjectInfoDesc', 'Select which fields to sync from the MIDI file:'),
        title: tOr('main.midiProjectInfoTitle', 'Import Project Info'),
        variant: 'project-info',
        okText: tOr('common.confirm', 'OK'),
        cancelText: tOr('common.cancel', 'Cancel'),
        projectInfo,
        current,
      },
      (ok, val) => resolve(ok ? val : null)
    );
  });
}

export default { showAlertDialog, showConfirmDialog, showProjectInfoImportDialog };
