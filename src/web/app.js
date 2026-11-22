/* Native provisioning API, with /app/forget adapting SSIDs for native deletion. */
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const ssid = byId('ssid');
  const password = byId('password');
  let busy = false;
  let finished = false;
  let refreshing = false;
  let revision = 0;

  function message(text, kind = '') {
    byId('message').textContent = text;
    byId('message').className = `message ${kind}`;
  }

  function updateControls() {
    document.querySelectorAll('button, input').forEach(control => {
      control.disabled = busy || finished;
    });
    byId('refresh').disabled = busy || finished || refreshing;
    byId('wifi-form').setAttribute('aria-busy', String(busy));
  }

  function setBusy(value) {
    busy = value;
    // Ignore reads started before a mutation; they may contain stale profiles/status.
    if (value) revision++;
    updateControls();
  }

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(path, { ...options, signal: controller.signal, cache: 'no-store' });
      let data;
      try {
        data = await response.json();
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        throw new Error('Unexpected device response. Reopen setup and try again.');
      }
      if (!response.ok || data.result === 'failed') {
        throw new Error(data.message || data.error || `Device returned HTTP ${response.status}.`);
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) {
        throw new Error('Device did not respond. Setup may have ended. Check your Wi-Fi connection; hold BOOT for five seconds to reopen setup.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function renderNetworks(networks) {
    const list = byId('networks');
    list.replaceChildren();
    const visible = networks.filter(network => typeof network.ssid === 'string' && network.ssid.length > 0);
    visible.forEach(network => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'network';
      button.setAttribute('aria-pressed', String(ssid.value === network.ssid));
      const name = document.createElement('span');
      name.className = 'network-name';
      // SSIDs are untrusted radio data, never HTML.
      name.textContent = network.ssid;
      const meta = document.createElement('span');
      meta.className = 'network-meta';
      if (network.encrypted) {
        meta.appendChild(byId('lock-icon').content.cloneNode(true));
      } else {
        meta.textContent = 'Open ';
      }
      const bars = document.createElement('span');
      bars.className = 'bars';
      bars.setAttribute('aria-hidden', 'true');
      const strength = network.rssi >= -55 ? 4 : network.rssi >= -65 ? 3 : network.rssi >= -75 ? 2 : 1;
      for (let i = 0; i < 4; i++) {
        const bar = document.createElement('i');
        if (i < strength) bar.className = 'on';
        bars.appendChild(bar);
      }
      button.setAttribute('aria-label', `${network.ssid}, ${network.encrypted ? 'secured' : 'open'}, signal ${network.rssi} dBm`);
      meta.appendChild(bars);
      button.append(name, meta);
      button.addEventListener('click', () => {
        if (busy || finished) return;
        if (ssid.value !== network.ssid) password.value = '';
        ssid.value = network.ssid;
        document.querySelectorAll('.network').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
        message(`Selected ${network.ssid}.`);
        if (!network.encrypted) password.value = '';
        // Stay inside the user's tap so mobile browsers can open the keyboard.
        byId('wifi-form').scrollIntoView({ block: 'start', behavior: 'auto' });
        const next = network.encrypted ? password : byId('connect');
        next.focus({ preventScroll: true });
      });
      item.appendChild(button);
      list.appendChild(item);
    });
    byId('scan-status').textContent = visible.length
      ? `${visible.length} networks available.`
      : 'No networks found yet. Wait a few seconds and refresh, or enter the name above.';
    updateControls();
  }

  function renderProfiles(profiles) {
    const list = byId('saved');
    list.replaceChildren();
    for (const profile of profiles) {
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = profile.ssid + (profile.enabled ? '' : ' (disabled)');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'text-button';
      remove.textContent = 'Forget';
      remove.setAttribute('aria-label', `Forget ${profile.ssid}`);
      remove.addEventListener('click', async () => {
        if (busy || finished || remove.disabled) return;
        setBusy(true);
        remove.textContent = 'Forgetting…';
        byId('saved-status').textContent = `Removing ${profile.ssid}…`;
        let deleted = false;
        try {
          const result = await request('/app/forget', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            body: profile.ssid,
          });
          if (result.result !== 'ok') throw new Error('The device did not confirm removal.');
          deleted = true;
          const remaining = await request('/prov/profiles');
          renderProfiles(remaining.profiles);
          if (remaining.profiles.some(saved => saved.ssid === profile.ssid)) {
            throw new Error('The network is still saved on the device.');
          }
          if (profiles.some(saved => saved.ssid !== profile.ssid &&
              !remaining.profiles.some(other => other.ssid === saved.ssid))) {
            throw new Error('Another saved network is also missing. Check the device log.');
          }
          if (ssid.value === profile.ssid) {
            ssid.value = '';
            password.value = '';
            document.querySelectorAll('.network').forEach(button => button.setAttribute('aria-pressed', 'false'));
          }
          byId('saved-status').textContent = `Forgot ${profile.ssid}. It may still appear under Nearby networks because it is still broadcasting.`;
        } catch (error) {
          byId('saved-status').textContent = deleted
            ? `Removal was accepted, but verification failed. ${error.message}`
            : `Could not confirm removal of ${profile.ssid}. ${error.message} Refresh to check saved networks.`;
        } finally {
          remove.textContent = 'Forget';
          setBusy(false);
        }
      });
      item.append(name, remove);
      list.appendChild(item);
    }
    if (!profiles.length) list.textContent = 'No saved networks.';
    updateControls();
  }

  async function refresh() {
    if (busy || finished || refreshing) return;
    refreshing = true;
    updateControls();
    const version = revision;
    byId('scan-status').textContent = 'Loading networks…';
    byId('saved-status').textContent = 'Loading saved networks…';
    const sections = [
      ['/prov/scan_result', 'scan-status', data => renderNetworks(data.aps)],
      ['/prov/profiles', 'saved-status', data => {
        renderProfiles(data.profiles);
        byId('saved-status').textContent = '';
      }],
      ['/prov/status', 'connection', status => {
        byId('connection').textContent = status.connected
          ? `Connected to ${status.ssid}${status.ip ? ` · ${status.ip}` : ''}`
          : 'Setup is open · waiting for a network';
      }],
    ];
    try {
      await Promise.all(sections.map(async ([path, statusId, render]) => {
        try {
          const data = await request(path);
          if (version === revision && !finished) render(data);
        } catch (error) {
          if (version === revision && !finished) {
            byId(statusId).textContent = `Could not refresh. ${error.message}`;
          }
        }
      }));
    } finally {
      refreshing = false;
      if (version !== revision) {
        // An action superseded these reads; don't leave a loading message behind.
        for (const id of ['scan-status', 'saved-status']) {
          if (byId(id).textContent.startsWith('Loading')) byId(id).textContent = 'Refresh to update.';
        }
        if (byId('connection').textContent === 'Checking device status…') {
          byId('connection').textContent = 'Refresh to check connection status.';
        }
      }
      updateControls();
    }
  }

  ssid.addEventListener('input', () => {
    document.querySelectorAll('.network').forEach(button => button.setAttribute('aria-pressed', 'false'));
  });
  byId('show-password').addEventListener('click', () => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    byId('show-password').setAttribute('aria-pressed', String(show));
    byId('show-password').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
  byId('wifi-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || finished) return;
    setBusy(true);
    byId('connect').textContent = 'Connecting…';
    message('Testing the connection and saving your network. This can take about 15 seconds.');
    try {
      const result = await request('/prov/profiles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ssid: ssid.value, password: password.value }),
      });
      if (result.result !== 'ok') throw new Error('Connection was not confirmed. Please try again.');
      finished = true;
      password.value = '';
      byId('connection').textContent = 'Connected · network saved';
      message('Connected and saved. Setup is closing; you can return to your usual Wi-Fi.', 'success');
      byId('connect').textContent = 'Connected';
    } catch (error) {
      message(error.message, 'error');
      byId('connect').textContent = 'Try again';
    } finally { setBusy(false); }
  });
  byId('finish').addEventListener('click', async () => {
    if (busy || finished) return;
    setBusy(true);
    try {
      const result = await request('/prov/stop', { method: 'POST' });
      if (result.result !== 'ok') throw new Error('The device did not confirm ending setup.');
      finished = true;
      message('Setup is closing. The device will use a saved network if one is available.', 'success');
    } catch (error) { message(error.message, 'error'); }
    finally { setBusy(false); }
  });
  byId('refresh').addEventListener('click', refresh);
  refresh();
})();
