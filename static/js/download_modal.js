// Multi-omics Visualization Download Modal
// Provides a dialog that lets users select a genomic region, choose BigWig
// tracks and annotation overlays, pick an output format, and trigger a
// server-side render (matplotlib) delivered as PDF / SVG / PNG.
(function () {
  'use strict';

  // ── i18n helper ────────────────────────────────────────────────────────────
  function t(key, fallback) {
    try {
      if (window.I18n && typeof window.I18n.t === 'function') {
        const v = window.I18n.t(key);
        return v === key ? fallback : v;
      }
    } catch (_) {}
    return fallback;
  }

  // ── Category colours (match multiomics.js) ─────────────────────────────────
  const CAT_COLOR = {
    'ATAC-seq': '#f97316',
    'ChIP-seq': '#8b5cf6',
    'RNA-seq':  '#0891b2',
    'WGBS':     '#dc2626',
    'Hi-C':     '#6b7280',
  };
  function catColor(id) { return CAT_COLOR[id] || '#10b981'; }

  // ── State ───────────────────────────────────────────────────────────────────
  let dlmRegion   = null;   // {chrom, start, end, name, length}
  let dlmSrc      = 'gene'; // current region source type
  let tracksLoaded = false;

  // PERV / homologous caches (loaded lazily when user clicks the tab)
  let pervCache     = null;
  let homoSeqCache  = null;
  let homoLocusCache = null;

  // Chromosome list cache (from /api/genome/chromosomes)
  let chromList = null;

  // ── DOM refs ────────────────────────────────────────────────────────────────
  const overlay      = document.getElementById('dlm-overlay');
  const openBtn      = document.getElementById('g-download-viz');
  const closeBtn     = document.getElementById('dlm-close');
  const cancelBtn    = document.getElementById('dlm-cancel');
  const generateBtn  = document.getElementById('dlm-generate');
  const errEl        = document.getElementById('dlm-err');
  const previewEl    = document.getElementById('dlm-preview');
  const previewText  = document.getElementById('dlm-preview-text');
  const tracksBody   = document.getElementById('dlm-tracks-body');
  const extendOn     = document.getElementById('dlm-extend-on');
  const extendFields = document.getElementById('dlm-extend-fields');

  if (!overlay) return; // genome not ready

  // ── Open / Close ────────────────────────────────────────────────────────────
  function openModal() {
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    if (!tracksLoaded) loadTracks();
    document.addEventListener('keydown', onKeyDown);
  }
  function closeModal() {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    setErr('');
    document.removeEventListener('keydown', onKeyDown);
  }
  function onKeyDown(e) {
    if (e.key === 'Escape') closeModal();
  }

  if (openBtn)   openBtn.addEventListener('click', openModal);
  if (closeBtn)  closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

  // ── Extension toggle ────────────────────────────────────────────────────────
  if (extendOn && extendFields) {
    extendOn.addEventListener('change', () => {
      if (extendOn.checked) extendFields.removeAttribute('hidden');
      else extendFields.setAttribute('hidden', '');
    });
  }

  // ── Region source tabs ──────────────────────────────────────────────────────
  const srcTabs = document.querySelectorAll('.dlm-src-tab');
  srcTabs.forEach((tab) => {
    tab.addEventListener('click', () => switchSrc(tab.dataset.src));
  });

  function switchSrc(src) {
    dlmSrc = src;
    // Update tab active state
    srcTabs.forEach((t) => {
      const isActive = t.dataset.src === src;
      t.classList.toggle('active', isActive);
      t.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    // Show/hide panels
    document.querySelectorAll('.dlm-src-panel').forEach((p) => {
      p.setAttribute('hidden', '');
    });
    const panel = document.getElementById('dlm-src-' + src);
    if (panel) panel.removeAttribute('hidden');

    // Lazy-load list data for specific types
    if (src === 'perv' && !pervCache) loadPervList();
    if (src === 'homo_seq' && !homoSeqCache) loadHomoSeqList();
    if (src === 'homo_locus' && !homoLocusCache) loadHomoLocusList();
    if ((src === 'custom' || src === 'position') && !chromList) loadChromList();

    // Clear region preview when switching source type
    clearPreview();
  }

  // ── Region preview ──────────────────────────────────────────────────────────
  function showPreview(region) {
    dlmRegion = region;
    if (previewEl) previewEl.removeAttribute('hidden');
    if (previewText) {
      const lenStr = region.length >= 1000
        ? (region.length / 1000).toFixed(1) + ' kb'
        : region.length + ' bp';
      previewText.textContent =
        `${region.chrom}:${region.start.toLocaleString()}–${region.end.toLocaleString()}`
        + `  (${lenStr})  ${region.name ? '· ' + region.name : ''}`;
    }
    setErr('');
  }
  function clearPreview() {
    dlmRegion = null;
    if (previewEl) previewEl.setAttribute('hidden', '');
    if (previewText) previewText.textContent = '';
  }

  // ── Error display ───────────────────────────────────────────────────────────
  function setErr(msg) {
    if (errEl) errEl.textContent = msg;
  }

  // ── Resolve region via API ──────────────────────────────────────────────────
  async function resolveRegion(params) {
    try {
      const qs = new URLSearchParams(params).toString();
      const res = await fetch('/api/download/resolve_region?' + qs);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } catch (err) {
      setErr(err.message);
      return null;
    }
  }

  // ── Gene / Transcript search autocomplete ───────────────────────────────────
  function setupSearchAutocomplete(inputId, resultsId, isTranscript) {
    const input   = document.getElementById(inputId);
    const results = document.getElementById(resultsId);
    if (!input || !results) return;

    let debTimer = null;
    input.addEventListener('input', () => {
      clearTimeout(debTimer);
      const q = input.value.trim();
      if (q.length < 2) { results.classList.remove('open'); return; }
      debTimer = setTimeout(() => fetchSuggestions(q, results, isTranscript), 280);
    });
    input.addEventListener('focus', () => {
      if (input.value.trim().length >= 2) results.classList.add('open');
    });
    document.addEventListener('click', (e) => {
      if (!input.contains(e.target) && !results.contains(e.target)) {
        results.classList.remove('open');
      }
    });
    // Keyboard navigation
    input.addEventListener('keydown', (e) => {
      const items = results.querySelectorAll('li[data-idx]');
      if (!items.length) return;
      const sel = results.querySelector('li.selected');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = sel ? sel.nextElementSibling : items[0];
        if (next) { sel && sel.classList.remove('selected'); next.classList.add('selected'); }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = sel ? sel.previousElementSibling : items[items.length - 1];
        if (prev) { sel && sel.classList.remove('selected'); prev.classList.add('selected'); }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const active = results.querySelector('li.selected') || items[0];
        if (active) active.click();
      } else if (e.key === 'Escape') {
        results.classList.remove('open');
      }
    });
  }

  async function fetchSuggestions(q, resultsEl, isTranscript) {
    resultsEl.innerHTML = `<li style="color:var(--muted);font-size:12px;padding:8px 12px;">${t('gn.dl_viz.loading', 'Loading…')}</li>`;
    resultsEl.classList.add('open');
    try {
      const res = await fetch(`/api/genome/search?q=${encodeURIComponent(q)}&limit=20`);
      const data = await res.json();
      let items = data.items || [];
      if (isTranscript) items = items.filter((i) => i.type === 'transcript');
      renderSuggestions(items, resultsEl);
    } catch (_) {
      resultsEl.classList.remove('open');
    }
  }

  function renderSuggestions(items, resultsEl) {
    if (!items.length) {
      resultsEl.innerHTML = '<li style="color:var(--muted);font-size:12px;padding:8px 12px;">No results</li>';
      return;
    }
    resultsEl.innerHTML = '';
    items.forEach((item, i) => {
      const li = document.createElement('li');
      li.dataset.idx = i;
      const pill = item.type === 'transcript' ? 'TX' : 'GENE';
      const name = item.gene_name || item.gene_id || item.transcript_id;
      const meta = item.transcript_id || item.gene_id;
      const loc = `${item.chrom}:${item.start.toLocaleString()}`;
      li.innerHTML = `
        <span class="dlm-ac-pill">${pill}</span>
        <span class="dlm-ac-name">${name}</span>
        <span class="dlm-ac-meta">${meta}</span>
        <span class="dlm-ac-meta">${loc}</span>`;
      li.addEventListener('click', async () => {
        resultsEl.classList.remove('open');
        const region = await resolveRegion({
          type: item.type === 'transcript' ? 'transcript' : 'gene',
          id: item.type === 'transcript' ? item.transcript_id : (item.gene_id || item.gene_name),
        });
        if (region) showPreview(region);
      });
      resultsEl.appendChild(li);
    });
  }

  setupSearchAutocomplete('dlm-gene-search', 'dlm-gene-results', false);
  setupSearchAutocomplete('dlm-tx-search', 'dlm-tx-results', true);

  // ── PERV list ───────────────────────────────────────────────────────────────
  async function loadPervList() {
    const listEl   = document.getElementById('dlm-perv-list');
    const filterEl = document.getElementById('dlm-perv-filter');
    if (!listEl) return;
    listEl.innerHTML = `<li class="dlm-list-loading">${t('gn.dl_viz.loading', 'Loading…')}</li>`;
    try {
      const res = await fetch('/api/genome/perv/list');
      const data = await res.json();
      pervCache = data.sequences || [];
      renderFilterList(pervCache, listEl, filterEl, (item) => ({
        label: item.name,
        meta: `${item.chrom}:${(item.start || 0).toLocaleString()}`,
        onClick: async () => {
          const region = await resolveRegion({ type: 'perv', id: item.name });
          if (region) showPreview(region);
        },
      }));
    } catch (err) {
      listEl.innerHTML = `<li class="dlm-list-empty">${err.message}</li>`;
    }
  }

  // ── Homologous sequence list ─────────────────────────────────────────────────
  async function loadHomoSeqList() {
    const listEl   = document.getElementById('dlm-homo-seq-list');
    const filterEl = document.getElementById('dlm-homo-seq-filter');
    if (!listEl) return;
    listEl.innerHTML = `<li class="dlm-list-loading">${t('gn.dl_viz.loading', 'Loading…')}</li>`;
    try {
      const res = await fetch('/api/genome/homologous/list');
      const data = await res.json();
      homoSeqCache = data.sequences || [];
      renderFilterList(homoSeqCache, listEl, filterEl, (item) => ({
        label: item.q_name,
        meta: `${item.chrom}:${(item.start || 0).toLocaleString()}`,
        onClick: async () => {
          const region = await resolveRegion({ type: 'homo_seq', id: item.q_name });
          if (region) showPreview(region);
        },
      }));
    } catch (err) {
      listEl.innerHTML = `<li class="dlm-list-empty">${err.message}</li>`;
    }
  }

  // ── Homologous locus list ────────────────────────────────────────────────────
  async function loadHomoLocusList() {
    const listEl   = document.getElementById('dlm-homo-locus-list');
    const filterEl = document.getElementById('dlm-homo-locus-filter');
    if (!listEl) return;
    listEl.innerHTML = `<li class="dlm-list-loading">${t('gn.dl_viz.loading', 'Loading…')}</li>`;
    try {
      const res = await fetch('/api/genome/homologous/loci');
      const data = await res.json();
      homoLocusCache = data.loci || [];
      renderFilterList(homoLocusCache, listEl, filterEl, (item) => ({
        label: item.locus_id,
        meta: `${item.chrom}:${(item.start || 0).toLocaleString()} (${item.count} seqs)`,
        onClick: async () => {
          const region = await resolveRegion({ type: 'homo_locus', id: item.locus_id });
          if (region) showPreview(region);
        },
      }));
    } catch (err) {
      listEl.innerHTML = `<li class="dlm-list-empty">${err.message}</li>`;
    }
  }

  // Generic filterable list renderer
  function renderFilterList(allItems, listEl, filterEl, itemDescFn) {
    function render(q) {
      const items = q
        ? allItems.filter((i) => JSON.stringify(i).toLowerCase().includes(q.toLowerCase()))
        : allItems;
      listEl.innerHTML = '';
      if (!items.length) {
        const li = document.createElement('li');
        li.className = 'dlm-list-empty';
        li.textContent = 'No matches';
        listEl.appendChild(li);
        return;
      }
      const frag = document.createDocumentFragment();
      items.slice(0, 200).forEach((item) => {
        const desc = itemDescFn(item);
        const li = document.createElement('li');
        const nameSpan = document.createElement('span');
        nameSpan.textContent = desc.label;
        li.appendChild(nameSpan);
        if (desc.meta) {
          const metaSpan = document.createElement('span');
          metaSpan.className = 'dlm-item-meta';
          metaSpan.textContent = desc.meta;
          li.appendChild(metaSpan);
        }
        li.addEventListener('click', () => {
          listEl.querySelectorAll('li').forEach((el) => el.classList.remove('selected'));
          li.classList.add('selected');
          desc.onClick();
        });
        frag.appendChild(li);
      });
      listEl.appendChild(frag);
    }

    render('');
    if (filterEl) {
      let timer = null;
      filterEl.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => render(filterEl.value.trim()), 200);
      });
    }
  }

  // ── Chromosome list (for custom / position panels) ───────────────────────────
  async function loadChromList() {
    try {
      const res = await fetch('/api/genome/chromosomes');
      const data = await res.json();
      chromList = (data.items || []).map((i) => i.name);
      ['dlm-custom-chrom', 'dlm-pos-chrom'].forEach((id) => {
        const sel = document.getElementById(id);
        if (!sel) return;
        chromList.forEach((name) => {
          const opt = document.createElement('option');
          opt.value = opt.textContent = name;
          sel.appendChild(opt);
        });
      });
    } catch (_) {}
  }

  // ── Custom region "Go" button ────────────────────────────────────────────────
  const customGoBtn = document.getElementById('dlm-custom-go');
  if (customGoBtn) {
    customGoBtn.addEventListener('click', async () => {
      const chrom = document.getElementById('dlm-custom-chrom').value;
      const start = parseInt(document.getElementById('dlm-custom-start').value, 10);
      const end   = parseInt(document.getElementById('dlm-custom-end').value, 10);
      if (!chrom) { setErr('Please select a chromosome'); return; }
      if (!start || !end || start < 1 || end < start) {
        setErr('Invalid coordinates: start must be ≥ 1 and end ≥ start');
        return;
      }
      const region = await resolveRegion({ type: 'custom', chrom, start, end });
      if (region) showPreview(region);
    });
  }

  // ── Single position "Go" button ──────────────────────────────────────────────
  const posGoBtn = document.getElementById('dlm-pos-go');
  if (posGoBtn) {
    posGoBtn.addEventListener('click', async () => {
      const chrom  = document.getElementById('dlm-pos-chrom').value;
      const pos    = parseInt(document.getElementById('dlm-pos-pos').value, 10);
      const window = parseInt(document.getElementById('dlm-pos-window').value, 10) || 10000;
      if (!chrom) { setErr('Please select a chromosome'); return; }
      if (!pos || pos < 1) { setErr('Invalid position'); return; }
      const region = await resolveRegion({ type: 'position', chrom, pos, window });
      if (region) showPreview(region);
    });
  }

  // ── BigWig track list ────────────────────────────────────────────────────────
  async function loadTracks() {
    if (!tracksBody) return;
    tracksBody.innerHTML = `<div class="dlm-loading">${t('gn.dl_viz.loading', 'Loading…')}</div>`;
    try {
      const res = await fetch('/api/multiomics/index');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      tracksLoaded = true;
      renderTracks(data.categories || []);
    } catch (err) {
      tracksBody.innerHTML = `<div class="dlm-tracks-empty" style="color:var(--orange);">Failed to load: ${err.message}</div>`;
    }
  }

  function renderTracks(categories) {
    if (!categories.length) {
      tracksBody.innerHTML = `<div class="dlm-tracks-empty">${t('gn.dl_viz.no_bw', 'No .bw files found')}</div>`;
      return;
    }
    tracksBody.innerHTML = '';
    for (const cat of categories) {
      const details = document.createElement('details');
      details.className = 'dlm-tracks-cat';
      const color = catColor(cat.id);
      const summary = document.createElement('summary');
      summary.innerHTML = `
        <span class="dlm-cat-left">
          <span class="dlm-cat-dot" style="background:${color};"></span>
          <span>${cat.label}</span>
        </span>
        <span style="display:flex;align-items:center;gap:6px;">
          <span class="dlm-cat-badge">${cat.files.length}</span>
          <span class="dlm-cat-caret">&#x276F;</span>
        </span>`;
      details.appendChild(summary);

      if (!cat.files.length) {
        const empty = document.createElement('div');
        empty.className = 'dlm-tracks-empty';
        empty.textContent = 'No files';
        details.appendChild(empty);
      } else {
        details.open = true;
        const list = document.createElement('div');
        list.className = 'dlm-file-list';
        for (const file of cat.files) {
          const item  = document.createElement('div');
          item.className = 'dlm-file-item';
          item.title = file.filename;

          const cb = document.createElement('input');
          cb.type = 'checkbox';
          // Store relative path: "category/filename.bw"
          cb.value = `${cat.id}/${file.filename}`;
          item.appendChild(cb);

          const nameSpan = document.createElement('span');
          nameSpan.className = 'dlm-fname';
          nameSpan.textContent = file.name;
          item.appendChild(nameSpan);

          const sizeSpan = document.createElement('span');
          sizeSpan.className = 'dlm-fsize';
          sizeSpan.textContent = fmtSize(file.size);
          item.appendChild(sizeSpan);

          item.addEventListener('click', (e) => {
            if (e.target !== cb) cb.checked = !cb.checked;
          });
          list.appendChild(item);
        }
        details.appendChild(list);
      }
      tracksBody.appendChild(details);
    }
  }

  function fmtSize(bytes) {
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
    return (bytes / 1e3).toFixed(0) + ' KB';
  }

  // ── Collect selections ───────────────────────────────────────────────────────
  function getSelectedTracks() {
    return Array.from(document.querySelectorAll('#dlm-tracks-body input[type="checkbox"]:checked'))
      .map((cb) => cb.value);
  }

  function getSelectedAnnot() {
    return Array.from(document.querySelectorAll('input[name="dlm-annot"]:checked'))
      .map((cb) => cb.value);
  }

  function getFormat() {
    const checked = document.querySelector('input[name="dlm-fmt"]:checked');
    return checked ? checked.value : 'pdf';
  }

  // ── Generate & Download ──────────────────────────────────────────────────────
  if (generateBtn) {
    generateBtn.addEventListener('click', generate);
  }

  async function generate() {
    setErr('');

    if (!dlmRegion) {
      setErr(t('gn.dl_viz.err.no_region', 'Please select a region first'));
      return;
    }

    const bwTracks = getSelectedTracks();
    if (!bwTracks.length) {
      setErr(t('gn.dl_viz.err.no_tracks', 'Please select at least one multi-omics track'));
      return;
    }

    const upstream   = extendOn && extendOn.checked ? (parseInt(document.getElementById('dlm-upstream').value, 10) || 0) : 0;
    const downstream = extendOn && extendOn.checked ? (parseInt(document.getElementById('dlm-downstream').value, 10) || 0) : 0;

    const span = dlmRegion.end - dlmRegion.start + 1 + upstream + downstream;
    if (span > 10_000_000) {
      setErr(t('gn.dl_viz.err.too_large', 'Region too large (>10 Mb). Reduce the range or extension.'));
      return;
    }

    const body = {
      chrom:        dlmRegion.chrom,
      start:        dlmRegion.start,
      end:          dlmRegion.end,
      upstream,
      downstream,
      bw_tracks:    bwTracks,
      annot_tracks: getSelectedAnnot(),
      format:       getFormat(),
    };

    generateBtn.disabled = true;
    generateBtn.textContent = t('gn.dl_viz.generating', 'Generating…');

    try {
      const res = await fetch('/api/download/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      // Infer filename from Content-Disposition if present
      const cd = res.headers.get('Content-Disposition') || '';
      const fnMatch = cd.match(/filename="([^"]+)"/);
      const filename = fnMatch ? fnMatch[1] : `multiomics_${dlmRegion.chrom}_${dlmRegion.start}.${body.format}`;

      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);

      closeModal();
    } catch (err) {
      setErr(err.message);
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = t('gn.dl_viz.generate', 'Generate & Download');
    }
  }

  // ── Re-apply i18n when language switches ─────────────────────────────────────
  document.addEventListener('i18nchange', () => {
    // Placeholder texts are handled by I18n.apply() via data-i18n-ph
    // Button text for generate is dynamic; only reset when not generating
    if (generateBtn && !generateBtn.disabled) {
      generateBtn.textContent = t('gn.dl_viz.generate', 'Generate & Download');
    }
  });

  // ── Expose for external access if needed ─────────────────────────────────────
  window.__pervDownloadModal = { openModal, closeModal };
})();
