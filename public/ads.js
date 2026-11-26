/*
 * adserver — drop-in loader.
 *
 * Usage (iframe mode, recommended):
 *   <div id="slot-1"></div>
 *   <script async src="https://ads.example.com/z/3.js" data-target="#slot-1"></script>
 *
 * Or zone-bound Revive-style (renders where the tag sits):
 *   <script async src="https://ads.example.com/z/3.js"></script>
 *
 * Inline mode (no iframe; image + plain-text creatives only, so nothing
 * untrusted is ever injected into the host page):
 *   <script async src="https://ads.example.com/z/3.js" data-mode="inline" data-target="#slot-1"></script>
 *
 * Attributes:
 *   data-zone              zone id (required unless the tag is /z/<id>.js)
 *   data-target            CSS selector for the slot element (default: after this script)
 *   data-mode              iframe (default) | inline
 *   data-width/height      override the zone size
 *   data-class             extra class on the created element
 *   data-resize="1"        let the ad grow the iframe via postMessage
 *   data-lazy="0"          disable viewport lazy-loading (default: lazy when a target is set)
 *   data-fallback          CSS selector for an element to reveal when no ad is served
 *   data-max-per-visitor   cap renders for this visitor per day (stored on the host page origin)
 *   data-seen-scope        storage key suffix, defaults to the zone id
 *
 * The loader never sends cookies, never reads the page content, and never
 * touches the host DOM beyond the slot it is given.
 */
