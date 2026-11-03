// Adds a small corner arrow to every floating popup/panel (Twin HUD cards, Zero Scan
// overlays, modals) so it can be collapsed to just the arrow and reopened, like a website
// chat widget. Self-contained; panels are discovered with a MutationObserver because most
// of them are rendered dynamically.
(() => {
  const SEL = ['.wh-floor', '.wh-mini', '.wh-waste', '.inspect', '.lb-files', '.lb-done', '.lb-player',
    '.onboard', '.inspector', '.lens-modal', '.cctv-viewer', '.tb-scen.tb-pop'].join(',');
  const MODAL = '#modal-root';

  function sync(p, btn, min) {
    p.classList.toggle('hk-collapsed', min);
    btn.setAttribute('aria-expanded', String(!min));
    btn.title = min ? 'Expand' : 'Minimise';
    const root = p.closest(MODAL);
    if (root) root.classList.toggle('hk-min', !!root.querySelector('.hk-collapsed'));
  }

  function attach(p) {
    if (p.dataset.hkMin) return;
    p.dataset.hkMin = '1';
    if (getComputedStyle(p).position === 'static') p.classList.add('hk-rel');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hk-min-btn';
    btn.setAttribute('aria-label', 'Minimise panel');
    btn.innerHTML = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    btn.addEventListener('click', (e) => { e.stopPropagation(); sync(p, btn, !p.classList.contains('hk-collapsed')); });
    p.append(btn);
    sync(p, btn, false);
  }

  function scan(root) {
    if (root.nodeType !== 1) return;
    if (root.matches(SEL)) attach(root);
    root.querySelectorAll?.(SEL).forEach(attach);
  }

  function cleanupModal() {
    const root = document.querySelector(MODAL);
    if (root && !root.querySelector('.hk-collapsed')) root.classList.remove('hk-min');
  }

  // Twin only: collapse/expand the right sidebar and maximise the building view.
  function twinControls() {
    const layout = document.getElementById('layout'), wrap = document.getElementById('world-wrap');
    if (!layout || !wrap || !document.getElementById('sidebar')) return;
    const mk = (cls, label, svg) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = `tw-btn ${cls}`; b.setAttribute('aria-label', label); b.title = label; b.innerHTML = svg;
      return b;
    };
    const arrow = '<svg viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const fsIcon = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><g class="fs-in"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></g><g class="fs-out"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></g></svg>';
    const side = mk('tw-side', 'Hide side panel', arrow);
    const fs = mk('tw-fs', 'Maximize (F)', fsIcon);
    wrap.append(side, fs);

    side.addEventListener('click', () => {
      const off = layout.classList.toggle('side-off');
      side.setAttribute('aria-expanded', String(!off));
      side.title = side.ariaLabel = off ? 'Show side panel' : 'Hide side panel';
    });
    const toggleFs = () => {
      if (document.fullscreenElement === wrap) document.exitFullscreen?.();
      else (wrap.requestFullscreen || wrap.webkitRequestFullscreen)?.call(wrap);
    };
    fs.addEventListener('click', toggleFs);
    document.addEventListener('fullscreenchange', () => {
      const on = document.fullscreenElement === wrap;
      wrap.classList.toggle('is-fs', on);
      fs.title = fs.ariaLabel = on ? 'Exit full screen (F)' : 'Maximize (F)';
    });
    addEventListener('keydown', (e) => {
      if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !e.target.isContentEditable) toggleFs();
    });
  }

  const start = () => {
    twinControls();
    scan(document.body);
    new MutationObserver((muts) => {
      for (const m of muts) m.addedNodes.forEach(scan);
      cleanupModal();
      // re-append the button last if content was re-rendered into a panel
      document.querySelectorAll('[data-hk-min]').forEach((p) => {
        if (!p.querySelector(':scope > .hk-min-btn')) { delete p.dataset.hkMin; attach(p); }
      });
    }).observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) start(); else addEventListener('DOMContentLoaded', start);
})();
