(function () {
  'use strict';

  const MODES = Object.freeze({ console: 'console', endpoint: 'endpoint', both: 'both' });
  const DEFAULT_MODE = MODES.both;
  const ENDPOINT = '/__logs';
  const FLUSH_MS = 1000;
  const MAX_QUEUE = 2000;

  const origFetch = (typeof window.fetch === 'function') ? window.fetch.bind(window) : null;
  const origConsole = {
    log: console.log.bind(console),
    info: (console.info || console.log).bind(console),
    warn: (console.warn || console.log).bind(console),
    error: (console.error || console.log).bind(console),
    debug: (console.debug || console.log).bind(console),
  };

  let cachedMode = null;

  function resolveMode() {
    if (cachedMode) return cachedMode;
    try {
      const stored = localStorage.getItem('LOGGER_MODE');
      if (stored && MODES[stored]) { cachedMode = stored; return cachedMode; }
    } catch (_) {}
    if (window.LOGGER_MODE && MODES[window.LOGGER_MODE]) { cachedMode = window.LOGGER_MODE; return cachedMode; }
    cachedMode = DEFAULT_MODE;
    return cachedMode;
  }

  function setMode(m) {
    if (!MODES[m]) { origConsole.error('log.setMode: invalid mode', m); return; }
    cachedMode = m;
    window.LOGGER_MODE = m;
    try { localStorage.setItem('LOGGER_MODE', m); } catch (_) {}
    origConsole.info('[logger] mode =', m);
  }

  function stringifyArg(a) {
    if (a === null || a === undefined) return String(a);
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || (a.name + ': ' + a.message);
    if (typeof a === 'number' || typeof a === 'boolean') return String(a);
    try { return JSON.stringify(a); } catch (_) { return String(a); }
  }

  const queue = [];

  function extractStack(args) {
    for (const a of args) {
      if (a instanceof Error && a.stack) return a.stack;
    }
    return undefined;
  }

  function enqueue(level, args) {
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push({
      ts: new Date().toISOString(),
      level,
      msg: Array.prototype.map.call(args, stringifyArg).join(' '),
      stack: extractStack(args),
      url: location.pathname + location.search,
    });
  }

  let inflight = false;
  function flush() {
    if (!queue.length || inflight || !origFetch) return;
    const mode = resolveMode();
    if (mode === MODES.console) { queue.length = 0; return; }
    const batch = queue.splice(0, queue.length);
    inflight = true;
    origFetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
      keepalive: true,
    }).catch(() => {
      // swallow: do not re-enqueue to avoid unbounded growth on server down
    }).finally(() => { inflight = false; });
  }

  setInterval(flush, FLUSH_MS);

  function beaconFlush() {
    if (!queue.length) return;
    const mode = resolveMode();
    if (mode === MODES.console) { queue.length = 0; return; }
    const body = JSON.stringify(queue.splice(0, queue.length));
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
      } else if (origFetch) {
        origFetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true });
      }
    } catch (_) {}
  }
  window.addEventListener('pagehide', beaconFlush);
  window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') beaconFlush(); });

  function emit(level, args) {
    const mode = resolveMode();
    if (mode === MODES.console || mode === MODES.both) {
      origConsole[level](...args);
    }
    if (mode === MODES.endpoint || mode === MODES.both) {
      enqueue(level, args);
    }
  }

  window.log = {
    log:   function () { emit('info',  arguments); },
    info:  function () { emit('info',  arguments); },
    warn:  function () { emit('warn',  arguments); },
    error: function () { emit('error', arguments); },
    debug: function () { emit('debug', arguments); },
    setMode,
    getMode: resolveMode,
    MODES,
    flush,
  };

  window.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t !== window && t.nodeType === 1) {
      const tag = (t.tagName || '').toLowerCase();
      const src = t.src || t.href || t.currentSrc || '';
      emit('error', [`[resource-error] <${tag}> ${src}`]);
      return;
    }
    emit('error', [e.message || 'Unhandled error', e.error || '']);
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    emit('error', ['Unhandled rejection:', reason instanceof Error ? reason : stringifyArg(reason)]);
  });

  // ── fetch wrapper: logs network errors (CORS, ERR_CONNECTION_REFUSED) and non-2xx ──
  if (origFetch) {
    window.fetch = function wrappedFetch(input, init) {
      const url = (typeof input === 'string') ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      return origFetch(input, init).then((resp) => {
        if (!resp.ok) emit('warn', [`[fetch ${resp.status}] ${method} ${url}`]);
        return resp;
      }, (err) => {
        emit('error', [`[fetch-error] ${method} ${url}`, err && err.message ? err.message : err]);
        throw err;
      });
    };
  }

  // ── XHR wrapper: logs network/timeout/abort errors and non-2xx ──
  if (typeof XMLHttpRequest === 'function') {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__log = { method, url };
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      const meta = this.__log || {};
      this.addEventListener('error',   () => emit('error', [`[xhr-error] ${meta.method} ${meta.url}`]));
      this.addEventListener('timeout', () => emit('error', [`[xhr-timeout] ${meta.method} ${meta.url}`]));
      this.addEventListener('abort',   () => emit('warn',  [`[xhr-abort] ${meta.method} ${meta.url}`]));
      this.addEventListener('load', () => {
        if (this.status >= 400) emit('warn', [`[xhr ${this.status}] ${meta.method} ${meta.url}`]);
      });
      return origSend.apply(this, arguments);
    };
  }
})();
