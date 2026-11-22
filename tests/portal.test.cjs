// Logic regression tests: a minimal DOM and mocked HTTP, not a phone/ESP simulator.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/web/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const response = (data, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => data });

function fixture(handler) {
  const nodes = [];
  const interactions = [];
  class Element {
    constructor(tag, root = false) {
      this.tag = tag;
      this.root = root;
      this.children = [];
      this.events = {};
      this.attrs = {};
      this.value = '';
      this.type = '';
      this.disabled = false;
      this._text = '';
      nodes.push(this);
    }
    get connected() { return this.root || Boolean(this.parent?.connected); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(text) { this.replaceChildren(); this._text = text; }
    replaceChildren() {
      for (const child of this.children) child.parent = null;
      this.children = [];
      this._text = '';
    }
    append(...items) {
      for (const item of items) { item.parent = this; this.children.push(item); }
    }
    appendChild(item) { this.append(item); }
    setAttribute(name, value) { this.attrs[name] = value; }
    addEventListener(name, callback) { this.events[name] = callback; }
    focus(options) { interactions.push({ action: 'focus', element: this, options }); }
    scrollIntoView(options) { interactions.push({ action: 'scroll', element: this, options }); }
  }
  const ids = new Map([...html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)]
    .map(([, tag, id]) => [id, new Element(tag, true)]));
  ids.get('password').type = 'password';
  ids.get('connection').textContent = 'Checking device status…';
  ids.get('lock-icon').content = { cloneNode: () => new Element('svg') };
  const calls = [];
  vm.runInNewContext(source, {
    document: {
      getElementById: id => ids.get(id),
      createElement: tag => new Element(tag),
      querySelectorAll: selector => nodes.filter(node => node.connected &&
        (selector === '.network' ? node.className === 'network' : ['button', 'input'].includes(node.tag))),
    },
    AbortController, setTimeout, clearTimeout,
    confirm: () => assert.fail('Unexpected browser dialog'),
    fetch: async (url, options) => { calls.push({ url, ...options }); return handler(url, options); },
  });
  return { get: id => ids.get(id), calls, interactions };
}

for (const encrypted of [true, false]) {
  test(`selection guides to ${encrypted ? 'password' : 'Connect'} without focusing on load or refresh`, async () => {
    const backend = server();
    const app = fixture((url, options) => url === '/prov/scan_result'
      ? response({ aps: [{ ssid: 'New network', encrypted, rssi: -50 }] }) : backend(url, options));
    await tick();
    assert.equal(app.interactions.length, 0);
    app.get('ssid').value = 'Previous network';
    app.get('password').value = 'previous password';
    app.get('networks').children[0].children[0].events.click();
    assert.equal(app.get('ssid').value, 'New network');
    assert.equal(app.get('password').value, '');
    assert.equal(app.interactions.length, 2);
    assert.equal(app.interactions[0].action, 'scroll');
    assert.equal(app.interactions[0].element, app.get('wifi-form'));
    assert.equal(app.interactions[0].options.block, 'start');
    assert.equal(app.interactions[1].action, 'focus');
    assert.equal(app.interactions[1].element, app.get(encrypted ? 'password' : 'connect'));
    assert.equal(app.interactions[1].options.preventScroll, true);
    await app.get('refresh').events.click();
    assert.equal(app.interactions.length, 2);
  });
}

function server({ failScan = false, deletion = 'one' } = {}) {
  let profiles = ['Home & guest', 'Café WiFi'].map(ssid => ({ ssid, enabled: true }));
  return async (url, options) => {
    if (url === '/prov/scan_result') return response(failScan ? { error: 'Scan failed' } : {
      aps: [{ ssid: 'Home & guest', encrypted: true, rssi: -50 }],
    }, !failScan);
    if (url === '/prov/status') return response({ connected: false });
    if (url === '/app/forget') {
      if (deletion === 'fail') return response({ error: 'Write failed' }, false);
      profiles = deletion === 'all' ? [] : profiles.filter(profile => profile.ssid !== options.body);
      return response({ result: 'ok' });
    }
    if (url === '/prov/profiles') return response({ profiles: [...profiles] });
    throw new Error(`Unexpected URL ${url}`);
  };
}

test('scan failure does not hide saved profiles or disable the form', async () => {
  const app = fixture(server({ failScan: true }));
  await tick();
  assert.equal(app.get('saved').children.length, 2);
  assert.match(app.get('scan-status').textContent, /Scan failed/);
  assert.equal(app.get('ssid').disabled, false);
  assert.equal(app.get('connect').disabled, false);
  assert.match(app.get('connection').textContent, /Setup is open/);
});

