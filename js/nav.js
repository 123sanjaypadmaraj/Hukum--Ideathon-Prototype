// Shared global navigation for the HUKUM pages (Twin, Zero Scan, Agents).
// Inserts a slim fixed tab strip at the very top of the page, shifts the page
// down by the strip height (html.has-gnav, see css/nav.css) and shows whether the
// agent backend is reachable (GET /api/health). Self-contained: no imports.
(() => {
  if (document.getElementById('gnav')) return;

  // A browser refresh (F5 / reload button) always returns to the start page.
  try {
    const nav0 = performance.getEntriesByType('navigation')[0];
    if (nav0 && nav0.type === 'reload') { location.replace('index.html'); return; }
  } catch (e) { /* ignore */ }


  const TABS = [
    { id: 'scan', label: 'Zero Scan', href: 'scan.html', title: 'HUKUM Zero Scan: build the building model' },
    { id: 'twin', label: 'Digital Twin', href: 'twin.html', title: 'Digital twin of the NHCE campus' },
    { id: 'agents', label: 'Agents', href: 'agents.html', title: 'Agent team control room' },
  ];

  function currentId() {
    const file = (location.pathname.split('/').pop() || '').toLowerCase();
    if (file.startsWith('scan')) return 'scan';
    if (file.startsWith('agents')) return 'agents';
    return 'twin';
  }

  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids) if (c != null) n.append(c);
    return n;
  }

  const active = currentId();
  const links = TABS.map((t) => el('a', {
    class: 'gnav-tab', href: t.href, role: 'tab', id: `gnav-${t.id}`, title: t.title,
    'aria-selected': t.id === active ? 'true' : 'false',
    'aria-current': t.id === active ? 'page' : null,
    tabindex: t.id === active ? '0' : '-1',
  }, t.label));

  const tablist = el('div', { class: 'gnav-tabs', role: 'tablist', 'aria-label': 'HUKUM pages' }, ...links);
  tablist.addEventListener('keydown', (e) => {
    const i = links.indexOf(document.activeElement);
    if (i < 0) return;
    let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % links.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + links.length) % links.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = links.length - 1;
    else if (e.key === ' ') { e.preventDefault(); links[i].click(); return; }
    if (j < 0) return;
    e.preventDefault();
    links.forEach((l, k) => l.setAttribute('tabindex', k === j ? '0' : '-1'));
    links[j].focus();
  });

  const dot = el('span', { class: 'gnav-dot', 'data-state': 'checking', 'aria-hidden': 'true' });
  const txt = el('span', { class: 'gnav-stat-text' }, 'checking backend');
  const status = el('div', { class: 'gnav-status', role: 'status', title: 'Checking the agent backend', tabindex: '0' }, dot, txt);

  const brand = el('a', { class: 'gnav-brand', href: 'index.html', 'aria-label': 'HUKUM home' },
    el('span', { class: 'gnav-logo', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')),
    el('span', { class: 'gnav-titles' },
      el('span', { class: 'gnav-word' }, 'HUKUM'),
      el('span', { class: 'gnav-motto' }, 'My Campus, My Power, My Control')));

  const nav = el('nav', { id: 'gnav', 'aria-label': 'Global' }, brand, tablist, el('div', { class: 'gnav-fill' }), status);
  document.documentElement.classList.add('has-gnav');
  document.body.prepend(nav);

  function setStatus(state, label, title) {
    dot.dataset.state = state;
    txt.textContent = label;
    status.title = title;
  }

  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctl && ctl.abort(), 3000);
  const health = fetch('/api/health', { signal: ctl ? ctl.signal : undefined, cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((j) => {
      if (!j || j.ok === false) throw new Error('backend not ready');
      const llm = j.llm || 'unknown model';
      setStatus('online', 'agents online', `Agent backend online. LLM: ${llm}`);
      return { ok: true, ...j };
    })
    .catch((err) => {
      setStatus('replay', 'replay mode', `Agent backend not reachable (${err && err.message ? err.message : 'offline'}). Pages that need it play a recorded run.`);
      return { ok: false, error: String(err && err.message || err) };
    })
    .finally(() => clearTimeout(timer));
  // Other scripts on the page can reuse the result instead of fetching again.
  window.__hukumHealth = health;
  health.then((h) => window.dispatchEvent(new CustomEvent('hukum:health', { detail: h })));
})();
