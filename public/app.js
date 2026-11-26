(() => {
  'use strict';

  const PLAYLIST_URL = 'https://himelop.short.gy/playlist.m3u';
  const AUTO_REFRESH_MS = 30000;
  const STALL_THRESHOLD_SEC = 8;
  const RECONNECT_DELAY_MS = 2500;
  const ALL_CHANNELS_CATEGORY = 'All Channels';
  const HIDDEN_CATEGORIES = new Set(["hop's premium playlist"]);

  const els = {
    video: document.getElementById('video'),
    playerOverlay: document.getElementById('playerOverlay'),
    overlayMessage: document.getElementById('overlayMessage'),
    activeLogo: document.getElementById('activeLogo'),
    activeTitle: document.getElementById('activeTitle'),
    activeLivePill: document.getElementById('activeLivePill'),
    activeGroup: document.getElementById('activeGroup'),
    activeFormat: document.getElementById('activeFormat'),
    activeDrm: document.getElementById('activeDrm'),
    proxyToggle: document.getElementById('proxyToggle'),
    retryBtn: document.getElementById('retryBtn'),
    backToCategoriesBtn: document.getElementById('backToCategoriesBtn'),
    homeBrandLink: document.getElementById('homeBrandLink'),
    topBackBtn: document.getElementById('topBackBtn'),
    browseView: document.getElementById('browseView'),
    browseBackBtn: document.getElementById('browseBackBtn'),
    browseTitle: document.getElementById('browseTitle'),
    browseSearch: document.getElementById('browseSearch'),
    categoryGrid: document.getElementById('categoryGrid'),
    browseChannelList: document.getElementById('browseChannelList'),
    playerView: document.getElementById('playerView'),
    sidebarBackBtn: document.getElementById('sidebarBackBtn'),
    channelList: document.getElementById('channelList'),
    channelCount: document.getElementById('channelCount'),
    searchInput: document.getElementById('searchInput'),
    syncDot: document.getElementById('syncDot'),
  };

  const state = {
    channels: [],
    rawPlaylist: '',
    workerProxyUrl: localStorage.getItem('showmo_worker_proxy_url') || '',
    lastSyncedAt: null,
    activeChannel: null,
    selectedCategory: null,
    useProxy: false,
    proxyOverrides: new Map(),
    serverProxyUrls: new Set(),
    fallbackStage: 'initial',
    isFetching: false,
    isRecovering: false,
    hasPlayed: false,
    lastPlaybackTime: -1,
    stalledSeconds: 0,
    watchdogTimer: null,
    reconnectTimer: null,
    hls: null,
    shaka: null,
  };

  function resolveProxyForChannel(channel) {
    if (state.proxyOverrides.has(channel.url)) {
      return state.proxyOverrides.get(channel.url);
    }
    return channel.format !== 'DASH' && !channel.clearKeys;
  }

  function encodeHeadersParam(headers) {
    if (!headers || Object.keys(headers).length === 0) return '';
    const bytes = new TextEncoder().encode(JSON.stringify(headers));
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function isIpHost(targetUrl) {
    try {
      const host = new URL(targetUrl).hostname.replace(/^\[|\]$/g, '');
      return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
    } catch {
      return false;
    }
  }

  function buildStreamUrl(targetUrl, headers, rewrite = false) {
    if (!state.useProxy) return targetUrl;
    if (targetUrl.startsWith(`${location.origin}/api/proxy`)) return targetUrl;
    if (state.workerProxyUrl && targetUrl.startsWith(state.workerProxyUrl)) return targetUrl;

    const params = new URLSearchParams({ url: targetUrl });
    const encoded = encodeHeadersParam(headers);
    if (encoded) params.set('h', encoded);
    if (rewrite) params.set('rewrite', '1');

    if (!state.serverProxyUrls.has(state.activeChannel?.url || '') && state.workerProxyUrl && !isIpHost(targetUrl)) {
      return `${state.workerProxyUrl}/?${params.toString()}`;
    }
    return `/api/proxy?${params.toString()}`;
  }

  function unwrapProxyUrl(maybeProxyUrl) {
    try {
      const parsed = new URL(maybeProxyUrl, location.origin);
      const workerOrigin = state.workerProxyUrl ? new URL(state.workerProxyUrl).origin : '';
      if (parsed.pathname === '/api/proxy' || (workerOrigin && parsed.origin === workerOrigin)) {
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
    let pending = createEmptyMeta();

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

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

        const group = (pending.group || 'General').trim();
        if (!HIDDEN_CATEGORIES.has(group.toLowerCase())) {
          const isMpd = pending.manifestType === 'mpd' || /\.mpd(\?|$)/i.test(cleanUrl);
          const format = isMpd ? 'DASH' : /\.m3u8(\?|$)/i.test(cleanUrl) ? 'HLS' : 'STREAM';
          channels.push({
            id: `${channels.length + 1}`,
            chno: pending.chno || String(channels.length + 1),
            name: pending.name || `Channel ${channels.length + 1}`,
            logo: pending.logo,
            group,
            url: cleanUrl,
            format,
            clearKeys: Object.keys(pending.clearKeys).length ? pending.clearKeys : null,
            headers: pending.headers,
          });
        }
        pending = createEmptyMeta();
      }
    }

    return channels;
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

  function clearReconnectTimer() {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  }

  function stopPlaybackWatchdog() {
    if (state.watchdogTimer) {
      clearInterval(state.watchdogTimer);
      state.watchdogTimer = null;
    }
    state.stalledSeconds = 0;
    state.lastPlaybackTime = -1;
  }

  function startPlaybackWatchdog() {
    stopPlaybackWatchdog();
    state.watchdogTimer = setInterval(() => {
      if (!state.activeChannel || state.isRecovering || !navigator.onLine) return;
      if (els.video.paused) {
        state.stalledSeconds = 0;
        state.lastPlaybackTime = els.video.currentTime;
        return;
      }

      const currentTime = els.video.currentTime;
      const isAdvancing = state.lastPlaybackTime >= 0 && Math.abs(currentTime - state.lastPlaybackTime) >= 0.05;
      const isBuffering = els.video.readyState <= 2 || els.video.playbackRate === 0;

      if (!isAdvancing || isBuffering) {
        state.stalledSeconds += 1;
        if (state.stalledSeconds >= STALL_THRESHOLD_SEC) {
          recoverActiveChannel('Stream lagged — refreshing live…');
        }
      } else {
        state.stalledSeconds = 0;
        state.hasPlayed = true;
      }

      state.lastPlaybackTime = currentTime;
    }, 1000);
  }

  function scheduleReconnect(reason = 'Connection interrupted — reconnecting…') {
    if (!state.activeChannel || state.reconnectTimer) return;
    setOverlay(reason, true);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      recoverActiveChannel('Reconnecting to live…');
    }, RECONNECT_DELAY_MS);
  }

  async function recoverActiveChannel(reason = 'Reconnecting to live…') {
    if (!state.activeChannel || state.isRecovering) return;
    if (!navigator.onLine) {
      setOverlay('Waiting for internet connection…', true);
      return;
    }
    state.isRecovering = true;
    state.stalledSeconds = 0;
    clearReconnectTimer();
    try {
      await playChannel(state.activeChannel, { overlayText: reason, syncHistory: false });
    } finally {
      state.isRecovering = false;
    }
  }

  async function teardownPlayers() {
    clearReconnectTimer();
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

  function handleInitialStreamFailure(channel, errorMessage) {
    if (!state.activeChannel || state.activeChannel.url !== channel.url || state.hasPlayed) {
      return false;
    }

    const canUseWorker = Boolean(state.workerProxyUrl && !isIpHost(channel.url));
    if (state.fallbackStage === 'initial' && state.useProxy && /^https:\/\//i.test(channel.url)) {
      state.proxyOverrides.set(channel.url, false);
      playChannel(channel, { overlayText: 'Trying direct connection…', fallbackStage: 'direct', syncHistory: false });
      return true;
    }

    if (
      (state.fallbackStage === 'direct' || (state.fallbackStage === 'initial' && state.useProxy)) &&
      canUseWorker &&
      !state.serverProxyUrls.has(channel.url)
    ) {
      state.serverProxyUrls.add(channel.url);
      state.proxyOverrides.set(channel.url, true);
      playChannel(channel, { overlayText: 'Trying server proxy…', fallbackStage: 'server', syncHistory: false });
      return true;
    }

    setOverlay(`Playback failed: ${errorMessage || 'Unable to load stream'}`, true);
    return false;
  }

  function pushNavState(view, category = null, channelUrl = null, replace = false) {
    const nextState = { view, category, channelUrl };
    if (replace) {
      history.replaceState(nextState, '');
    } else {
      history.pushState(nextState, '');
    }
  }

  async function playChannel(channel, { overlayText, fallbackStage = 'initial', syncHistory = true } = {}) {
    if (!channel) return;
    const wasPlaying = Boolean(state.activeChannel);
    const isSameChannel = state.activeChannel?.url === channel.url;
    state.activeChannel = channel;
    state.fallbackStage = fallbackStage;
    state.useProxy = resolveProxyForChannel(channel);
    els.proxyToggle.checked = state.useProxy;
    if (!isSameChannel) {
      state.hasPlayed = false;
    }
    if (state.selectedCategory !== ALL_CHANNELS_CATEGORY) {
      state.selectedCategory = channel.group;
    }
    if (syncHistory && fallbackStage === 'initial') {
      if (!wasPlaying) {
        pushNavState('player', state.selectedCategory, channel.url, false);
      } else if (!isSameChannel) {
        pushNavState('player', state.selectedCategory, channel.url, true);
      }
    }
    els.browseView.classList.add('hidden');
    els.playerView.classList.remove('hidden');
    updateNowPlayingUI(channel);
    render();

    setOverlay(overlayText || `Loading ${channel.name}…`);
    stopPlaybackWatchdog();
    if (state.hls || state.shaka || els.video.getAttribute('src')) {
      await teardownPlayers();
    }

    try {
      if (channel.format === 'DASH' || channel.clearKeys) {
        await playWithShaka(channel);
      } else {
        await playWithHlsOrNative(channel);
      }
      setOverlay('');
      startPlaybackWatchdog();
      els.video.play().catch(() => {
        // Autoplay with sound may be blocked by browser policy; controls are visible
      });
    } catch (err) {
      if (state.hasPlayed && navigator.onLine) {
        scheduleReconnect(`Playback interrupted (${err.message || 'retrying'})…`);
      } else {
        handleInitialStreamFailure(channel, err.message);
      }
    }
  }

  async function returnToCategoriesView({ keepCategory = false, syncHistory = true } = {}) {
    state.activeChannel = null;
    if (!keepCategory) {
      state.selectedCategory = null;
    }
    state.hasPlayed = false;
    state.isRecovering = false;
    stopPlaybackWatchdog();
    els.browseSearch.value = '';
    els.searchInput.value = '';
    await teardownPlayers();
    setOverlay('');
    els.playerView.classList.add('hidden');
    els.browseView.classList.remove('hidden');
    if (syncHistory) {
      if (keepCategory && state.selectedCategory) {
        pushNavState('category', state.selectedCategory, null, false);
      } else if (history.state?.view !== 'home') {
        pushNavState('home', null, null, false);
      }
    }
    render();
  }

  function handleBackNavigation() {
    if (history.state?.view === 'player' || history.state?.view === 'category') {
      history.back();
      return;
    }
    if (state.activeChannel) {
      returnToCategoriesView({ keepCategory: true });
      return;
    }
    if (state.selectedCategory) {
      state.selectedCategory = null;
      els.browseSearch.value = '';
      render();
    }
  }

  function isIosDevice() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  async function playWithShaka(channel) {
    if (isIosDevice() && channel.clearKeys) {
      throw new Error('iPhone Safari does not support ClearKey DASH (.mpd) streams. Try an HLS channel instead.');
    }
    if (!window.shaka) {
      throw new Error('Shaka Player library failed to load');
    }
    window.shaka.polyfill.installAll();
    if (!window.shaka.Player.isBrowserSupported()) {
      throw new Error(isIosDevice()
        ? 'iPhone Safari does not support DASH (.mpd) streams. Try an HLS channel instead.'
        : 'Browser does not support DASH playback');
    }

    const player = new window.shaka.Player();
    await player.attach(els.video);
    state.shaka = player;

    player.addEventListener('error', (event) => {
      const detail = event.detail;
      if (state.hasPlayed) {
        scheduleReconnect(`Stream interrupted (${detail?.code || 'retrying'})…`);
      } else {
        setOverlay(`Stream error (${detail?.code || 'unknown'})`, true);
      }
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
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: 6,
          maxLiveSyncPlaybackRate: 1.5,
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
            } else if (state.hasPlayed) {
              scheduleReconnect('Stream interrupted — reconnecting…');
            } else {
              handleInitialStreamFailure(channel, `Stream error (${data.details || 'fatal'})`);
            }
          }
        });

        hls.loadSource(channel.url);
        hls.attachMedia(els.video);
        return;
      }

      els.video.src = buildStreamUrl(channel.url, channel.headers, true);
      els.video.onloadedmetadata = () => resolve();
      els.video.onerror = () => reject(new Error('Stream could not be played'));
    });
  }

  function updateNowPlayingUI(channel) {
    els.activeTitle.textContent = channel.name;
    els.activeGroup.textContent = `${channel.group} • Channel #${channel.chno}`;
    els.activeLivePill.classList.remove('hidden');
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

  function getCategories() {
    if (state.channels.length === 0) return [];
    const counts = new Map();
    for (const ch of state.channels) {
      counts.set(ch.group, (counts.get(ch.group) || 0) + 1);
    }
    return [
      { name: ALL_CHANNELS_CATEGORY, count: state.channels.length },
      ...[...counts.entries()].map(([name, count]) => ({ name, count })),
    ];
  }

  function getFilteredChannels(query) {
    const filterByGroup = state.selectedCategory && state.selectedCategory !== ALL_CHANNELS_CATEGORY;
    return state.channels.filter((ch) => {
      if (filterByGroup && ch.group !== state.selectedCategory) return false;
      if (query && !ch.name.toLowerCase().includes(query) && !ch.group.toLowerCase().includes(query)) {
        return false;
      }
      return true;
    });
  }

  function createThumbFallback(name) {
    const span = document.createElement('span');
    span.className = 'channel-thumb-fallback';
    span.textContent = (name || '?').slice(0, 2).toUpperCase();
    return span;
  }

  function createChannelItem(ch) {
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

    const subRow = document.createElement('span');
    subRow.className = 'channel-sub-row';

    const groupLabel = document.createElement('span');
    groupLabel.className = 'channel-group-label';
    groupLabel.textContent = ch.group;

    const formatPill = document.createElement('span');
    formatPill.className = 'micro-pill';
    formatPill.textContent = ch.format;

    subRow.append(groupLabel, formatPill);
    if (ch.clearKeys) {
      const drmPill = document.createElement('span');
      drmPill.className = 'micro-pill micro-pill-drm';
      drmPill.textContent = 'ClearKey';
      subRow.appendChild(drmPill);
    }

    meta.append(name, subRow);
    btn.append(num, thumb, meta);
    btn.addEventListener('click', () => playChannel(ch));
    li.appendChild(btn);
    return li;
  }

  function getCategoryIconSvg(catName) {
    const lower = (catName || '').toLowerCase();
    if (catName === ALL_CHANNELS_CATEGORY) {
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';
    }
    if (lower.includes('cricket') || lower.includes('willow')) {
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>';
    }
    if (lower.includes('football') || lower.includes('soccer') || lower.includes('sport') || lower.includes('sony')) {
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m12 7 3 2.2-1.1 3.5h-3.8L9 9.2 12 7Z"/><path d="M12 3v4"/><path d="m20.5 9-5.5.2"/><path d="m3.5 9 5.5.2"/><path d="m6.5 19 3.6-6.3"/><path d="m17.5 19-3.6-6.3"/></svg>';
    }
    if (lower.includes('live') || lower.includes('hot') || lower.includes('event')) {
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 18v3"/><polygon points="10 8.5 15 11 10 13.5" fill="currentColor" stroke="none"/></svg>';
  }

  function createCategoryIcon(catName, small = false) {
    const span = document.createElement('span');
    span.className = small ? 'category-icon category-icon-sm' : 'category-icon';
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = getCategoryIconSvg(catName);
    return span;
  }

  function createCategoryCard(cat, onSelect) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'category-card';

    const main = document.createElement('span');
    main.className = 'category-card-main';

    const icon = createCategoryIcon(cat.name);

    const info = document.createElement('span');
    info.className = 'category-card-info';

    const name = document.createElement('span');
    name.className = 'category-card-name';
    name.textContent = cat.name;

    const count = document.createElement('span');
    count.className = 'category-card-count';
    count.textContent = `${cat.count} ${cat.count === 1 ? 'channel' : 'channels'}`;

    const chevron = document.createElement('span');
    chevron.className = 'category-chevron';
    chevron.textContent = '›';

    info.append(name, count);
    main.append(icon, info);
    btn.append(main, chevron);
    btn.addEventListener('click', () => onSelect(cat.name));
    return btn;
  }

  function renderBrowseView() {
    const query = els.browseSearch.value.trim().toLowerCase();
    const categories = getCategories();

    if (state.selectedCategory && !categories.some((c) => c.name === state.selectedCategory)) {
      state.selectedCategory = null;
    }

    const showingChannels = Boolean(state.selectedCategory || query);
    els.browseBackBtn.classList.toggle('hidden', !state.selectedCategory);
    els.browseTitle.textContent = state.selectedCategory
      ? state.selectedCategory
      : query
        ? 'Search results'
        : 'Categories';

    els.categoryGrid.classList.toggle('hidden', showingChannels);
    els.browseChannelList.classList.toggle('hidden', !showingChannels);

    if (!showingChannels) {
      els.categoryGrid.innerHTML = '';
      if (categories.length === 0) {
        const frag = document.createDocumentFragment();
        for (let i = 0; i < 8; i++) {
          const card = document.createElement('div');
          card.className = 'skeleton-card';
          card.setAttribute('aria-hidden', 'true');
          card.innerHTML = '<span class="skeleton-line wide"></span><span class="skeleton-line short"></span>';
          frag.appendChild(card);
        }
        els.categoryGrid.appendChild(frag);
        return;
      }

      const frag = document.createDocumentFragment();
      for (const cat of categories) {
        frag.appendChild(createCategoryCard(cat, (catName) => {
          state.selectedCategory = catName;
          pushNavState('category', catName, null, false);
          render();
        }));
      }
      els.categoryGrid.appendChild(frag);
      return;
    }

    const filtered = getFilteredChannels(query);

    els.browseChannelList.innerHTML = '';
    if (filtered.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'channel-empty';
      empty.textContent = 'No matching channels';
      els.browseChannelList.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const ch of filtered) {
      frag.appendChild(createChannelItem(ch));
    }
    els.browseChannelList.appendChild(frag);
  }

  function renderSidebar() {
    const query = els.searchInput.value.trim().toLowerCase();
    const categories = getCategories();

    if (state.selectedCategory && !categories.some((c) => c.name === state.selectedCategory)) {
      state.selectedCategory = null;
    }

    const showingCategories = !state.selectedCategory && !query;
    els.sidebarBackBtn.classList.toggle('hidden', showingCategories);
    els.channelList.innerHTML = '';

    if (showingCategories) {
      const frag = document.createDocumentFragment();
      for (const cat of categories) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'channel-item';

        const icon = createCategoryIcon(cat.name, true);

        const meta = document.createElement('span');
        meta.className = 'channel-meta';

        const name = document.createElement('span');
        name.className = 'channel-name';
        name.textContent = cat.name;

        const subRow = document.createElement('span');
        subRow.className = 'channel-sub-row';

        const sub = document.createElement('span');
        sub.className = 'channel-group-label';
        sub.textContent = `${cat.count} ${cat.count === 1 ? 'channel' : 'channels'}`;

        subRow.appendChild(sub);

        const chevron = document.createElement('span');
        chevron.className = 'category-chevron';
        chevron.textContent = '›';

        meta.append(name, subRow);
        btn.append(icon, meta, chevron);
        btn.addEventListener('click', () => {
          state.selectedCategory = cat.name;
          renderSidebar();
        });
        li.appendChild(btn);
        frag.appendChild(li);
      }
      els.channelList.appendChild(frag);
      return;
    }

    const filtered = getFilteredChannels(query);

    if (filtered.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'channel-empty';
      empty.textContent = 'No matching channels';
      els.channelList.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const ch of filtered) {
      frag.appendChild(createChannelItem(ch));
    }
    els.channelList.appendChild(frag);
  }

  function render() {
    const categories = getCategories();
    const groupCount = Math.max(0, categories.length - 1);
    els.channelCount.textContent = state.channels.length
      ? `${groupCount} categories • ${state.channels.length} channels`
      : 'Loading…';

    const canGoBack = Boolean(state.activeChannel || state.selectedCategory);
    els.topBackBtn.classList.toggle('hidden', !canGoBack);

    if (state.activeChannel) {
      renderSidebar();
    } else {
      renderBrowseView();
    }
  }

  async function fetchPlaylistText() {
    try {
      const res = await fetch(`/api/playlist?t=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (typeof data.workerProxyUrl === 'string' && data.workerProxyUrl) {
          state.workerProxyUrl = data.workerProxyUrl.replace(/\/+$/, '');
        }
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

  async function syncPlaylist() {
    if (state.isFetching) return;
    state.isFetching = true;

    try {
      const text = await fetchPlaylistText();
      state.lastSyncedAt = new Date();
      els.syncDot.className = 'live-dot ok';

      if (text !== state.rawPlaylist) {
        state.rawPlaylist = text;
        state.channels = parseM3U(text);

        if (state.activeChannel) {
          const updatedMatch = state.channels.find((c) => c.url === state.activeChannel.url);
          if (updatedMatch) {
            state.activeChannel = updatedMatch;
            updateNowPlayingUI(updatedMatch);
          }
        }

        render();
      }
    } catch (err) {
      if (state.channels.length === 0) {
        els.syncDot.className = 'live-dot err';
        els.channelCount.textContent = 'Load failed';
        const errEl = document.createElement('div');
        errEl.className = 'channel-empty';
        errEl.textContent = `Could not load playlist: ${err.message}`;
        els.categoryGrid.replaceChildren(errEl);
      }
    } finally {
      state.isFetching = false;
    }
  }

  function startRefreshTimer() {
    setInterval(() => {
      syncPlaylist();
    }, AUTO_REFRESH_MS);
  }

  function bindEvents() {
    pushNavState('home', null, null, true);
    els.proxyToggle.checked = state.useProxy;

    els.proxyToggle.addEventListener('change', () => {
      state.useProxy = els.proxyToggle.checked;
      if (state.activeChannel) {
        state.proxyOverrides.set(state.activeChannel.url, state.useProxy);
        playChannel(state.activeChannel, { syncHistory: false });
      }
    });

    els.retryBtn.addEventListener('click', () => {
      if (state.activeChannel) playChannel(state.activeChannel, { syncHistory: false });
    });

    els.browseBackBtn.addEventListener('click', () => {
      handleBackNavigation();
    });

    els.sidebarBackBtn.addEventListener('click', () => {
      state.selectedCategory = null;
      els.searchInput.value = '';
      renderSidebar();
    });

    els.homeBrandLink.addEventListener('click', (e) => {
      e.preventDefault();
      returnToCategoriesView();
    });

    els.topBackBtn.addEventListener('click', () => {
      handleBackNavigation();
    });

    els.backToCategoriesBtn.addEventListener('click', () => {
      returnToCategoriesView();
    });

    window.addEventListener('popstate', (event) => {
      const nav = event.state || { view: 'home', category: null, channelUrl: null };
      if (nav.view === 'home') {
        returnToCategoriesView({ keepCategory: false, syncHistory: false });
        return;
      }
      if (nav.view === 'category') {
        state.selectedCategory = nav.category;
        if (state.activeChannel) {
          returnToCategoriesView({ keepCategory: true, syncHistory: false });
        } else {
          els.browseSearch.value = '';
          render();
        }
        return;
      }
      if (nav.view === 'player' && nav.channelUrl) {
        const ch = state.channels.find((c) => c.url === nav.channelUrl);
        if (ch) {
          state.selectedCategory = nav.category || ch.group;
          playChannel(ch, { syncHistory: false });
        } else {
          returnToCategoriesView({ keepCategory: true, syncHistory: false });
        }
      }
    });

    els.browseSearch.addEventListener('input', renderBrowseView);
    els.searchInput.addEventListener('input', renderSidebar);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.lastSyncedAt) {
        if (Date.now() - state.lastSyncedAt.getTime() >= AUTO_REFRESH_MS) {
          syncPlaylist();
        }
      }
    });

    window.addEventListener('online', () => {
      if (state.activeChannel) {
        recoverActiveChannel('Back online — syncing to live…');
      }
    });

    els.video.addEventListener('playing', () => {
      state.hasPlayed = true;
      state.stalledSeconds = 0;
    });

    document.addEventListener('keydown', (e) => {
      const targetInput = state.activeChannel ? els.searchInput : els.browseSearch;
      if (e.key === '/' && document.activeElement !== targetInput) {
        e.preventDefault();
        targetInput.focus();
      }
    });
  }

  bindEvents();
  startRefreshTimer();
  syncPlaylist();
})();