for (const index of [0, 1]) {
  test(`forget profile ${index}: one request, exact SSID, other profile preserved`, async () => {
    const app = fixture(server());
    await tick();
    const row = app.get('saved').children[index];
    const expected = row.children[0].textContent;
    const button = row.children[1];
    const deletion = button.events.click();
    await button.events.click(); // duplicate click while request is pending
    await deletion;
    const calls = app.calls.filter(call => call.url === '/app/forget');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body, expected);
    assert.equal(app.get('saved').children.length, 1);
    assert.notEqual(app.get('saved').children[0].children[0].textContent, expected);
    assert.match(app.get('saved-status').textContent, /^Forgot /);
    await app.get('refresh').events.click();
    assert.equal(app.get('saved').children.length, 1);
  });
}

test('failed deletion preserves rows and restores controls', async () => {
  const app = fixture(server({ deletion: 'fail' }));
  await tick();
  await app.get('saved').children[0].children[1].events.click();
  assert.equal(app.get('saved').children.length, 2);
  assert.match(app.get('saved-status').textContent, /Could not confirm removal/);
  assert.equal(app.get('connect').disabled, false);
});

test('unexpected loss of another profile is reported, not disguised as success', async () => {
  const app = fixture(server({ deletion: 'all' }));
  await tick();
  await app.get('saved').children[0].children[1].events.click();
  assert.equal(app.get('saved').children.length, 0);
  assert.match(app.get('saved-status').textContent, /Another saved network is also missing/);
});

test('buttons rendered during a slow refresh work; late status cannot overwrite connection success', async () => {
  const status = deferred();
  const backend = server();
  const app = fixture((url, options) => {
    if (url === '/prov/status') return status.promise;
    if (url === '/prov/profiles' && options.method === 'POST') return response({ result: 'ok' });
    return backend(url, options);
  });
  await tick();
  assert.equal(app.get('refresh').disabled, true);
  const network = app.get('networks').children[0].children[0];
  assert.equal(network.disabled, false);
  network.events.click();
  assert.equal(app.get('ssid').value, 'Home & guest');
  app.get('password').value = 'x'; // no client password-length validation
  await app.get('wifi-form').events.submit({ preventDefault() {} });
  status.resolve(response({ connected: false }));
  await tick();
  assert.equal(app.get('connection').textContent, 'Connected · network saved');
  assert.equal(app.get('connect').disabled, true);
  assert.equal(app.get('password').value, '');
});

test('late profile response cannot restore a deleted network', async () => {
  const backend = server();
  let stale;
  const app = fixture((url, options) => {
    if (url === '/prov/profiles' && stale) {
      const pending = stale;
      stale = null;
      return pending.promise;
    }
    return backend(url, options);
  });
  await tick();
  const oldButton = app.get('saved').children[0].children[1];
  const pending = deferred();
  stale = pending;
  const refresh = app.get('refresh').events.click();
  await oldButton.events.click();
  pending.resolve(response({ profiles: [{ ssid: 'Home & guest', enabled: true }] }));
  await refresh;
  assert.equal(app.get('saved').children.length, 1);
  assert.equal(app.get('saved').children[0].children[0].textContent, 'Café WiFi');
});

test('a non-JSON response produces a readable error', async () => {
  const app = fixture(() => ({ ok: false, json: async () => { throw new SyntaxError('HTML response'); } }));
  await tick();
  assert.match(app.get('saved-status').textContent, /Unexpected device response/);
  assert.equal(app.get('connect').disabled, false);
});

test('failed connection preserves input and allows another attempt', async () => {
  const backend = server();
  const app = fixture((url, options) => options.method === 'POST'
    ? response({ result: 'failed', message: 'Connection failed' }, false) : backend(url, options));
  await tick();
  app.get('ssid').value = 'Home';
  app.get('password').value = 'secret';
  await app.get('wifi-form').events.submit({ preventDefault() {} });
  assert.equal(app.get('ssid').value, 'Home');
  assert.equal(app.get('password').value, 'secret');
  assert.equal(app.get('connect').disabled, false);
  assert.match(app.get('message').textContent, /Connection failed/);
});

for (const confirmed of [false, true]) {
  test(`End setup requires confirmation: ${confirmed}`, async () => {
    const backend = server();
    const app = fixture((url, options) => url === '/prov/stop'
      ? response(confirmed ? { result: 'ok' } : {}) : backend(url, options));
    await tick();
    await app.get('finish').events.click();
    assert.equal(app.get('connect').disabled, confirmed);
    assert.match(app.get('message').textContent, confirmed ? /Setup is closing/ : /did not confirm/);
  });
}
