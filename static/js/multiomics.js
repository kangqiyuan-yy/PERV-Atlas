// Multi-omics BigWig track loader for Genome Browser.
// Provides a slide-in drawer where users can toggle .bw tracks per category.
// Depends on window.__pervBrowser (set by genome.js after igv.createBrowser).
(function () {
  // ---- colour palette per data type (default track colours) ----------------
  const CAT_COLOR = {
    'ATAC-seq': '#f97316',   // orange
    'ChIP-seq': '#8b5cf6',   // purple
    'RNA-seq':  '#0891b2',   // cyan-blue
    'WGBS':     '#dc2626',   // red
    'Hi-C':     '#6b7280',   // grey
  };
  function catColor(id) {
    return CAT_COLOR[id] || '#2563eb';
  }

  // ---- active track registry: key=file.url, val={name, trackObj} -----------
  const activeTracks = {};

  // Per-file autoscale state (default off = fixed scale)
  const autoscaleState = {};   // key=file.url, val=boolean

  // ---- helpers ---------------------------------------------------------------
  function fmtSize(bytes) {
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
    return (bytes / 1e3).toFixed(0) + ' KB';
  }
  function t(key, fallback) {
    try {
      // Project i18n singleton is exposed as window.I18n (see static/js/i18n.js).
      if (window.I18n && typeof window.I18n.t === 'function') {
        const v = window.I18n.t(key);
        // I18n.t returns the key itself when missing; fallback in that case.
        return v === key ? fallback : v;
      }
      return fallback;
    } catch (_) { return fallback; }
  }
  function autoscaleLabel(isOn) {
    return isOn
      ? t('gn.tracks.autoscale.auto', 'Auto')
      : t('gn.tracks.autoscale.fixed', 'Fixed');
  }
  function autoscaleTitle(isOn) {
    return isOn
      ? t('gn.tracks.autoscale.auto.tip', 'Y-axis: auto (rescales with view — click to fix)')
      : t('gn.tracks.autoscale.fixed.tip', 'Y-axis: fixed scale — click to enable autoscale');
  }

  // ---- drawer open / close --------------------------------------------------
  let drawerOpen = false;
  const drawer  = document.getElementById('g-tracks-drawer');
  const mask    = document.getElementById('g-tracks-mask');
  const toggleBtn = document.getElementById('g-tracks-toggle');
  const closeBtn  = document.getElementById('g-tracks-close');

  function openDrawer() {
    if (!drawer) return;
    drawerOpen = true;
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    if (mask) { mask.classList.add('open'); mask.setAttribute('aria-hidden', 'false'); }
    if (!indexLoaded) loadIndex();
  }
  function closeDrawer() {
    drawerOpen = false;
    if (drawer) { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); }
    if (mask)   { mask.classList.remove('open');   mask.setAttribute('aria-hidden', 'true'); }
  }

  if (toggleBtn) toggleBtn.addEventListener('click', () => drawerOpen ? closeDrawer() : openDrawer());
  if (closeBtn)  closeBtn.addEventListener('click', closeDrawer);
  if (mask)      mask.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerOpen) closeDrawer(); });

  // ---- load index from backend ----------------------------------------------
  let indexLoaded = false;

  async function loadIndex() {
    const body = document.getElementById('g-tracks-body');
    if (!body) return;
    body.innerHTML = `<div class="tracks-loading">${t('gn.tracks.loading', 'Loading…')}</div>`;
    try {
      const res = await fetch('/api/multiomics/index');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      indexLoaded = true;
      renderCategories(body, data.categories || []);
    } catch (err) {
      body.innerHTML = `<div class="tracks-empty" style="color:var(--orange);">Failed to load index: ${err.message}</div>`;
    }
  }

  // ---- render category accordion + file checkboxes -------------------------
  function renderCategories(container, categories) {
    if (!categories.length) {
      container.innerHTML = `<div class="tracks-empty">${t('gn.tracks.empty', 'No .bw files found in Multi-omics/')}</div>`;
      return;
    }
    container.innerHTML = '';
    for (const cat of categories) {
      const details = document.createElement('details');
      details.className = 'tracks-cat';
      if (cat.files.length > 0) details.open = false;

      const color = catColor(cat.id);
      const summary = document.createElement('summary');
      summary.innerHTML = `
        <span class="cat-left">
          <span class="cat-dot" style="background:${color};"></span>
          <span>${cat.label}</span>
        </span>
        <span style="display:flex;align-items:center;gap:6px;">
          <span class="cat-badge">${cat.files.length}</span>
          <span class="cat-caret">&#x276F;</span>
        </span>`;
      details.appendChild(summary);

      if (cat.files.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'tracks-empty';
        empty.textContent = t('gn.tracks.cat.empty', 'No files');
        details.appendChild(empty);
      } else {
        const list = document.createElement('div');
        list.className = 'tracks-file-list';
        for (const file of cat.files) {
          const item = document.createElement('div');
          item.className = 'tracks-file-item';
          item.title = file.filename;

          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.dataset.url = file.url;
          cb.dataset.name = file.name;
          cb.dataset.cat = cat.id;
          cb.dataset.color = color;
          cb.checked = !!activeTracks[file.url];
          cb.addEventListener('change', (e) => toggleTrack(file, cat.id, color, e.target));
          item.appendChild(cb);

          const nameSpan = document.createElement('span');
          nameSpan.className = 'tf-name';
          nameSpan.textContent = file.name;
          item.appendChild(nameSpan);

          const sizeSpan = document.createElement('span');
          sizeSpan.className = 'tf-size';
          sizeSpan.textContent = fmtSize(file.size);
          item.appendChild(sizeSpan);

          // Autoscale toggle button (default: off = fixed scale)
          const asBtn = document.createElement('span');
          const isOn = !!autoscaleState[file.url];
          asBtn.className = 'tf-autoscale' + (isOn ? ' on' : '');
          asBtn.textContent = autoscaleLabel(isOn);
          asBtn.title = autoscaleTitle(isOn);
          asBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const newState = !autoscaleState[file.url];
            autoscaleState[file.url] = newState;
            asBtn.className = 'tf-autoscale' + (newState ? ' on' : '');
            asBtn.textContent = autoscaleLabel(newState);
            asBtn.title = autoscaleTitle(newState);
            // If track is loaded, update its autoscale setting live
            const entry = activeTracks[file.url];
            if (entry && entry.trackObj) {
              entry.trackObj.autoscale = newState;
              try { entry.trackObj.updateViews && entry.trackObj.updateViews(); } catch (_) {}
            }
          });
          item.appendChild(asBtn);

          list.appendChild(item);
        }
        details.appendChild(list);
      }
      container.appendChild(details);
    }
  }

  // ---- add / remove track ---------------------------------------------------
  async function toggleTrack(file, catId, color, checkbox) {
    const br = window.__pervBrowser;
    if (!br) {
      alert('Genome browser not ready yet. Please wait and try again.');
      checkbox.checked = !checkbox.checked;
      return;
    }
    const label = checkbox.closest('.tracks-file-item');
    if (label) label.classList.add('loading');

    try {
      if (checkbox.checked) {
        const useAutoscale = !!autoscaleState[file.url];
        const track = await br.loadTrack({
          id: 'mo_' + file.url.replace(/[^a-z0-9]/gi, '_'),
          name: `${catId}: ${file.name}`,
          type: 'wig',
          format: 'bigwig',
          url: file.url,
          height: 60,
          autoscale: useAutoscale,   // default false = fixed scale, prevents rescale on pan
          color: color,
        });
        activeTracks[file.url] = { name: track ? (track.name || file.name) : file.name, trackObj: track };
      } else {
        const entry = activeTracks[file.url];
        const trackName = entry ? entry.name : null;
        if (trackName && br.removeTrackByName) {
          br.removeTrackByName(trackName);
        } else if (br.trackViews) {
          const tv = br.trackViews.find(
            tv => tv && tv.track && tv.track.url === file.url
          );
          if (tv && br.removeTrack) br.removeTrack(tv.track);
        }
        delete activeTracks[file.url];
      }
    } catch (err) {
      console.error('[multiomics] toggleTrack error:', err);
      checkbox.checked = !checkbox.checked;
    } finally {
      if (label) label.classList.remove('loading');
    }
  }

  // ---- expose for external reuse -------------------------------------------
  window.__pervMultiomics = { openDrawer, closeDrawer, loadIndex };

  // Re-render labels when language changes.
  document.addEventListener('i18nchange', () => {
    if (indexLoaded) loadIndex();
  });
})();
