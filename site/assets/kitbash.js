  document.documentElement.classList.add('js');

  // theme
  (() => {
    const key = 'kitbash-theme';
    const root = document.documentElement;
    const stored = localStorage.getItem(key);
    const preferred = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    const apply = (t) => {
      root.dataset.theme = t;
      document.querySelector('[data-theme-toggle]')?.setAttribute('aria-pressed', String(t === 'dark'));
    };
    apply(stored || preferred);
    document.querySelector('[data-theme-toggle]')?.addEventListener('click', () => {
      const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem(key, next);
      apply(next);
    });
  })();

  // hide header on scroll down
  (() => {
    const header = document.querySelector('[data-header]');
    if (!header) return;
    let lastY = window.scrollY, ticking = false;
    const update = () => {
      const y = window.scrollY;
      if (header.classList.contains('menu-open')) { lastY = y; ticking = false; return; }
      if (y <= 60) header.classList.remove('header-hidden');
      else if (y > lastY) header.classList.add('header-hidden');
      else header.classList.remove('header-hidden');
      lastY = y; ticking = false;
    };
    window.addEventListener('scroll', () => { if (!ticking) { requestAnimationFrame(update); ticking = true; } }, { passive: true });
  })();

  // mobile menu
  (() => {
    const header = document.querySelector('[data-header]');
    const toggle = document.querySelector('[data-mobile-menu-toggle]');
    const backdrop = document.querySelector('[data-mobile-backdrop]');
    const menu = document.querySelector('[data-mobile-menu]');
    const close = () => { header?.classList.remove('menu-open'); toggle?.setAttribute('aria-expanded', 'false'); };
    const open = () => { header?.classList.add('menu-open'); toggle?.setAttribute('aria-expanded', 'true'); };
    toggle?.addEventListener('click', () => header?.classList.contains('menu-open') ? close() : open());
    backdrop?.addEventListener('click', close);
    menu?.querySelectorAll('a').forEach((a) => a.addEventListener('click', close));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  })();

  // live terminal replay
  (() => {
    const pre = document.querySelector('.term-body');
    const replay = document.querySelector('[data-replay]');
    if (!pre || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // Flatten the authored terminal content into per-character tokens so the
    // static markup stays the single source of truth (and the no-JS fallback).
    const finalNodes = Array.from(pre.childNodes).map((n) => n.cloneNode(true));
    const tokens = [];
    for (const n of finalNodes) {
      const cls = n.nodeType === 1 ? n.className : '';
      for (const ch of n.textContent) tokens.push({ cls, ch });
    }
    // A line is a "command" when it opens with the prompt span ($).
    const delays = [];
    let lineStart = true, cmdLine = false;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (lineStart) {
        cmdLine = t.cls === 'p';
        delays.push(cmdLine && i > 0 ? 650 : i === 0 ? 300 : 110);
      } else {
        delays.push(cmdLine ? 26 + Math.random() * 44 : 0);
      }
      if (t.ch === '\n') { lineStart = true; if (cmdLine) delays[i] += 420; }
      else lineStart = false;
    }

    // Lock in the final rendered height before any playback clears the
    // content, so the page below the terminal never shifts during the replay.
    const reserve = () => { pre.style.minHeight = ''; pre.style.minHeight = pre.offsetHeight + 'px'; };
    reserve();
    let resizeT = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => { if (!playing) reserve(); }, 150);
    });

    let timer = 0, playing = false;
    const finish = () => {
      clearTimeout(timer); playing = false;
      pre.textContent = '';
      finalNodes.forEach((n) => pre.appendChild(n.cloneNode(true)));
      const c = document.createElement('span');
      c.className = 'term-cursor';
      pre.appendChild(c);
      replay?.removeAttribute('hidden');
    };
    const play = () => {
      clearTimeout(timer); playing = true;
      pre.textContent = '';
      const cursor = document.createElement('span');
      cursor.className = 'term-cursor';
      pre.appendChild(cursor);
      let span = null, spanCls = null, i = 0;
      const step = () => {
        while (i < tokens.length && delays[i] === 0) put(tokens[i++]);
        if (i >= tokens.length) { playing = false; replay?.removeAttribute('hidden'); return; }
        timer = setTimeout(() => { put(tokens[i++]); step(); }, delays[i]);
      };
      const put = (t) => {
        if (!span || spanCls !== t.cls) {
          span = document.createElement('span');
          if (t.cls) span.className = t.cls;
          spanCls = t.cls;
          pre.insertBefore(span, cursor);
        }
        span.textContent += t.ch;
      };
      step();
    };

    pre.addEventListener('click', () => { if (playing) finish(); });
    replay?.addEventListener('click', () => { replay.setAttribute('hidden', ''); play(); });

    if ('IntersectionObserver' in window) {
      pre.textContent = '';
      const io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) { io.disconnect(); play(); }
      }, { threshold: 0.35 });
      io.observe(pre);
    }
  })();

  // compile-target tabs
  (() => {
    const rail = document.querySelector('[data-target-tabs]');
    if (!rail) return;
    const tabs = Array.from(rail.querySelectorAll('[data-tab]'));
    const panes = Array.from(document.querySelectorAll('[data-pane]'));
    const select = (id) => {
      tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === id)));
      panes.forEach((p) => p.toggleAttribute('hidden', p.dataset.pane !== id));
    };
    tabs.forEach((t) => t.addEventListener('click', () => select(t.dataset.tab)));
    rail.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const cur = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
      const next = (cur + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
      tabs[next].focus(); select(tabs[next].dataset.tab);
    });
  })();

  // scroll reveal
  (() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
    const els = document.querySelectorAll('.section-header, .fmt, .feature, .skill, .doc-link, .install-strip, .pipeline, .target-pane:not([hidden]), .target-tabs');
    let batch = 0;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.style.transitionDelay = `${Math.min(batch++ % 6, 5) * 55}ms`;
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
      batch = 0;
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    els.forEach((el) => { el.classList.add('rv'); io.observe(el); });
  })();

  // copy buttons on marked code
  (() => {
    document.querySelectorAll('pre.copyable').forEach((pre) => {
      const btn = document.createElement('button');
      btn.className = 'copy-code-button';
      btn.type = 'button';
      btn.textContent = 'Copy';
      pre.parentElement?.appendChild(btn);
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(pre.textContent || '');
          btn.textContent = 'Copied';
        } catch { btn.textContent = 'Failed'; }
        setTimeout(() => (btn.textContent = 'Copy'), 1300);
      });
    });
  })();

  // docs: mobile sidebar toggle
  (() => {
    const btn = document.querySelector('[data-docs-nav-toggle]');
    const nav = document.querySelector('[data-docs-nav]');
    if (!btn || !nav) return;
    const mq = window.matchMedia('(max-width: 860px)');
    const sync = () => nav.toggleAttribute('hidden', mq.matches);
    sync();
    mq.addEventListener('change', sync);
    btn.addEventListener('click', () => nav.toggleAttribute('hidden'));
  })();

  // docs: build the on-this-page rail from real headings + scrollspy
  (() => {
    const toc = document.querySelector('[data-toc]');
    const scope = document.querySelector('.prose');
    if (!toc || !scope) return;
    const heads = Array.from(scope.querySelectorAll('h2[id], h3[id]'));
    if (heads.length < 2) { toc.remove(); return; }

    const frag = document.createDocumentFragment();
    const label = document.createElement('strong');
    label.textContent = 'On this page';
    frag.appendChild(label);
    for (const h of heads) {
      const a = document.createElement('a');
      a.href = `#${h.id}`;
      a.textContent = (h.textContent || '').replace('#', '').trim();
      if (h.tagName === 'H3') a.className = 'lvl3';
      frag.appendChild(a);
    }
    toc.appendChild(frag);

    const links = new Map(Array.from(toc.querySelectorAll('a')).map((a) => [a.getAttribute('href').slice(1), a]));
    if (!('IntersectionObserver' in window)) return;
    let active = null;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const link = links.get(e.target.id);
        if (!link || link === active) continue;
        active?.classList.remove('active');
        link.classList.add('active');
        active = link;
      }
    }, { rootMargin: '-80px 0px -70% 0px', threshold: 0 });
    heads.forEach((h) => io.observe(h));
  })();

  // docs: clickable anchors on headings
  (() => {
    document.querySelectorAll('.prose h2[id], .prose h3[id]').forEach((h) => {
      if (h.querySelector('.anchor')) return;
      const a = document.createElement('a');
      a.className = 'anchor';
      a.href = `#${h.id}`;
      a.textContent = '#';
      a.setAttribute('aria-label', `Link to ${h.textContent.trim()}`);
      h.appendChild(a);
    });
  })();
