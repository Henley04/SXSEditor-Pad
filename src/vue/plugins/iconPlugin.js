/**
 * Vue icon plugin — registers an <Icon> component and a v-icon directive
 * backed by src/icons/iconHelper.js + iconRegistry.js.
 *
 * Usage in templates:
 *   <Icon name="play" :size="16" />
 *   <button v-icon="'play'">Play</button>
 */
import { h } from 'vue';
import { getIconMarkup } from '../../icons/iconRegistry.js';
import { createIcon, hydrateIcons } from '../../icons/iconHelper.js';

const Icon = {
  name: 'Icon',
  props: {
    name: { type: String, required: true },
    size: { type: Number, default: 16 },
    className: { type: String, default: '' },
    label: { type: String, default: '' },
  },
  setup(props) {
    return () => {
      const markup = getIconMarkup(props.name);
      if (markup == null) return null;
      const cls = `icon icon-${props.name}${props.className ? ' ' + props.className : ''}`;
      // Render via innerHTML to embed the registry path data.
      return h('svg', {
        class: cls,
        width: props.size,
        height: props.size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.75,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': props.label ? undefined : 'true',
        role: props.label ? 'img' : undefined,
        'aria-label': props.label || undefined,
        innerHTML: markup,
      });
    };
  },
};

function install(app) {
  app.component('Icon', Icon);
  app.directive('icon', {
    mounted(el, binding) {
      const name = binding.value || binding.arg;
      if (name) setIconOn(el, name, binding.modifiers);
    },
    updated(el, binding) {
      const name = binding.value || binding.arg;
      if (name) setIconOn(el, name, binding.modifiers);
    },
  });
  app.config.globalProperties.$hydrateIcons = hydrateIcons;
}

function setIconOn(el, name, modifiers) {
  const opts = {};
  if (modifiers.size) opts.size = modifiers.size;
  const icon = createIcon(name, opts);
  if (!icon) return;
  const existing = el.querySelector(':scope > svg.icon');
  if (existing) existing.remove();
  el.prepend(icon);
}

export { Icon, hydrateIcons, createIcon };
export default install;
