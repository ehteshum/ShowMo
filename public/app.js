(() => {
  'use strict';

  const PLAYLIST_URL = 'https://himelop.short.gy/playlist.m3u';
  const STORAGE_KEYS = {
    refreshInterval: 'm3u_refresh_interval',
    useProxy: 'm3u_use_proxy',
    lastChannelUrl: 'm3u_last_channel_url',
  };

  const els = {
    video: document.getElementById('video'),
    playerOverlay: document.getElementById('playerOverlay'),
    overlayMessage: document.getElementById('overlayMessage'),
    activeLogo: document.getElementById('activeLogo'),
    activeTitle: document.getElementById('activeTitle'),
    activeGroup: document.getElementById('activeGroup'),
    activeFormat: document.getElementById('activeFormat'),
    activeDrm: document.getElementById('activeDrm'),
    proxyToggle: document.getElementById('proxyToggle'),
    retryBtn: document.getElementById('retryBtn'),
    channelList: document.getElementById('channelList'),
    channelCount: document.getElementById('channelCount'),
    searchInput: document.getElementById('searchInput'),
    groupFilter: document.getElementById('groupFilter'),
    playlistMeta: document.getElementById('playlistMeta'),
    refreshStatus: document.getElementById('refreshStatus'),
    refreshInterval: document.getElementById('refreshInterval'),
    refreshBtn: document.getElementById('refreshBtn'),
    syncDot: document.getElementById('syncDot'),
  };

  const state = {
    channels: [],
    rawPlaylist: '',
    playlistUpdatedText: '',
    lastSyncedAt: null,
    activeChannel: null,
    refreshSeconds: loadNumber(STORAGE_KEYS.refreshInterval, 60),
    countdown: 60,
    useProxy: loadBool(STORAGE_KEYS.useProxy, true),
    isFetching: false,
    hls: null,
    shaka: null,
  };

  function loadNumber(key, fallback) {
    const val = Number(localStorage.getItem(key));
    return Number.isFinite(val) && val >= 0 ? val : fallback;
  }

  function loadBool(key, fallback) {
    const val = localStorage.getItem(key);
    return val === null ? fallback : val === 'true';
  }

  function encodeHeadersParam(headers) {
    if (!headers || Object.keys(headers).length === 0) return '';
    const bytes = new TextEncoder().encode(JSON.stringify(headers));
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function buildStreamUrl(targetUrl, headers) {
    if (!state.useProxy) return targetUrl;
    if (targetUrl.startsWith(`${location.origin}/api/proxy`)) return targetUrl;
    const params = new URLSearchParams({ url: targetUrl });
    const encoded = encodeHeadersParam(headers);
    if (encoded) params.set('h', encoded);
    return `/api/proxy?${params.toString()}`;
  }

  function unwrapProxyUrl(maybeProxyUrl) {
    try {
      const parsed = new URL(maybeProxyUrl, location.origin);
      if (parsed.pathname === '/api/proxy') {
        return parsed.searchParams.get('url') || maybeProxyUrl;
      }
    } catch {
      // Ignore invalid URL
    }
    return maybeProxyUrl;
  }

  function parseExtInfAttributes(attrText) {
    const attrs = {};
    const regex = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
    let match;
    while ((match = regex.exec(attrText)) !== null) {
      attrs[match[1].toLowerCase()] = match[2];
    }
    return attrs;
  }

  function parseClearKey(rawValue) {
    const clearKeys = {};
    const trimmed = rawValue.trim();
    if (!trimmed) return clearKeys;

    if (trimmed.startsWith('{')) {
      try {
        const data = JSON.parse(trimmed);
        if (Array.isArray(data.keys)) {
          for (const item of data.keys) {
            if (item.kid && item.k) {
              clearKeys[base64UrlToHex(item.kid)] = base64UrlToHex(item.k);
            }
          }
        }
        return clearKeys;
      } catch {
        return clearKeys;
      }
    }

    for (const pair of trimmed.split(',')) {
      const [kid, key] = pair.split(':').map((s) => s.trim());
      if (kid && key) {
        clearKeys[kid.toLowerCase()] = key.toLowerCase();
      }
    }
    return clearKeys;
  }

  function base64UrlToHex(input) {
    const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const bin = atob(padded);
    return Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  }

  function parseM3U(content) {
    const lines = content.split(/\r?\n/);
    const channels = [];
    let updatedText = '';
    let pending = createEmptyMeta();

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith('#Last Update')) {
        updatedText = line.replace(/^#Last Update\s*:\s*/i, '').trim();
        continue;
      }

      if (line.startsWith('#CHNO:')) {
        pending.chno = line.slice(6).trim();
        continue;
      }

      if (line.startsWith('#EXTINF:')) {
        const body = line.slice(8);
        const commaIndex = findExtInfTitleComma(body);
        const attrPart = commaIndex >= 0 ? body.slice(0, commaIndex) : body;
        const titlePart = commaIndex >= 0 ? body.slice(commaIndex + 1).trim() : '';
        const attrs = parseExtInfAttributes(attrPart);

        pending.name = titlePart || attrs['tvg-name'] || 'Untitled Channel';
        pending.logo = attrs['tvg-logo'] || '';
        pending.group = attrs['group-title'] || 'General';
        continue;
      }

      if (line.startsWith('#KODIPROP:')) {
        const prop = line.slice(10);
        const eqIdx = prop.indexOf('=');
        if (eqIdx > 0) {
          const key = prop.slice(0, eqIdx).trim();
          const val = prop.slice(eqIdx + 1).trim();
          if (key === 'inputstream.adaptive.manifest_type') {
            pending.manifestType = val.toLowerCase();
          } else if (key === 'inputstream.adaptive.license_type') {
            pending.licenseType = val.toLowerCase();
          } else if (key === 'inputstream.adaptive.license_key') {
            Object.assign(pending.clearKeys, parseClearKey(val));
          }
        }
        continue;
      }

      if (line.startsWith('#EXTHTTP:')) {
        try {
          const parsed = JSON.parse(line.slice(9));
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'string') pending.headers[k] = v;
          }
        } catch {
          // Ignore malformed #EXTHTTP
        }
        continue;
      }

      if (line.startsWith('#EXTVLCOPT:')) {
        const opt = line.slice(11);
        const eqIdx = opt.indexOf('=');
        if (eqIdx > 0) {
          const k = opt.slice(0, eqIdx).trim().toLowerCase();
          const v = opt.slice(eqIdx + 1).trim();
          if (k === 'http-user-agent') pending.headers['User-Agent'] = v;
          if (k === 'http-referrer') pending.headers['Referer'] = v;
          if (k === 'http-origin') pending.headers['Origin'] = v;
        }
        continue;
      }

      if (line.startsWith('#')) {
        continue;
      }

      if (/^https?:\/\//i.test(line)) {
        const pipeIdx = line.indexOf('|');
        const cleanUrl = pipeIdx >= 0 ? line.slice(0, pipeIdx).trim() : line;
        if (pipeIdx >= 0) {
          const rawParams = line.slice(pipeIdx + 1).trim();
          for (const pair of rawParams.split('&')) {
            const eqIdx = pair.indexOf('=');
            if (eqIdx > 0) {
              const hk = decodeURIComponent(pair.slice(0, eqIdx).trim());
              const hv = decodeURIComponent(pair.slice(eqIdx + 1).trim());
              if (hk && hv) pending.headers[hk] = hv;
            }
          }
        }

        const isMpd = pending.manifestType === 'mpd' || /\.mpd(\?|$)/i.test(cleanUrl);
        const format = isMpd ? 'DASH' : /\.m3u8(\?|$)/i.test(cleanUrl) ? 'HLS' : 'STREAM';
        channels.push({
          id: `${channels.length + 1}`,
          chno: pending.chno || String(channels.length + 1),
          name: pending.name || `Channel ${channels.length + 1}`,
          logo: pending.logo,
          group: pending.group || 'General',
          url: cleanUrl,
          format,
          clearKeys: Object.keys(pending.clearKeys).length ? pending.clearKeys : null,
          headers: pending.headers,
        });
        pending = createEmptyMeta();
      }
    }

    return { channels, updatedText };
  }

  function createEmptyMeta() {
    return {
      chno: '',
      name: '',
      logo: '',
      group: 'General',
      manifestType: '',
      licenseType: '',
      clearKeys: {},
      headers: {},
    };
  }

  function findExtInfTitleComma(body) {
    let inQuotes = false;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === ',' && !inQuotes) return i;
    }
    return -1;
  }

  function setOverlay(message, showRetry = false) {
    if (!message) {
      els.playerOverlay.classList.add('hidden');
      els.retryBtn.classList.add('hidden');
      return;
    }
    els.overlayMessage.textContent = message;
    els.playerOverlay.classList.remove('hidden');
    els.retryBtn.classList.toggle('hidden', !showRetry);
  }

  async function teardownPlayers() {
    if (state.hls) {
      state.hls.destroy();
      state.hls = null;
    }
    if (state.shaka) {
      await state.shaka.destroy();
      state.shaka = null;
    }
    els.video.removeAttribute('src');
    els.video.load();
  }

  function createProxiedHlsLoader(headers) {
    const BaseLoader = window.Hls.DefaultConfig.loader;
    return class ProxiedLoader extends BaseLoader {
      load(context, config, callbacks) {
        const originalUrl = context.url;
        context.url = buildStreamUrl(originalUrl, headers);

        const wrappedCallbacks = {
          ...callbacks,
          onSuccess: (response, stats, ctx, networkDetails) => {
            response.url = originalUrl;
            ctx.url = originalUrl;
            callbacks.onSuccess(response, stats, ctx, networkDetails);
          },
        };

        super.load(context, config, wrappedCallbacks);
      }
    };
  }

  async function playChannel(channel) {
    if (!channel) return;
    state.activeChannel = channel;
    localStorage.setItem(STORAGE_KEYS.lastChannelUrl, channel.url);
    updateNowPlayingUI(channel);
    highlightActiveChannel();

    setOverlay(`Loading ${channel.name}…`);
    await teardownPlayers();

    try {
      if (channel.format === 'DASH' || channel.clearKeys) {
        await playWithShaka(channel);
      } else {
        await playWithHlsOrNative(channel);
      }
      setOverlay('');
      els.video.play().catch(() => {
        // Autoplay with sound may be blocked by browser policy; controls are visible
      });
    } catch (err) {
      setOverlay(`Playback failed: ${err.message || 'Unable to load stream'}`, true);
    }
  }

  async function playWithShaka(channel) {
    if (!window.shaka) {
      throw new Error('Shaka Player library failed to load');
    }
    window.shaka.polyfill.installAll();
    if (!window.shaka.Player.isBrowserSupported()) {
      throw new Error('Browser does not support DASH playback');
    }

    const player = new window.shaka.Player();
    await player.attach(els.video);
    state.shaka = player;

    player.addEventListener('error', (event) => {
      const detail = event.detail;
      setOverlay(`Stream error (${detail?.code || 'unknown'})`, true);
    });

    player.configure({
      manifest: {
        defaultPresentationDelay: 10,
        dash: {
          ignoreMinBufferTime: true,
          ignoreSuggestedPresentationDelay: true,
        },
      },
      streaming: {
        rebufferingGoal: 2,
        bufferingGoal: 12,
        bufferBehind: 30,
        jumpLargeGaps: true,
        ignoreTextStreamFailures: true,
      },
      ...(channel.clearKeys ? { drm: { clearKeys: channel.clearKeys } } : {}),
    });

    const networking = player.getNetworkingEngine();
    networking.registerRequestFilter((_type, request) => {
      request.uris = request.uris.map((uri) =>
        /^https?:\/\//i.test(uri) ? buildStreamUrl(uri, channel.headers) : uri
      );
    });
    networking.registerResponseFilter((_type, response) => {
      response.uri = unwrapProxyUrl(response.uri);
    });

    await player.load(channel.url);
  }

  function playWithHlsOrNative(channel) {
    return new Promise((resolve, reject) => {
      if (window.Hls && window.Hls.isSupported() && (channel.format === 'HLS' || !els.video.canPlayType('application/vnd.apple.mpegurl'))) {
        const hls = new window.Hls({
          enableWorker: true,
          lowLatencyMode: true,
          loader: state.useProxy ? createProxiedHlsLoader(channel.headers) : window.Hls.DefaultConfig.loader,
        });
        state.hls = hls;

        let settled = false;
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });

        hls.on(window.Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR && !settled) {
              settled = true;
              reject(new Error('Stream unreachable or blocked'));
            } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
              hls.recoverMediaError();
            } else {
              setOverlay(`Stream error (${data.details || 'fatal'})`, true);
            }
          }
        });

        hls.loadSource(channel.url);
        hls.attachMedia(els.video);
        return;
      }

      els.video.src = buildStreamUrl(channel.url, channel.headers);
      els.video.onloadedmetadata = () => resolve();
      els.video.onerror = () => reject(new Error('Stream could not be played'));
    });
  }

  function updateNowPlayingUI(channel) {
    els.activeTitle.textContent = channel.name;
    els.activeGroup.textContent = `${channel.group} • Channel #${channel.chno}`;
    els.activeFormat.textContent = channel.format;
    els.activeFormat.classList.remove('hidden');
    els.activeDrm.classList.toggle('hidden', !channel.clearKeys);

    if (channel.logo) {
      els.activeLogo.src = channel.logo;
      els.activeLogo.classList.remove('hidden');
      els.activeLogo.onerror = () => els.activeLogo.classList.add('hidden');
    } else {
      els.activeLogo.classList.add('hidden');
    }
  }

  function highlightActiveChannel() {
    const activeUrl = state.activeChannel?.url;
    for (const item of els.channelList.querySelectorAll('.channel-item')) {
      const isMatch = item.dataset.url === activeUrl;
      item.classList.toggle('active', isMatch);
      item.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    }
  }

  function populateGroupFilter(channels) {
    const prev = els.groupFilter.value;
    const groups = [...new Set(channels.map((c) => c.group))];
    els.groupFilter.innerHTML = '<option value="">All groups</option>';

    for (const group of groups) {
      const opt = document.createElement('option');
      opt.value = group;
      opt.textContent = group;
      els.groupFilter.appendChild(opt);
    }

    if (groups.includes(prev)) {
      els.groupFilter.value = prev;
    }
  }

  function renderChannelList() {
    const query = els.searchInput.value.trim().toLowerCase();
    const selectedGroup = els.groupFilter.value;

    const filtered = state.channels.filter((ch) => {
      if (selectedGroup && ch.group !== selectedGroup) return false;
      if (query && !ch.name.toLowerCase().includes(query) && !ch.group.toLowerCase().includes(query)) {
        return false;
      }
      return true;
    });

    els.channelCount.textContent = `${state.channels.length} channels`;
    els.channelList.innerHTML = '';

    if (filtered.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'channel-empty';
      empty.textContent = state.channels.length ? 'No matching channels' : 'No channels loaded yet';
      els.channelList.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const ch of filtered) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'channel-item';
      btn.dataset.url = ch.url;
      btn.setAttribute('role', 'option');
      if (state.activeChannel?.url === ch.url) {
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
      }

      const num = document.createElement('span');
      num.className = 'channel-num';
      num.textContent = ch.chno;

      let thumb;
      if (ch.logo) {
        thumb = document.createElement('img');
        thumb.className = 'channel-thumb';
        thumb.loading = 'lazy';
        thumb.alt = '';
        thumb.src = ch.logo;
        thumb.onerror = () => {
          const fallback = createThumbFallback(ch.name);
          thumb.replaceWith(fallback);
        };
      } else {
        thumb = createThumbFallback(ch.name);
      }

      const meta = document.createElement('span');
      meta.className = 'channel-meta';

      const name = document.createElement('span');
      name.className = 'channel-name';
      name.textContent = ch.name;

      const sub = document.createElement('span');
      sub.className = 'channel-sub';
      sub.textContent = `${ch.group} • ${ch.format}${ch.clearKeys ? ' • ClearKey' : ''}`;

      meta.append(name, sub);
      btn.append(num, thumb, meta);
      btn.addEventListener('click', () => playChannel(ch));
      li.appendChild(btn);
      fragment.appendChild(li);
    }

    els.channelList.appendChild(fragment);
  }

  function createThumbFallback(name) {
    const span = document.createElement('span');
    span.className = 'channel-thumb-fallback';
    span.textContent = (name || '?').slice(0, 2).toUpperCase();
    return span;
  }

  function updateMetaDisplay() {
    const syncTime = state.lastSyncedAt
      ? state.lastSyncedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '—';
    const listStamp = state.playlistUpdatedText ? `List: ${state.playlistUpdatedText}` : 'Source: himelop.short.gy';
    els.playlistMeta.innerHTML = `<span>${escapeHtml(listStamp)}</span><span>Synced ${escapeHtml(syncTime)}</span>`;
  }

  function escapeHtml(text) {
    return text.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  async function fetchPlaylistText() {
    try {
      const res = await fetch(`/api/playlist?t=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (typeof data.playlist === 'string') return data.playlist;
      }
    } catch {
      // Fallback for static hosting without local server
    }

    const direct = await fetch(`${PLAYLIST_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!direct.ok) {
      throw new Error(`HTTP ${direct.status}`);
    }
    return direct.text();
  }

  async function syncPlaylist({ isManual = false } = {}) {
    if (state.isFetching) return;
    state.isFetching = true;
    els.syncDot.className = 'live-dot syncing';
    els.refreshBtn.classList.add('spinning');
    if (isManual) els.refreshStatus.textContent = 'Refreshing…';

    try {
      const text = await fetchPlaylistText();
      state.lastSyncedAt = new Date();
      els.syncDot.className = 'live-dot ok';

      if (text !== state.rawPlaylist) {
        state.rawPlaylist = text;
        const { channels, updatedText } = parseM3U(text);
        state.channels = channels;
        state.playlistUpdatedText = updatedText;

        populateGroupFilter(channels);
        renderChannelList();

        if (!state.activeChannel && channels.length > 0) {
          const savedUrl = localStorage.getItem(STORAGE_KEYS.lastChannelUrl);
          const initial = channels.find((c) => c.url === savedUrl) || channels[0];
          playChannel(initial);
        } else if (state.activeChannel) {
          const updatedMatch = channels.find((c) => c.url === state.activeChannel.url);
          if (updatedMatch) {
            state.activeChannel = updatedMatch;
            updateNowPlayingUI(updatedMatch);
          }
        }
      }

      updateMetaDisplay();
      state.countdown = state.refreshSeconds;
      updateCountdownLabel();
    } catch (err) {
      els.syncDot.className = 'live-dot err';
      els.refreshStatus.textContent = `Sync failed (${err.message})`;
      if (state.channels.length === 0) {
        setOverlay(`Could not load playlist: ${err.message}`, false);
      }
    } finally {
      state.isFetching = false;
      els.refreshBtn.classList.remove('spinning');
    }
  }

  function updateCountdownLabel() {
    if (state.isFetching) return;
    if (state.refreshSeconds === 0) {
      els.refreshStatus.textContent = 'Auto-refresh off';
      return;
    }
    els.refreshStatus.textContent = `Refresh in ${state.countdown}s`;
  }

  function startRefreshTimer() {
    state.countdown = state.refreshSeconds;
    updateCountdownLabel();

    setInterval(() => {
      if (state.refreshSeconds === 0 || state.isFetching) return;
      state.countdown -= 1;
      if (state.countdown <= 0) {
        syncPlaylist();
      } else {
        updateCountdownLabel();
      }
    }, 1000);
  }

  function bindEvents() {
    els.refreshInterval.value = String(state.refreshSeconds);
    els.proxyToggle.checked = state.useProxy;

    els.refreshInterval.addEventListener('change', () => {
      state.refreshSeconds = Number(els.refreshInterval.value);
      localStorage.setItem(STORAGE_KEYS.refreshInterval, String(state.refreshSeconds));
      state.countdown = state.refreshSeconds;
      updateCountdownLabel();
    });

    els.refreshBtn.addEventListener('click', () => {
      syncPlaylist({ isManual: true });
    });

    els.proxyToggle.addEventListener('change', () => {
      state.useProxy = els.proxyToggle.checked;
      localStorage.setItem(STORAGE_KEYS.useProxy, String(state.useProxy));
      if (state.activeChannel) playChannel(state.activeChannel);
    });

    els.retryBtn.addEventListener('click', () => {
      if (state.activeChannel) playChannel(state.activeChannel);
    });

    els.searchInput.addEventListener('input', renderChannelList);
    els.groupFilter.addEventListener('change', renderChannelList);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.refreshSeconds > 0 && state.lastSyncedAt) {
        const elapsedSec = (Date.now() - state.lastSyncedAt.getTime()) / 1000;
        if (elapsedSec >= Math.max(15, state.refreshSeconds / 2)) {
          syncPlaylist();
        }
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== els.searchInput) {
        e.preventDefault();
        els.searchInput.focus();
      }
    });
  }

  bindEvents();
  startRefreshTimer();
  syncPlaylist();
})();
