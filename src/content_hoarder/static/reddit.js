/* Reddit Saved Manager — vanilla JS frontend */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let debounceTimer = null;
  let selectedFullname = null;
  const PAGE_SIZE = 100;
  let offset = 0;            // how many rows already loaded
  let hasMore = true;        // server says more pages exist
  let loading = false;       // a fetch is in flight
  let reqSeq = 0;            // monotonically increasing request id (newest wins)
  // Default: newest-synced first. Reddit gives no save timestamp, but the cookie sync ingests
  // saved.json newest-saved-first, so first_seen_utc is the closest stable proxy for save order.
  let sortKey = 'first_seen_utc';
  let sortOrder = 'desc';     // 'asc' | 'desc'
  let viewMode = localStorage.getItem('ch_reddit_view') || 'table';  // 'table' | 'grid'
  let allSubs = [];          // cached subreddit list for the sidebar

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const searchInput    = $('search-input');
  const filterFuzzy    = $('filter-fuzzy');
  const filterKind     = $('filter-kind');
  const filterSaved    = $('filter-saved');
  const filterSub      = $('filter-subreddit');
  const sortSelect     = $('sort-select');
  const itemsPanel     = $('items-panel');
  const itemsBody      = $('items-body');
  const itemsTable     = $('items-table');
  const itemsGrid      = $('items-grid');
  const loadingMore    = $('items-loading-more');
  const detailPanel    = $('detail-panel');
  const postSummary    = $('post-summary');
  const commentsList   = $('comments-list');
  const commentsHead   = $('comments-heading');
  const detailPermalink= $('detail-permalink');
  const closeDetail    = $('close-detail');
  const syncBtn        = $('btn-sync');
  const syncStatus     = $('sync-status');
  const importFile     = $('import-file');
  const importStatus   = $('import-status');
  const exportFormat   = $('export-format');
  const exportLink     = $('export-link');
  const viewToggle     = $('view-toggle');
  const btnStats       = $('btn-stats');
  const statsModal     = $('stats-modal');
  const statsContent   = $('stats-content');
  const statsClose     = $('stats-close');
  const sidebar        = $('subreddit-sidebar');
  const sidebarFilter  = $('sidebar-filter');
  const subredditList  = $('subreddit-list');
  const sidebarToggle  = $('sidebar-toggle');

  // The container the current view renders into.
  function activeContainer() { return viewMode === 'grid' ? itemsGrid : itemsBody; }

  // ── Counts ─────────────────────────────────────────────────────────────────
  // The Reddit view uses content-hoarder's triage model (inbox/keep/archived/done),
  // not RSM's saved/unsaved, so header counts come from /reddit/stats.
  function loadHeaderCounts() {
    fetch('/reddit/stats')
      .then(r => r.json())
      .then(d => {
        const st = d.by_status || {};
        const set = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
        set('count-total', (d.total || 0) + ' total');
        set('count-inbox', (st.inbox || 0) + ' inbox');
        set('count-archived', (st.archived || 0) + ' archived');
      })
      .catch(() => {});
  }

  // ── Load items ─────────────────────────────────────────────────────────────
  function buildParams() {
    const params = new URLSearchParams();
    const q = searchInput.value.trim();
    if (q) params.set('q', q);
    if (filterFuzzy && filterFuzzy.checked) params.set('fuzzy', '1');
    if (filterKind.value)   params.set('kind', filterKind.value);
    if (filterSaved.value !== '') params.set('is_saved', filterSaved.value);
    const sub = filterSub.value.trim().replace(/^r\//, '');
    if (sub) params.set('subreddit', sub);
    if (sortKey) { params.set('sort', sortKey); params.set('order', sortOrder); }
    params.set('limit', PAGE_SIZE);
    params.set('offset', offset);
    return params;
  }

  function loadItems() {
    offset = 0;
    hasMore = true;
    loadPage(true);
  }

  // replace=true resets the list; replace=false appends. A 'replace' supersedes an
  // in-flight request; each request carries a seq so stale responses are dropped.
  function loadPage(replace) {
    if (loading && !replace) return;
    loading = true;
    const seq = ++reqSeq;
    loadingMore.style.display = (!replace && hasMore) ? 'block' : 'none';

    fetch('/reddit/items?' + buildParams().toString())
      .then(r => r.json())
      .then(data => {
        if (seq !== reqSeq) return;
        const items = data.items || [];
        renderItems(items, !replace);
        hasMore = !!data.has_more;
        offset += items.length;
        loading = false;
        loadingMore.style.display = 'none';
        maybeLoadMore();
      })
      .catch(err => {
        if (seq !== reqSeq) return;
        loading = false;
        loadingMore.style.display = 'none';
        if (replace) {
          activeContainer().innerHTML = emptyMsg('Error loading items: ' + esc(err.message));
        }
      });
  }

  function maybeLoadMore() {
    if (loading || !hasMore) return;
    const nearBottom = itemsPanel.scrollTop + itemsPanel.clientHeight >= itemsPanel.scrollHeight - 300;
    const notScrollable = itemsPanel.scrollHeight <= itemsPanel.clientHeight;
    if (nearBottom || notScrollable) loadPage(false);
  }

  function debounceLoad() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadItems, 200);
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  function emptyMsg(text) {
    return viewMode === 'grid'
      ? `<div class="empty-msg">${text}</div>`
      : `<tr><td colspan="6" class="empty-msg">${text}</td></tr>`;
  }

  function itemHtml(item) { return viewMode === 'grid' ? cardHtml(item) : rowHtml(item); }

  function renderItems(items, append) {
    const container = activeContainer();
    if (!append) container.innerHTML = '';
    if (!items.length) {
      if (!append) container.innerHTML = emptyMsg('No items found.');
      return;
    }
    container.insertAdjacentHTML('beforeend', items.map(itemHtml).join(''));
  }

  function rowHtml(item) {
    const isUnsaved = !item.is_saved;
    const title = item.title || item.body || '(no text)';
    const short = title.length > 90 ? title.slice(0, 90) + '…' : title;
    const kindClass = item.kind === 'post' ? 'kind-post' : 'kind-comment';
    const rowClass = [
      isUnsaved ? 'unsaved-row' : '',
      item.fullname === selectedFullname ? 'selected-row' : '',
    ].filter(Boolean).join(' ');
    const media = mediaType(item);
    const nsfw = item.over_18 ? '<span class="nsfw-tag" title="NSFW">🔞</span>' : '';

    return `<tr data-fullname="${esc(item.fullname)}" class="${rowClass}">
      <td class="item-title" title="${esc(title)}">
        <span class="media-badge media-${media.cls}" title="${esc(media.label)}">${media.icon}</span>
        ${nsfw}<a href="${esc(item.permalink)}" target="_blank">${esc(short)}</a>
      </td>
      <td><span class="kind-badge ${kindClass}">${esc(item.kind)}</span></td>
      <td title="${esc(item.subreddit)}">r/${esc(item.subreddit)}</td>
      <td title="${esc(item.author)}">u/${esc(item.author)}</td>
      <td class="num">${item.score ? esc(item.score) : ''}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-ghost btn-sm" onclick="openThread('${esc(item.fullname)}')">Thread</button>
          ${isUnsaved
            ? `<button class="btn btn-ghost btn-sm" onclick="doUndo('${esc(item.fullname)}')">Undo</button>`
            : `<button class="btn btn-danger btn-sm" onclick="doUnsave('${esc(item.fullname)}')">Unsave</button>`
          }
        </div>
      </td>
    </tr>`;
  }

  function cardHtml(item) {
    const isUnsaved = !item.is_saved;
    const title = item.title || item.body || '(no text)';
    const media = mediaType(item);
    const cls = ['card', isUnsaved ? 'unsaved-row' : '',
                 item.fullname === selectedFullname ? 'selected-row' : ''].filter(Boolean).join(' ');
    const score = item.score ? ` · ▲${esc(item.score)}` : '';
    return `<div class="${cls}" data-fullname="${esc(item.fullname)}">
      ${mediaHtml(item)}
      <div class="card-body">
        <div class="card-title">
          <span class="media-badge media-${media.cls}" title="${esc(media.label)}">${media.icon}</span>
          <a href="${esc(item.permalink)}" target="_blank" title="${esc(title)}">${esc(title.slice(0, 140))}</a>
        </div>
        <div class="card-meta">r/${esc(item.subreddit)} · u/${esc(item.author)}${score}</div>
        <div class="action-btns">
          <button class="btn btn-ghost btn-sm" onclick="openThread('${esc(item.fullname)}')">Thread</button>
          ${isUnsaved
            ? `<button class="btn btn-ghost btn-sm" onclick="doUndo('${esc(item.fullname)}')">Undo</button>`
            : `<button class="btn btn-danger btn-sm" onclick="doUnsave('${esc(item.fullname)}')">Unsave</button>`
          }
        </div>
      </div>
    </div>`;
  }

  // Inline media: images and direct video only. Gallery / v.redd.it / YouTube have no
  // directly-embeddable URL stored, so they fall back to the title link-out.
  function mediaHtml(item) {
    const url = item.url || '';
    if (!url) return '';
    const m = mediaType(item);
    let inner = '';
    if (m.cls === 'image') {
      inner = `<img loading="lazy" src="${esc(url)}" alt="">`;
    } else if (m.cls === 'video' && /\.(mp4|webm)(\?|$)/i.test(url)) {
      inner = `<video controls preload="none" src="${esc(url)}"></video>`;
    } else {
      return '';
    }
    const nsfwCls = item.over_18 ? ' nsfw' : '';
    const overlay = item.over_18 ? '<div class="nsfw-overlay">🔞 Show NSFW</div>' : '';
    return `<div class="card-media${nsfwCls}">${inner}${overlay}</div>`;
  }

  // ── Unsave / Undo ──────────────────────────────────────────────────────────
  window.doUnsave = function (fullname) {
    fetch(`/reddit/items/${encodeURIComponent(fullname)}/unsave`, { method: 'POST' })
      .then(r => r.json())
      .then(data => {
        if (data.error) { alert('Unsave failed: ' + data.error); return; }
        loadItems();
        loadHeaderCounts();
      });
  };

  window.doUndo = function (fullname) {
    fetch(`/reddit/items/${encodeURIComponent(fullname)}/undo`, { method: 'POST' })
      .then(r => r.json())
      .then(data => {
        if (data.error) { alert('Undo failed: ' + data.error); return; }
        // A live re-save (already drained to Reddit) can genuinely fail — report it
        // instead of silently treating it as success.
        if (data.undone === false) {
          alert('Could not re-save on Reddit — your reddit_session cookie may have expired.');
          return;
        }
        loadItems();
        loadHeaderCounts();
      });
  };

  // ── Thread view ────────────────────────────────────────────────────────────
  window.openThread = function (fullname) {
    selectedFullname = fullname;
    detailPanel.style.display = 'flex';
    postSummary.innerHTML     = '<div id="detail-loading">Loading thread…</div>';
    commentsList.innerHTML    = '';
    commentsHead.style.display = 'none';
    detailPermalink.href = '#';

    fetch(`/reddit/items/${encodeURIComponent(fullname)}/thread`)
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          postSummary.innerHTML = `<p style="color:#c66">Error: ${esc(data.error)}</p>`;
          return;
        }
        renderThread(data);
        activeContainer().querySelectorAll('[data-fullname]').forEach(el => {
          el.classList.toggle('selected-row', el.dataset.fullname === fullname);
        });
      })
      .catch(err => {
        postSummary.innerHTML = `<p style="color:#c66">Network error: ${esc(err.message)}</p>`;
      });
  };

  function renderThread(data) {
    const post = data.post || {};
    const comments = data.comments || [];
    const permalink = post.permalink || '';

    if (permalink) detailPermalink.href = permalink;
    renderArchiveLinks(permalink);  /* [ARCHIVAL] */

    const mediaPreview = mediaHtml({ url: post.url, kind: 'post', over_18: post.over_18 });
    const bodyHtml = post.selftext ? `<div class="post-body">${esc(post.selftext)}</div>` : '';

    postSummary.innerHTML = `
      <h2>${esc(post.title || '(comment thread)')}</h2>
      <div class="post-meta">
        r/${esc(post.subreddit || '')} · u/${esc(post.author || '')} ·
        <a href="${esc(permalink)}" target="_blank">open ↗</a>
      </div>
      ${mediaPreview}
      ${bodyHtml}
    `;

    if (comments.length) {
      commentsHead.style.display = '';
      commentsHead.textContent = `Comments (${comments.length})`;
      commentsList.innerHTML = comments.map(c => `
        <div class="comment-item" style="--depth:${Math.min(c.depth, 8)}">
          <div class="comment-meta">
            u/${esc(c.author)} · score: ${esc(c.score)}
            <a href="${esc(c.permalink)}" target="_blank">↗</a>
          </div>
          <div class="comment-body">${esc(c.body)}</div>
        </div>
      `).join('');
    } else {
      commentsHead.style.display = 'none';
      commentsList.innerHTML = '<p style="color:#555;font-size:12px">No comments loaded.</p>';
    }
  }

  function closeDetailPanel() {
    detailPanel.style.display = 'none';
    selectedFullname = null;
    activeContainer().querySelectorAll('[data-fullname]').forEach(el => el.classList.remove('selected-row'));
  }
  closeDetail.addEventListener('click', closeDetailPanel);

  // ── NSFW click-to-reveal (event delegation) ──────────────────────────────────
  document.addEventListener('click', e => {
    const overlay = e.target.closest('.nsfw-overlay');
    if (overlay) {
      const media = overlay.closest('.card-media');
      if (media) { media.classList.remove('nsfw'); overlay.remove(); }
    }
  });

  // ── Sync ───────────────────────────────────────────────────────────────────
  if (syncBtn) {
    syncBtn.addEventListener('click', () => {
      syncBtn.disabled = true;
      syncStatus.textContent = 'Syncing newest…';
      fetch('/reddit/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
        .then(r => r.json())
        .then(data => {
          if (data.auth_error) {
            syncStatus.textContent = 'Sync needs a reddit_session cookie — set it up first.';
          } else if (data.error) {
            syncStatus.textContent = 'Error: ' + data.error;
          } else {
            syncStatus.textContent =
              '+' + data.new + ' new (' + data.fetched + ' fetched, ' + data.pages + 'p, ' + data.stopped + ').';
            loadItems();
            loadHeaderCounts();
            loadSubreddits();
          }
          syncBtn.disabled = false;
        })
        .catch(() => { syncStatus.textContent = 'Network error.'; syncBtn.disabled = false; });
    });
  }

  // ── Import ─────────────────────────────────────────────────────────────────
  if (importFile) {
    importFile.addEventListener('change', () => {
      const file = importFile.files[0];
      if (!file) return;
      importStatus.textContent = 'Importing…';
      const fd = new FormData();
      fd.append('file', file);
      fetch('/import', { method: 'POST', body: fd })
        .then(r => r.json())
        .then(data => {
          if (data.error) {
            importStatus.textContent = 'Error: ' + data.error;
          } else {
            importStatus.textContent = `Imported ${data.imported} items.`;
            loadItems();
            loadSubreddits();
          }
          importFile.value = '';
        })
        .catch(() => { importStatus.textContent = 'Network error.'; });
    });
  }

  // ── Export link ──────────────────────────────────────────────────────────────
  if (exportFormat && exportLink) {
    exportFormat.addEventListener('change', () => {
      exportLink.href = '/export?format=' + exportFormat.value;
    });
  }

  // ── Filter/search events ───────────────────────────────────────────────────
  searchInput.addEventListener('input', debounceLoad);
  if (filterFuzzy) filterFuzzy.addEventListener('change', loadItems);
  filterKind.addEventListener('change', loadItems);
  filterSaved.addEventListener('change', () => { loadItems(); loadSubreddits(); });
  filterSub.addEventListener('input', debounceLoad);

  // ── Infinite scroll ──────────────────────────────────────────────────────────
  itemsPanel.addEventListener('scroll', maybeLoadMore);

  // ── View toggle (table / grid) ────────────────────────────────────────────────
  function applyView() {
    itemsTable.style.display = viewMode === 'grid' ? 'none' : '';
    itemsGrid.style.display  = viewMode === 'grid' ? '' : 'none';
    if (viewToggle) {
      viewToggle.querySelectorAll('button').forEach(b =>
        b.classList.toggle('active', b.dataset.view === viewMode));
    }
  }
  if (viewToggle) {
    viewToggle.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        if (viewMode === b.dataset.view) return;
        viewMode = b.dataset.view;
        localStorage.setItem('ch_reddit_view', viewMode);
        applyView();
        loadItems();
      });
    });
  }

  // ── Column sorting ───────────────────────────────────────────────────────────
  function updateSortIndicators() {
    document.querySelectorAll('#items-table th.sortable').forEach(th => {
      const ind = th.querySelector('.sort-ind');
      if (th.dataset.sort === sortKey) {
        ind.textContent = sortOrder === 'asc' ? ' ▲' : ' ▼';
        th.classList.add('sorted');
      } else {
        ind.textContent = '';
        th.classList.remove('sorted');
      }
    });
    syncSortSelect();
  }

  // Keep the dropdown in step with the current sort. A column sort with no matching option
  // (e.g. author, or score ascending) shows no selection rather than a stale, misleading label.
  function syncSortSelect() {
    if (!sortSelect) return;
    const want = sortKey + ':' + sortOrder;
    const opt = Array.prototype.find.call(sortSelect.options, o => o.value === want);
    sortSelect.selectedIndex = opt ? opt.index : -1;
  }

  if (sortSelect) sortSelect.addEventListener('change', () => {
    const parts = sortSelect.value.split(':');
    sortKey = parts[0];
    sortOrder = parts[1] || 'desc';
    updateSortIndicators();
    loadItems();
  });

  document.querySelectorAll('#items-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sortKey === key) {
        sortOrder = sortOrder === 'asc' ? 'desc' : 'asc';
      } else {
        sortKey = key;
        // Scores read best high-to-low by default.
        sortOrder = key === 'score' ? 'desc' : 'asc';
      }
      updateSortIndicators();
      loadItems();
    });
  });

  // ── Subreddit sidebar ──────────────────────────────────────────────────────────
  function loadSubreddits() {
    const qs = filterSaved.value !== '' ? ('?is_saved=' + filterSaved.value) : '';
    fetch('/reddit/subreddits' + qs)
      .then(r => r.json())
      .then(d => { allSubs = d.subreddits || []; renderSubreddits(); })
      .catch(() => {});
  }

  function renderSubreddits() {
    const f = (sidebarFilter.value || '').toLowerCase();
    const active = filterSub.value.trim().replace(/^r\//, '');
    const shown = f ? allSubs.filter(s => s.subreddit.toLowerCase().includes(f)) : allSubs;
    const rows = shown.slice(0, 500).map(s => {
      const cls = 'sub-item' + (s.subreddit === active ? ' active' : '');
      return `<div class="${cls}" data-sub="${esc(s.subreddit)}">`
        + `<span class="sub-name">r/${esc(s.subreddit)}</span>`
        + `<span class="sub-count">${esc(s.count)}</span></div>`;
    });
    const allCls = 'sub-item' + (active ? '' : ' active');
    subredditList.innerHTML =
      `<div class="${allCls}" data-sub=""><span class="sub-name">All subreddits</span></div>`
      + (rows.join('') || '<div class="empty-msg">No matches</div>');
  }

  if (subredditList) {
    subredditList.addEventListener('click', e => {
      const item = e.target.closest('.sub-item');
      if (!item) return;
      filterSub.value = item.dataset.sub || '';
      renderSubreddits();
      loadItems();
    });
  }
  if (sidebarFilter) sidebarFilter.addEventListener('input', renderSubreddits);
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
      sidebar.classList.toggle('collapsed');
      sidebarToggle.textContent = sidebar.classList.contains('collapsed') ? '»' : '«';
    });
  }

  // ── Stats modal ────────────────────────────────────────────────────────────────
  function openStats() {
    statsModal.style.display = 'flex';
    statsContent.textContent = 'Loading…';
    fetch('/reddit/stats').then(r => r.json()).then(renderStats).catch(() => {
      statsContent.textContent = 'Failed to load stats.';
    });
  }
  function closeStats() { statsModal.style.display = 'none'; }

  function bars(obj) {
    const entries = Object.entries(obj);
    const max = Math.max(1, ...entries.map(([, v]) => v));
    return entries.map(([k, v]) =>
      `<div class="bar-row"><span class="bar-label">${esc(k)}</span>`
      + `<span class="bar"><span style="width:${(v / max * 100).toFixed(1)}%"></span></span>`
      + `<span class="bar-val">${esc(v)}</span></div>`).join('');
  }

  function renderStats(d) {
    const st = d.by_status || {};
    const topSubs = (d.top_subreddits || []).reduce((o, s) => (o[s.subreddit] = s.count, o), {});
    const years = (d.by_year || []).reduce((o, y) => (o[y.year] = y.count, o), {});
    statsContent.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-num">${esc(d.total || 0)}</div><div>total</div></div>
        <div class="stat-card"><div class="stat-num">${esc(st.inbox || 0)}</div><div>inbox</div></div>
        <div class="stat-card"><div class="stat-num">${esc(d.distinct_subreddits || 0)}</div><div>subreddits</div></div>
        <div class="stat-card"><div class="stat-num">${esc(d.with_media || 0)}</div><div>with media</div></div>
        <div class="stat-card"><div class="stat-num">${esc(d.nsfw || 0)}</div><div>NSFW</div></div>
        <div class="stat-card"><div class="stat-num">${esc(st.archived || 0)}</div><div>archived</div></div>
      </div>
      <h3>By kind</h3>${bars(d.by_kind || {})}
      <h3>By status</h3>${bars(st)}
      <h3>Top subreddits</h3>${bars(topSubs)}
      ${Object.keys(years).length ? `<h3>By year posted <span class="hint">(only items with a known date)</span></h3>${bars(years)}` : ''}
    `;
  }

  if (btnStats) btnStats.addEventListener('click', openStats);
  if (statsClose) statsClose.addEventListener('click', closeStats);
  if (statsModal) statsModal.addEventListener('click', e => { if (e.target === statsModal) closeStats(); });

  // ── Keyboard shortcuts ───────────────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (e.key === 'Escape') {
      if (statsModal.style.display !== 'none') closeStats();
      else if (detailPanel.style.display !== 'none') closeDetailPanel();
    }
  });

  // ── Media/content type classification ───────────────────────────────────────
  function mediaType(item) {
    if (item.kind === 'comment') return { cls: 'comment', icon: '💬', label: 'Comment' };
    const url = (item.url || '').toLowerCase();

    if (/\.(jpg|jpeg|png|gif|webp|bmp)(\?|$)/.test(url) || url.includes('i.redd.it') || url.includes('i.imgur.com')) {
      return { cls: 'image', icon: '🖼️', label: 'Image' };
    }
    if (url.includes('/gallery/') || url.includes('imgur.com/a/')) {
      return { cls: 'gallery', icon: '🖼️', label: 'Gallery' };
    }
    if (/\.(mp4|webm|mov)(\?|$)/.test(url) || url.includes('v.redd.it') || url.includes('gfycat.com') || url.includes('redgifs.com')) {
      return { cls: 'video', icon: '🎬', label: 'Video' };
    }
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      return { cls: 'video', icon: '🎬', label: 'YouTube' };
    }
    const isSelf = !url || url.includes('reddit.com/r/') || url.includes('/comments/');
    if (isSelf) return { cls: 'text', icon: '📝', label: 'Text post' };
    return { cls: 'link', icon: '🔗', label: 'External link' };
  }

  // ── Escape helper ──────────────────────────────────────────────────────────
  function esc(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* [ARCHIVAL] begin — remove this block (and the renderArchiveLinks call above) to drop archive support */
  const btnHydrate = $('btn-hydrate');
  const hydrateStatus = $('hydrate-status');

  // Enrich-on-click: hydrate only the items currently loaded in the active view.
  // Requests are deduped, serialized, and batched (100/request); the server skips
  // items that already have data. Scroll to load more, click again.
  const enrichRequested = new Set();
  const enrichQueue = [];
  let enrichInFlight = false;
  let enrichHydrated = 0;

  if (btnHydrate) {
    btnHydrate.addEventListener('click', () => {
      const loaded = Array.from(activeContainer().querySelectorAll('[data-fullname]'))
        .map(el => el.dataset.fullname)
        .filter(fn => fn && !enrichRequested.has(fn));
      if (!loaded.length) {
        hydrateStatus.textContent = 'Nothing new to enrich in the loaded items.';
        return;
      }
      loaded.forEach(fn => { enrichRequested.add(fn); enrichQueue.push(fn); });
      enrichHydrated = 0;
      btnHydrate.disabled = true;
      hydrateStatus.textContent = `Enriching ${loaded.length} loaded item(s) from archives…`;
      pumpEnrich();
    });
  }

  function pumpEnrich() {
    if (enrichInFlight) return;
    if (!enrichQueue.length) {
      if (btnHydrate) {
        btnHydrate.disabled = false;
        hydrateStatus.textContent = `Enriched ${enrichHydrated} item(s) from archives.`;
      }
      return;
    }
    const batch = enrichQueue.splice(0, 100);
    enrichInFlight = true;
    fetch('/archival/hydrate-visible', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullnames: batch }),
    })
      .then(r => r.json())
      .then(data => {
        enrichInFlight = false;
        if (data && data.error) {
          batch.forEach(fn => enrichRequested.delete(fn));
          if (btnHydrate) { btnHydrate.disabled = false; }
          hydrateStatus.textContent = 'Error: ' + data.error;
          return;
        }
        if (data && data.items && data.items.length) {
          patchRows(data.items);
          enrichHydrated += data.items.length;
        }
        pumpEnrich();
      })
      .catch(() => {
        enrichInFlight = false;
        batch.forEach(fn => enrichRequested.delete(fn));
        if (btnHydrate) { btnHydrate.disabled = false; }
        hydrateStatus.textContent = 'Network error while enriching.';
      });
  }

  // Replace already-rendered items in place with their hydrated versions (view-aware).
  function patchRows(items) {
    const container = activeContainer();
    items.forEach(item => {
      const el = container.querySelector(`[data-fullname="${item.fullname}"]`);
      if (el) el.outerHTML = itemHtml(item);
    });
  }

  function renderArchiveLinks(permalink) {
    const el = $('archive-links');
    if (!el) return;
    if (!permalink) { el.innerHTML = ''; return; }
    const wayback = 'https://web.archive.org/web/*/' + permalink;
    el.innerHTML = `<a class="btn btn-ghost" href="${esc(wayback)}" target="_blank" title="Browse Internet Archive (Wayback) snapshots of this page">Wayback ↗</a>`;
  }
  /* [ARCHIVAL] end */

  // ── Init ───────────────────────────────────────────────────────────────────
  applyView();
  updateSortIndicators();
  loadItems();
  loadSubreddits();
  loadHeaderCounts();
})();