(function () {
  'use strict';

  var script =
    document.currentScript ||
    (function () {
      var all = document.getElementsByTagName('script');
      return all[all.length - 1];
    })();
  if (!script || script.getAttribute('data-adsrv-init') === '1') return;
  script.setAttribute('data-adsrv-init', '1');

  var cfg = window.__ADSRV_ZONE__ || {};
  var attr = function (name) {
    return script.getAttribute(name);
  };
  var num = function (value) {
    var n = parseInt(value || '', 10);
    return isFinite(n) ? n : 0;
  };

  var zone = num(attr('data-zone') || cfg.id);
  if (!zone) {
    if (window.console && console.warn) console.warn('[adsrv] missing data-zone');
    return;
  }

  var origin;
  try {
    origin = new URL(script.src, window.location.href).origin;
  } catch (error) {
    return;
  }

  var options = {
    zone: zone,
    width: num(attr('data-width')) || cfg.width || 0,
    height: num(attr('data-height')) || cfg.height || 0,
    target: attr('data-target') || '',
    className: attr('data-class') || '',
    mode: (attr('data-mode') || cfg.mode || 'iframe').toLowerCase(),
    resize: attr('data-resize') === '1' || cfg.autoHeight === true,
    lazy: attr('data-lazy') !== '0',
    fallback: attr('data-fallback') || '',
    maxPerVisitor: num(attr('data-max-per-visitor')),
    scope: attr('data-seen-scope') || String(zone),
  };

  // ---------------------------------------------------------------- storage
  var STORE_KEY = 'adsrv:v1:' + options.scope;
  function today() {
    var now = new Date();
    return now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2) + '-' + ('0' + now.getDate()).slice(-2);
  }
  function loadState() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      var state = raw ? JSON.parse(raw) : null;
      if (!state || state.day !== today()) state = { day: today(), seen: [], count: 0 };
      if (!Array.isArray(state.seen)) state.seen = [];
      if (typeof state.count !== 'number') state.count = 0;
      return state;
    } catch (error) {
      return { day: today(), seen: [], count: 0 };
    }
  }
  function saveState(state) {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (error) {
      /* private mode: rotation/caps just do not persist */
    }
  }

  var state = loadState();
  if (options.maxPerVisitor > 0 && state.count >= options.maxPerVisitor) {
    if (window.console && console.info) console.info('[adsrv] visitor cap reached for zone ' + zone);
    return;
  }

  // ------------------------------------------------------------------ DOM
  var container = document.createElement('div');
  container.className = 'adsrv-slot' + (options.className ? ' ' + options.className : '');
  container.setAttribute('data-adsrv-zone', String(zone));
  if (options.width > 0) container.style.maxWidth = options.width + 'px';
  container.style.width = '100%';
  container.style.lineHeight = '0';

  function showFallback() {
    container.style.display = 'none';
    if (!options.fallback) return;
    var nodes = document.querySelectorAll(options.fallback);
    for (var i = 0; i < nodes.length; i++) nodes[i].style.display = '';
  }

  var frames = [];

  function markServed(bannerId) {
    if (!bannerId) return;
    if (state.seen.indexOf(bannerId) === -1) state.seen.push(bannerId);
    while (state.seen.length > 20) state.seen.shift();
    state.count += 1;
    saveState(state);
  }

  function mount() {
    var target = options.target ? document.querySelector(options.target) : null;
    if (target) {
      target.appendChild(container);
    } else {
      script.parentNode.insertBefore(container, script.nextSibling);
    }
    if (options.mode === 'inline') {
      renderInline();
    } else {
      renderFrame();
    }
  }

  function renderFrame() {
    var frame = document.createElement('iframe');
    frame.title = 'Advertisement';
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('frameborder', '0');
    frame.setAttribute('loading', 'eager');
    frame.style.width = '100%';
    frame.style.height = (options.height > 0 ? options.height : 90) + 'px';
    frame.style.border = '0';
    frame.style.display = 'block';
    // Deliberately not sandboxed: the served document is ours, contains no
    // untrusted markup (creatives render in a nested sandboxed frame), and a
    // sandboxed outer frame would report origin "null" to postMessage.
    frame.src = serveUrl('iframe');
    container.appendChild(frame);
    frames.push({ win: frame.contentWindow, el: frame, opts: options });
  }

  function serveUrl(format) {
    var params = [
      'z=' + encodeURIComponent(zone),
      'w=' + encodeURIComponent(options.width || 0),
      'h=' + encodeURIComponent(options.height || 0),
      'u=' + encodeURIComponent(window.location.href),
      'cb=' + Math.floor(Math.random() * 1e9),
    ];
    if (format === 'json') params.push('format=json');
    if (options.resize) params.push('resize=1');
    if (state.seen.length) params.push('seen=' + state.seen.join(','));
    return origin + '/api/serve?' + params.join('&');
  }

  function renderInline() {
    var url = serveUrl('json');
    if (window.fetch) {
      fetch(url, { credentials: 'omit', mode: 'cors' })
        .then(function (response) {
          return response.ok ? response.json() : null;
        })
        .then(function (data) {
          if (!data || !data.ok || !data.banner) return showFallback();
          renderInlineBanner(data);
        })
        .catch(function () {
          showFallback();
        });
      return;
    }
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onload = function () {
      try {
        var data = JSON.parse(xhr.responseText);
        if (!data || !data.ok || !data.banner) return showFallback();
        renderInlineBanner(data);
      } catch (error) {
        showFallback();
      }
    };
    xhr.onerror = showFallback;
    xhr.send();
  }

  function renderInlineBanner(data) {
    var banner = data.banner;
    var link = document.createElement('a');
    link.href = banner.clickUrl;
    link.target = '_blank';
    link.rel = 'noopener nofollow sponsored';
    link.style.display = 'block';
    link.style.lineHeight = '0';

    if (banner.type === 'image' && banner.imageUrl) {
      var img = document.createElement('img');
      img.src = banner.imageUrl;
      img.alt = banner.alt || '';
      img.style.maxWidth = '100%';
      img.style.height = 'auto';
      img.style.display = 'block';
      link.appendChild(img);
    } else {
      link.textContent = banner.text || '';
      link.style.display = 'block';
      link.style.background = '#f4f6fb';
      link.style.border = '1px solid #d7deee';
      link.style.borderRadius = '8px';
      link.style.padding = '14px 18px';
      link.style.textAlign = 'center';
      link.style.color = '#0b3d91';
      link.style.font = '600 15px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
      link.style.lineHeight = '1.35';
      link.style.boxSizing = 'border-box';
    }

    container.style.lineHeight = 'normal';
    container.appendChild(link);
    markServed(banner.id);
  }

  // --------------------------------------------------------------- messages
  window.addEventListener('message', function (event) {
    if (event.origin !== origin) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;

    var entry = null;
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].win === event.source) {
        entry = frames[i];
        break;
      }
    }
    if (!entry) return;

    if (data.type === 'adsrv:info') {
      markServed(num(data.bannerId));
      if (entry.opts.resize && num(data.height) > 0) {
        entry.el.style.height = num(data.height) + 'px';
      }
      return;
    }
    if (data.type === 'adsrv:no-ad') showFallback();
  });

  // --------------------------------------------------------------- lifecycle
  function inViewport() {
    if (!options.lazy) return true;
    var rect = script.getBoundingClientRect();
    var margin = 300;
    return rect.top < (window.innerHeight || 800) + margin && rect.bottom > -margin;
  }

  function start() {
    if (!inViewport()) return false;
    mount();
    return true;
  }

  if (start()) return;

  if (window.IntersectionObserver) {
    var observer = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          observer.disconnect();
          mount();
          return;
        }
      }
    }, { rootMargin: '300px' });
    observer.observe(script);
    setTimeout(function () {
      observer.disconnect();
      if (!container.parentNode) mount();
    }, 15000);
    return;
  }

  window.addEventListener('scroll', function onScroll() {
    if (start()) window.removeEventListener('scroll', onScroll);
  });
})();
