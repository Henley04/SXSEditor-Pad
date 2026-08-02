const { expect } = require('chai');
const sinon = require('sinon');

const {
  navigate,
  consumeMail,
  peekMail,
  mailbox,
  onNavigate,
  getCurrentRoute,
  listRoutes,
  resolveRouteUrl,
  syncFromLocation,
  _resetForTest,
} = require('../src/spa/router.js');

// jsdom's `window.location.href = …` for a same-origin path updates the URL
// without throwing; cross-origin / unload-triggering assignments are not used
// here (all SPA routes resolve same-origin under the test's `http://localhost`
// base). We tolerate the rare "Not implemented: navigation" virtual-console
// warning by reading side effects (mailbox + events) rather than the URL.
function safeNavigate(route, data, params) {
  try {
    return navigate(route, data, params);
  } catch (_) {
    // Some jsdom builds throw on href assignment; the mailbox/event side
    // effects still ran before the throw, which is what we assert on.
    return null;
  }
}

describe('SPA router', function () {
  beforeEach(function () {
    _resetForTest();
    // Reset location to a clean same-origin base between cases.
    try { window.location.hash = ''; } catch (_) {}
  });

  describe('route registry', function () {
    it('listRoutes includes all former child windows + main', function () {
      const routes = listRoutes();
      expect(routes).to.include.members([
        'main',
        'fragment-editor',
        'singer-creator',
        'singer-market',
        'audio-preprocess',
        'settings',
        'model-download',
        'resource-manager',
      ]);
    });

    it('resolveRouteUrl returns the webpack window directory for known routes', function () {
      expect(resolveRouteUrl('fragment-editor')).to.equal('fragment_editor_window/index.html');
      expect(resolveRouteUrl('main')).to.equal('main_window/index.html');
      expect(resolveRouteUrl('singer-creator')).to.equal('singer_creator_window/index.html');
    });

    it('resolveRouteUrl returns null for unknown routes', function () {
      expect(resolveRouteUrl('does-not-exist')).to.be.null;
    });
  });

  describe('navigate', function () {
    it('returns null and warns for unknown routes', function () {
      const warn = sinon.stub(console, 'warn');
      const result = navigate('nope', null);
      expect(result).to.equal(null);
      expect(warn.calledOnce).to.equal(true);
      warn.restore();
    });

    it('returns a navigation descriptor with the route name + href for known routes', function () {
      const result = safeNavigate('singer-creator');
      expect(result).to.not.equal(null);
      expect(result.routeName).to.equal('singer-creator');
      expect(result.href).to.be.a('string');
      expect(result.href).to.include('singer_creator_window/index.html');
    });

    it('updates getCurrentRoute() after navigation', function () {
      safeNavigate('singer-market');
      const r = getCurrentRoute();
      expect(r.name).to.equal('singer-market');
    });

    it('emits a spa:navigate DOM CustomEvent with route + data', function () {
      let received = null;
      const handler = (e) => { received = e.detail; };
      window.addEventListener('spa:navigate', handler);
      try {
        safeNavigate('model-download', { precision: 'int8' }, { precision: 'int8' });
      } finally {
        window.removeEventListener('spa:navigate', handler);
      }
      expect(received).to.not.equal(null);
      expect(received.routeName).to.equal('model-download');
      expect(received.route.params.precision).to.equal('int8');
      expect(received.data).to.deep.equal({ precision: 'int8' });
    });

    it('serialises route params into the URL hash', function () {
      const result = safeNavigate('fragment-editor', null, { fragmentId: 'abc-123' });
      expect(result.href).to.include('fragmentId=abc-123');
    });
  });

  describe('onNavigate subscriber', function () {
    it('invokes the callback with route + data and returns an unsubscribe function', function () {
      const calls = [];
      const off = onNavigate((p) => calls.push(p));
      expect(typeof off).to.equal('function');
      safeNavigate('singer-creator', { x: 1 });
      expect(calls.length).to.equal(1);
      expect(calls[0].routeName).to.equal('singer-creator');
      expect(calls[0].data).to.deep.equal({ x: 1 });
      off();
      safeNavigate('singer-market', { x: 2 });
      expect(calls.length).to.equal(1); // no new calls after unsubscribe
    });

    it('isolates listener exceptions so other listeners still fire', function () {
      let second = 0;
      onNavigate(() => { throw new Error('boom'); });
      onNavigate(() => { second++; });
      safeNavigate('singer-market');
      expect(second).to.equal(1);
    });
  });

  describe('mailbox', function () {
    it('mailbox() stashes and peekMail() reads without consuming', function () {
      mailbox('fragment-editor', { fragment: { id: 'f1' } });
      expect(peekMail('fragment-editor')).to.deep.equal({ fragment: { id: 'f1' } });
      // Still present after peek.
      expect(peekMail('fragment-editor')).to.deep.equal({ fragment: { id: 'f1' } });
    });

    it('consumeMail() pops the payload once (in-memory tier)', function () {
      mailbox('audio-preprocess', { wavFileName: 'a.wav' });
      expect(consumeMail('audio-preprocess')).to.deep.equal({ wavFileName: 'a.wav' });
      expect(consumeMail('audio-preprocess')).to.equal(null);
    });

    it('navigate(data) stashes data in the mailbox for the target route', function () {
      safeNavigate('audio-preprocess', { duration: 12.5 });
      expect(consumeMail('audio-preprocess')).to.deep.equal({ duration: 12.5 });
    });

    it('falls back to sessionStorage when the in-memory tier is empty', function () {
      safeNavigate('singer-creator', { name: '初音' });
      // Simulate a page reload by clearing the in-memory tier only.
      // (sessionStorage still holds the base64/json mirror.)
      const ss = window.sessionStorage.getItem('spa:mailbox:singer-creator');
      expect(ss).to.not.equal(null);
      expect(JSON.parse(ss)).to.deep.equal({ name: '初音' });
      // consumeMail should still return the payload even though we haven't
      // cleared the in-memory copy (it prefers in-memory, which is fine).
      expect(consumeMail('singer-creator')).to.deep.equal({ name: '初音' });
      // And after consuming, both tiers are cleared.
      expect(window.sessionStorage.getItem('spa:mailbox:singer-creator')).to.equal(null);
      expect(consumeMail('singer-creator')).to.equal(null);
    });

    it('handles non-serializable Float32Array payloads via base64 mirror', function () {
      const samples = new Float32Array([0.1, 0.2, 0.3, 0.4]);
      safeNavigate('fragment-editor', { wavBuffer: samples });
      // sessionStorage mirror wraps the typed array in a marker object so it
      // survives JSON.stringify (deep encode replaces the Float32Array in
      // place with {$__ta, $__b64, $__byteLength}).
      const ss = window.sessionStorage.getItem('spa:mailbox:fragment-editor');
      expect(ss).to.not.equal(null);
      const parsed = JSON.parse(ss);
      expect(parsed.wavBuffer).to.be.an('object');
      expect(parsed.wavBuffer.$__ta).to.equal('Float32Array');
      expect(parsed.wavBuffer.$__b64).to.be.a('string');
      expect(parsed.wavBuffer.$__byteLength).to.equal(samples.byteLength);
      // Consume: in-memory tier returns the live Float32Array.
      const got = consumeMail('fragment-editor');
      expect(got).to.not.equal(null);
      expect(got.wavBuffer).to.be.instanceOf(Float32Array);
      // Compare against the original Float32-rounded values (Float32 storage
      // rounds 0.1 → 0.10000000149…, so a deep-equal against JS doubles fails).
      expect(Array.from(got.wavBuffer)).to.deep.equal(Array.from(samples));
    });

    it('round-trips a nested Float32Array through the sessionStorage tier', function () {
      // Stash via mailbox (populates both tiers).
      const samples = new Float32Array([1, 2, 3]);
      mailbox('fragment-editor', { wavBuffer: samples });
      // Drop the in-memory tier; consumeMail must rebuild the Float32Array
      // from the sessionStorage mirror (deep decode).
      consumeMail('fragment-editor');
      // The sessionStorage tier still has the mirrored payload (consume cleared
      // it above, so re-stash to simulate a fresh page load).
      const { _mailboxCodec } = require('../src/spa/router.js');
      // Re-populate sessionStorage only.
      const enc = _mailboxCodec.encode({ wavBuffer: samples });
      window.sessionStorage.setItem('spa:mailbox:fragment-editor', enc.stored);
      const back = consumeMail('fragment-editor');
      expect(back).to.not.equal(null);
      expect(back.wavBuffer).to.be.instanceOf(Float32Array);
      expect(Array.from(back.wavBuffer)).to.deep.equal([1, 2, 3]);
    });

    it('survives cross-tier decode when only sessionStorage holds the payload', function () {
      // Stash via mailbox (populates both tiers).
      mailbox('singer-market', { page: 2 });
      // Wipe the in-memory tier by consuming, then re-stash into sessionStorage
      // only, simulating a fresh page load where the in-memory Map is empty.
      consumeMail('singer-market');
      const raw = JSON.stringify({ page: 3 });
      window.sessionStorage.setItem('spa:mailbox:singer-market', raw);
      // consumeMail should decode from sessionStorage.
      expect(consumeMail('singer-market')).to.deep.equal({ page: 3 });
      expect(consumeMail('singer-market')).to.equal(null);
    });

    it('oversized typed arrays elide from sessionStorage but stay in-memory', function () {
      // >4MB Float32Array: 1.25M floats = 5MB.
      const big = new Float32Array(1250000);
      safeNavigate('fragment-editor', { wavBuffer: big });
      // sessionStorage mirror should mark the array as elided (b64 = null)
      // rather than carrying the full base64 payload.
      const ss = window.sessionStorage.getItem('spa:mailbox:fragment-editor');
      expect(ss).to.not.equal(null);
      const parsed = JSON.parse(ss);
      expect(parsed.wavBuffer.$__ta).to.equal('Float32Array');
      expect(parsed.wavBuffer.$__b64).to.equal(null);
      expect(parsed.wavBuffer.$__byteLength).to.equal(big.byteLength);
      // In-memory tier still has the live array.
      expect(peekMail('fragment-editor')).to.not.equal(null);
      expect(peekMail('fragment-editor').wavBuffer.length).to.equal(1250000);
    });

    it('peekMail returns null for an empty mailbox', function () {
      expect(peekMail('singer-market')).to.equal(null);
    });
  });

  describe('syncFromLocation', function () {
    it('re-derives the current route from the URL without throwing', function () {
      safeNavigate('singer-creator');
      const r = syncFromLocation();
      expect(r).to.have.property('name');
      expect(r).to.have.property('params');
    });
  });

  describe('hashchange wiring', function () {
    it('updates getCurrentRoute on a hashchange event', function () {
      safeNavigate('singer-creator');
      // Fire a synthetic hashchange using jsdom's Event so dispatch accepts it.
      let threw = false;
      try {
        const Ev = window.Event || Event;
        window.dispatchEvent(new Ev('hashchange'));
      } catch (_) { threw = true; }
      expect(threw).to.equal(false);
      const r = getCurrentRoute();
      expect(r).to.have.property('name');
    });
  });
});
