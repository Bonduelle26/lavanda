/* Лаванда — личный ИИ-чат на Gemini.
   Всё хранится на устройстве (IndexedDB), синхронизация — через скрытый gist на GitHub. */
'use strict';
(() => {
  const DEMO = !!window.LAVANDA_DEMO;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const now = () => Date.now();
  const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 20)
    : now().toString(36) + Math.random().toString(36).slice(2, 12));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (name, cls = '') => `<svg class="ic ${cls}"><use href="#i-${name}"/></svg>`;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const isMobile = () => matchMedia('(max-width: 820px)').matches;
  const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  const hhmm = t => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage off */ } },
  };

  /* ---------------- settings ---------------- */
  const SKEY = 'lavanda.settings.v1';
  const defaults = {
    apiKey: '', model: '', models: [], search: true, system: '', context: 40, fs: 'm',
    enterSends: !coarse, ghToken: '', gistId: '', lastSync: 0,
  };
  const S = DEMO ? { ...defaults, model: 'gemini-flash', models: [
    { id: 'gemini-flash', name: 'Gemini Flash' }, { id: 'gemini-flash-lite', name: 'Gemini Flash-Lite' }, { id: 'gemini-pro', name: 'Gemini Pro' },
  ] } : { ...defaults, ...ls.get(SKEY, {}) };
  const saveSettings = () => { if (!DEMO) ls.set(SKEY, S); };

  /* ---------------- storage ---------------- */
  const DB = (() => {
    let db = null, mem = null;
    const p = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const done = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
    async function init() {
      if (DEMO || !('indexedDB' in window)) { mem = { chats: new Map(), folders: new Map(), files: new Map() }; return DEMO; }
      try {
        db = await new Promise((res, rej) => {
          const r = indexedDB.open('lavanda', 1);
          r.onupgradeneeded = () => { for (const n of ['chats', 'folders', 'files']) if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n, { keyPath: 'id' }); };
          r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('blocked'));
        });
        return true;
      } catch { mem = { chats: new Map(), folders: new Map(), files: new Map() }; return false; }
    }
    return {
      init,
      all: async s => mem ? [...mem[s].values()] : p(db.transaction(s).objectStore(s).getAll()),
      get: async (s, id) => mem ? mem[s].get(id) : p(db.transaction(s).objectStore(s).get(id)),
      put: async (s, o) => { if (mem) { mem[s].set(o.id, structuredClone(o)); return; } const t = db.transaction(s, 'readwrite'); t.objectStore(s).put(o); return done(t); },
      del: async (s, id) => { if (mem) { mem[s].delete(id); return; } const t = db.transaction(s, 'readwrite'); t.objectStore(s).delete(id); return done(t); },
      clear: async s => { if (mem) { mem[s].clear(); return; } const t = db.transaction(s, 'readwrite'); t.objectStore(s).clear(); return done(t); },
    };
  })();

  /* ---------------- state ---------------- */
  const st = {
    chats: new Map(), folders: new Map(), current: null, draftFolder: null,
    stream: null, pending: [], fileCache: new Map(), mdCache: new Map(),
    openFolders: new Set(ls.get('lavanda.open', [])), query: '', renderedFrom: 0,
    stick: true, searchOn: S.search,
  };
  const currentChat = () => (st.current ? st.chats.get(st.current) : null);
  const liveChats = () => [...st.chats.values()].filter(c => !c.deleted);
  const liveFolders = () => [...st.folders.values()].filter(f => !f.deleted).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const byRecent = (a, b) => b.updatedAt - a.updatedAt;

  /* ---------------- toasts, confirm, menu ---------------- */
  function toast(text, kind = '', ms = 4200) {
    const t = document.createElement('div');
    t.className = 'toast ' + kind; t.textContent = text;
    $('#toasts').append(t); setTimeout(() => t.remove(), ms);
  }

  function confirmDialog(text, yesLabel = 'Удалить') {
    return new Promise(resolve => {
      const ov = $('#confirm'), yes = $('#confirmYes'), no = $('#confirmNo');
      $('#confirmText').textContent = text; yes.textContent = yesLabel;
      ov.hidden = false; yes.focus();
      const finish = v => { ov.hidden = true; document.removeEventListener('keydown', onKey, true); resolve(v); };
      const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); finish(false); } };
      yes.onclick = () => finish(true); no.onclick = () => finish(false);
      ov.onclick = e => { if (e.target === ov) finish(false); };
      document.addEventListener('keydown', onKey, true);
    });
  }

  const menu = $('#menu');
  let menuAnchor = null;
  function openMenu(anchor, items, { replace = false } = {}) {
    if (!replace && !menu.hidden && menuAnchor === anchor) { closeMenu(); return; }
    menu.replaceChildren();
    for (const it of items) {
      if (it === 'sep') { menu.insertAdjacentHTML('beforeend', '<div class="sep"></div>'); continue; }
      if (it.header) { menu.insertAdjacentHTML('beforeend', `<div class="mlabel">${esc(it.header)}</div>`); continue; }
      if (it.note) { menu.insertAdjacentHTML('beforeend', `<div class="mnote">${esc(it.note)}</div>`); continue; }
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      b.className = (it.danger ? 'danger ' : '') + (it.selected ? 'sel' : '');
      b.innerHTML = `${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}`;
      b.onclick = e => { e.stopPropagation(); if (!it.keep) closeMenu(); it.action?.(); };
      menu.append(b);
    }
    if (menuAnchor && menuAnchor !== anchor && menuAnchor.setAttribute) menuAnchor.setAttribute('aria-expanded', 'false');
    menuAnchor = anchor;
    anchor.setAttribute?.('aria-expanded', 'true');
    menu.hidden = false;
    const mw = menu.offsetWidth, mh = menu.offsetHeight, vw = innerWidth, vh = innerHeight;
    let x, y;
    if (anchor.getBoundingClientRect) {
      const r = anchor.getBoundingClientRect();
      x = r.right - mw; if (x < 8) x = r.left;
      y = r.bottom + 4; if (y + mh > vh - 8) y = Math.max(8, r.top - mh - 4);
    } else { x = anchor.x; y = anchor.y; if (y + mh > vh - 8) y = vh - mh - 8; }
    menu.style.left = Math.max(8, Math.min(x, vw - mw - 8)) + 'px';
    menu.style.top = Math.max(8, y) + 'px';
    menu.querySelector('button')?.focus({ preventScroll: true });
  }
  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true; menuAnchor?.setAttribute?.('aria-expanded', 'false'); menuAnchor = null;
  }
  document.addEventListener('pointerdown', e => {
    if (!menu.hidden && !menu.contains(e.target) && !(menuAnchor?.contains && menuAnchor.contains(e.target))) closeMenu();
  });
  addEventListener('resize', closeMenu);
  menu.addEventListener('keydown', e => {
    const bs = $$('button', menu), i = bs.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); bs[(i + 1) % bs.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length]?.focus(); }
  });

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Скопировано', 'ok', 1600); }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.append(ta); ta.select();
      try { document.execCommand('copy'); toast('Скопировано', 'ok', 1600); } catch { toast('Не получилось скопировать', 'err'); }
      ta.remove();
    }
  }

  /* ---------------- chats & folders ---------------- */
  const newChatObj = folderId => {
    const t = now();
    return { id: uid(), title: 'Новый чат', titleManual: false, folderId: folderId || null, pinned: false, createdAt: t, updatedAt: t, deleted: false, messages: [] };
  };
  async function persistChat(c) {
    try { await DB.put('chats', c); } catch (e) { console.error(e); toast('Не удалось сохранить чат на устройстве', 'err'); }
  }
  function changed(c, { sync = true } = {}) {
    c.updatedAt = now(); persistChat(c);
    if (sync) Sync.schedule();
  }
  function makeTitle(text, files) {
    let t = (text || '').split('\n').find(l => l.trim()) || '';
    t = t.replace(/\s+/g, ' ').trim();
    if (!t && files?.length) t = 'Файл: ' + files[0].name;
    if (t.length > 56) { t = t.slice(0, 56); const sp = t.lastIndexOf(' '); if (sp > 30) t = t.slice(0, sp); t += '…'; }
    return t || 'Новый чат';
  }
  function renameChat(id, title) {
    const c = st.chats.get(id); if (!c) return;
    c.title = title; c.titleManual = true; changed(c); renderNav(); updateTopbar();
  }
  function togglePin(id) {
    const c = st.chats.get(id); if (!c) return;
    c.pinned = !c.pinned; changed(c); renderNav();
  }
  function moveChat(id, folderId) {
    const c = st.chats.get(id); if (!c) return;
    c.folderId = folderId; changed(c);
    if (folderId) { st.openFolders.add(folderId); ls.set('lavanda.open', [...st.openFolders]); }
    renderNav();
  }
  async function deleteChat(id) {
    const c = st.chats.get(id); if (!c) return;
    if (!(await confirmDialog(`Удалить чат «${c.title}»? Это действие нельзя отменить.`))) return;
    if (st.stream?.chatId === id) st.stream.ctrl.abort();
    for (const m of c.messages) for (const f of m.files || []) DB.del('files', f.id).catch(() => {});
    c.deleted = true; c.messages = []; c.title = ''; c.pinned = false;
    changed(c);
    if (st.current === id) newChat(); else renderNav();
  }
  function createFolder(thenMoveChatId) {
    const t = now();
    const f = { id: uid(), name: 'Новая папка', createdAt: t, updatedAt: t, deleted: false };
    st.folders.set(f.id, f); DB.put('folders', f);
    st.openFolders.add(f.id); ls.set('lavanda.open', [...st.openFolders]);
    if (thenMoveChatId) moveChat(thenMoveChatId, f.id);
    if (isMobile()) openSidebar();
    st.query = ''; $('#searchInput').value = '';
    renderNav();
    const row = $(`[data-folder="${f.id}"]`);
    if (row) startRename(row, f.name, v => renameFolder(f.id, v), () => {});
    Sync.schedule();
  }
  function renameFolder(id, name) {
    const f = st.folders.get(id); if (!f) return;
    f.name = name; f.updatedAt = now(); DB.put('folders', f); renderNav(); Sync.schedule();
  }
  async function deleteFolder(id) {
    const f = st.folders.get(id); if (!f) return;
    if (!(await confirmDialog(`Удалить папку «${f.name}»? Чаты из неё не удалятся, а переедут в общий список.`))) return;
    f.deleted = true; f.updatedAt = now(); DB.put('folders', f);
    for (const c of liveChats()) if (c.folderId === id) { c.folderId = null; changed(c, { sync: false }); }
    renderNav(); Sync.schedule();
  }

  /* ---------------- sidebar ---------------- */
  const nav = $('#chatNav');
  function chatRow(c, { snippet = '', showPin = false } = {}) {
    const r = document.createElement('div');
    r.className = 'row' + (c.id === st.current ? ' active' : '');
    r.dataset.chat = c.id; r.tabIndex = 0; r.setAttribute('role', 'button');
    r.innerHTML = `${showPin && c.pinned ? icon('pin', 'pin-mark') : ''}<span class="t">${esc(c.title)}${snippet ? `<span class="snip">${esc(snippet)}</span>` : ''}</span><button class="more" data-more aria-label="Действия с чатом" aria-haspopup="menu">${icon('dots')}</button>`;
    return r;
  }
  function label(text, extra = '') {
    const d = document.createElement('div'); d.className = 'nav-label';
    d.innerHTML = `<span>${esc(text)}</span>${extra}`; return d;
  }
  function dateBucket(t) {
    const d = new Date(); d.setHours(0, 0, 0, 0); const day = 864e5, start = d.getTime();
    if (t >= start) return 'Сегодня';
    if (t >= start - day) return 'Вчера';
    if (t >= start - 6 * day) return 'Последние 7 дней';
    if (t >= start - 29 * day) return 'Последние 30 дней';
    return 'Раньше';
  }
  function renderNav() {
    const frag = document.createDocumentFragment();
    const q = st.query.trim().toLowerCase();
    const chats = liveChats();
    if (q) {
      const hits = [];
      for (const c of chats) {
        const inTitle = c.title.toLowerCase().includes(q);
        const m = c.messages.find(m => m.text && m.text.toLowerCase().includes(q));
        if (inTitle || m) {
          let snip = '';
          if (m) { const i = m.text.toLowerCase().indexOf(q); snip = (i > 24 ? '…' : '') + m.text.slice(Math.max(0, i - 24), i + 60).replace(/\s+/g, ' '); }
          hits.push([c, snip]);
        }
      }
      hits.sort((a, b) => byRecent(a[0], b[0]));
      frag.append(label(hits.length ? `Найдено: ${hits.length}` : 'Ничего не нашлось'));
      for (const [c, snip] of hits) frag.append(chatRow(c, { snippet: snip }));
      nav.replaceChildren(frag); return;
    }
    const pinned = chats.filter(c => c.pinned).sort(byRecent);
    if (pinned.length) {
      frag.append(label('Закреплённые'));
      for (const c of pinned) frag.append(chatRow(c, { showPin: true }));
    }
    const folders = liveFolders();
    frag.append(label('Папки', `<button data-add-folder title="Новая папка" aria-label="Новая папка">${icon('folder-plus')}</button>`));
    if (!folders.length) {
      const e = document.createElement('div'); e.className = 'nav-empty'; e.textContent = 'Папок пока нет. Создай кнопкой справа.'; frag.append(e);
    }
    for (const f of folders) {
      const kids = chats.filter(c => c.folderId === f.id && !c.pinned).sort(byRecent);
      const open = st.openFolders.has(f.id);
      const box = document.createElement('div'); box.className = 'folder' + (open ? ' open' : '');
      box.innerHTML = `<div class="row" data-folder="${f.id}" role="button" tabindex="0" aria-expanded="${open}">${icon('chev-right', 'chev')}${icon('folder')}<span class="t">${esc(f.name)}</span><span class="count">${kids.length || ''}</span><button class="more" data-fmore aria-label="Действия с папкой" aria-haspopup="menu">${icon('dots')}</button></div><div class="kids"></div>`;
      const k = box.querySelector('.kids');
      if (!kids.length) k.innerHTML = '<div class="nav-empty">Пусто. Перенеси сюда чат через меню «⋯».</div>';
      for (const c of kids) k.append(chatRow(c));
      frag.append(box);
    }
    const loose = chats.filter(c => !c.pinned && !(c.folderId && st.folders.get(c.folderId) && !st.folders.get(c.folderId).deleted)).sort(byRecent);
    let bucket = '';
    for (const c of loose) {
      const b = dateBucket(c.updatedAt);
      if (b !== bucket) { frag.append(label(b)); bucket = b; }
      frag.append(chatRow(c));
    }
    if (!chats.length) {
      const e = document.createElement('div'); e.className = 'nav-empty'; e.style.paddingTop = '16px';
      e.textContent = 'Здесь появятся твои чаты.'; frag.append(e);
    }
    nav.replaceChildren(frag);
  }

  function startRename(row, current, onSave, onCancel = renderNav) {
    const t = row.querySelector('.t'); if (!t) return;
    const inp = document.createElement('input');
    inp.className = 'rename'; inp.value = current; inp.maxLength = 120; inp.setAttribute('aria-label', 'Новое название');
    t.replaceWith(inp); inp.focus(); inp.select();
    let fin = false;
    const finish = save => {
      if (fin) return; fin = true;
      const v = inp.value.trim();
      if (save && v && v !== current) onSave(v); else onCancel();
    };
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
    inp.addEventListener('click', e => e.stopPropagation());
  }

  function chatMenu(id, anchor) {
    const c = st.chats.get(id); if (!c) return;
    const folderItems = () => {
      const items = [{ header: 'Переместить в папку' }];
      for (const f of liveFolders()) items.push({ label: f.name, icon: 'folder', selected: c.folderId === f.id, action: () => moveChat(id, f.id) });
      items.push({ label: 'Без папки', icon: 'x', selected: !c.folderId, action: () => moveChat(id, null) });
      items.push('sep', { label: 'Новая папка…', icon: 'folder-plus', action: () => createFolder(id) });
      openMenu(anchor, items, { replace: true });
    };
    openMenu(anchor, [
      { label: 'Переименовать', icon: 'edit', action: () => {
        const row = nav.querySelector(`[data-chat="${id}"]`);
        if (row) startRename(row, c.title, v => renameChat(id, v)); else startTitleRename();
      } },
      { label: c.pinned ? 'Открепить' : 'Закрепить', icon: 'pin', action: () => togglePin(id) },
      { label: 'Переместить в папку', icon: 'folder', keep: true, action: folderItems },
      'sep',
      { label: 'Удалить', icon: 'trash', danger: true, action: () => deleteChat(id) },
    ]);
  }
  function folderMenu(id, anchor) {
    const f = st.folders.get(id); if (!f) return;
    openMenu(anchor, [
      { label: 'Новый чат в этой папке', icon: 'plus', action: () => newChat(id) },
      { label: 'Переименовать', icon: 'edit', action: () => { const row = nav.querySelector(`[data-folder="${id}"]`); if (row) startRename(row, f.name, v => renameFolder(id, v)); } },
      'sep',
      { label: 'Удалить папку', icon: 'trash', danger: true, action: () => deleteFolder(id) },
    ]);
  }
  function toggleFolder(id) {
    if (st.openFolders.has(id)) st.openFolders.delete(id); else st.openFolders.add(id);
    ls.set('lavanda.open', [...st.openFolders]); renderNav();
  }

  nav.addEventListener('click', e => {
    const more = e.target.closest('[data-more]');
    if (more) { e.stopPropagation(); return chatMenu(more.closest('[data-chat]').dataset.chat, more); }
    const fmore = e.target.closest('[data-fmore]');
    if (fmore) { e.stopPropagation(); return folderMenu(fmore.closest('[data-folder]').dataset.folder, fmore); }
    if (e.target.closest('[data-add-folder]')) return createFolder();
    const fr = e.target.closest('[data-folder]'); if (fr) return toggleFolder(fr.dataset.folder);
    const cr = e.target.closest('[data-chat]'); if (cr) return openChat(cr.dataset.chat);
  });
  nav.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.row')) { e.preventDefault(); e.target.click(); }
  });
  nav.addEventListener('contextmenu', e => {
    const cr = e.target.closest('[data-chat]'), fr = e.target.closest('[data-folder]');
    if (!cr && !fr) return;
    e.preventDefault();
    const pt = { x: e.clientX, y: e.clientY };
    if (cr) chatMenu(cr.dataset.chat, pt); else folderMenu(fr.dataset.folder, pt);
  });

  const appEl = $('#app');
  const openSidebar = () => appEl.classList.add('side-open');
  const closeSidebar = () => appEl.classList.remove('side-open');
  $('#btnMenu').onclick = openSidebar;
  $('#btnCloseSide').onclick = closeSidebar;
  $('#scrim').onclick = closeSidebar;

  let searchT = 0;
  $('#searchInput').addEventListener('input', e => {
    clearTimeout(searchT);
    searchT = setTimeout(() => { st.query = e.target.value; renderNav(); }, 120);
  });

  /* ---------------- topbar ---------------- */
  function updateTopbar() {
    const c = currentChat(), b = $('#chatTitle');
    b.textContent = c ? c.title : 'Новый чат';
    b.disabled = !c;
    document.title = c ? `${c.title} · Лаванда` : 'Лаванда';
  }
  function startTitleRename() {
    const c = currentChat(); if (!c) return;
    const b = $('#chatTitle'), inp = document.createElement('input');
    inp.className = 'rename'; inp.value = c.title; inp.maxLength = 120; inp.setAttribute('aria-label', 'Название чата');
    b.hidden = true; b.after(inp); inp.focus(); inp.select();
    let fin = false;
    const finish = save => {
      if (fin) return; fin = true;
      const v = inp.value.trim(); inp.remove(); b.hidden = false;
      if (save && v && v !== c.title) renameChat(c.id, v);
    };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
  }
  $('#chatTitle').onclick = startTitleRename;

  const modelLabel = id => (S.models.find(m => m.id === id)?.name || id || 'Модель').replace(/^Gemini\s+/i, 'Gemini ');
  function updateModelChip() { $('#modelName').textContent = S.model ? modelLabel(S.model) : 'Выбрать модель'; }
  $('#modelChip').onclick = e => {
    const anchor = e.currentTarget;
    const items = [{ header: 'Модель для ответов' }];
    for (const m of S.models) items.push({ label: m.name, selected: m.id === S.model, icon: m.id === S.model ? 'check' : 'cpu', action: () => { S.model = m.id; saveSettings(); updateModelChip(); } });
    if (!S.models.length) items.push({ note: S.apiKey ? 'Список моделей ещё не загружен.' : 'Сначала подключи ключ Gemini.' });
    items.push('sep', { label: 'Обновить список моделей', icon: 'refresh', action: () => refreshModels(true) });
    items.push({ note: 'Flash — быстрая, с большим бесплатным лимитом. Pro умнее, но бесплатных запросов у неё меньше.' });
    openMenu(anchor, items);
  };
  $('#btnNewChatTop').onclick = () => newChat();

  /* ---------------- markdown ---------------- */
  if (window.DOMPurify) {
    DOMPurify.addHook('afterSanitizeAttributes', n => {
      if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); }
    });
  }
  function md(text) {
    if (window.marked && window.DOMPurify) {
      try { return DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true })); } catch { /* fall through */ }
    }
    return '<p>' + esc(text).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
  }
  function enhance(box) {
    for (const t of box.querySelectorAll('table')) {
      if (t.parentElement.classList.contains('table-wrap')) continue;
      const w = document.createElement('div'); w.className = 'table-wrap'; t.replaceWith(w); w.append(t);
    }
    for (const pre of box.querySelectorAll('pre')) {
      if (pre.querySelector('.copy-code')) continue;
      const b = document.createElement('button'); b.className = 'copy-code'; b.type = 'button'; b.textContent = 'Копировать';
      pre.append(b);
    }
  }

  /* ---------------- thread ---------------- */
  const PAGE = 30;
  const thread = $('#thread'), box = $('#messages');
  let moreObserver = null;

  const msgEl = id => box.querySelector(`[data-id="${id}"]`);
  function markLast() {
    $$('.msg.last', box).forEach(e => e.classList.remove('last'));
    box.lastElementChild?.classList?.add('last');
  }
  const missingFiles = new Set();
  function filePreview(f) {
    const rec = st.fileCache.get(f.id);
    if (rec && rec.kind === 'image' && rec.data) return `<img class="thumb" loading="lazy" alt="${esc(f.name)}" src="data:${esc(rec.mime)};base64,${rec.data}">`;
    const missing = missingFiles.has(f.id);
    return `<span class="file-chip${missing ? ' missing' : ''}" title="${missing ? 'Файл прикреплён на другом устройстве' : esc(f.name)}">${icon(f.kind === 'image' ? 'image' : 'file')}<span>${esc(f.name)}</span></span>`;
  }
  async function hydrateFiles(el, files) {
    let need = false;
    for (const f of files) if (!st.fileCache.has(f.id) && !missingFiles.has(f.id)) {
      const rec = await DB.get('files', f.id).catch(() => null);
      if (rec) st.fileCache.set(f.id, rec); else missingFiles.add(f.id);
      need = true;
    }
    if (need && el.isConnected) { const w = el.querySelector('.files'); if (w) w.innerHTML = files.map(filePreview).join(''); }
  }

  function renderMsg(m) {
    const a = document.createElement('article');
    a.dataset.id = m.id;
    if (m.role === 'user') {
      a.className = 'msg user';
      if (m.files?.length) {
        const w = document.createElement('div'); w.className = 'files'; w.innerHTML = m.files.map(filePreview).join('');
        a.append(w); hydrateFiles(a, m.files);
      }
      if (m.text) { const b = document.createElement('div'); b.className = 'bubble'; b.textContent = m.text; a.append(b); }
      a.insertAdjacentHTML('beforeend', `<div class="msg-actions"><button data-act="edit" title="Изменить" aria-label="Изменить сообщение">${icon('edit')}</button><button data-act="copy" title="Копировать" aria-label="Копировать">${icon('copy')}</button></div>`);
    } else {
      a.className = 'msg model';
      a.innerHTML = `<div class="avatar">${icon('sprig')}</div><div class="body"><div class="md"></div><div class="extra"></div><div class="msg-actions"></div></div>`;
      fillModel(a, m);
    }
    return a;
  }

  function fillModel(a, m) {
    const mdBox = a.querySelector('.md'), extra = a.querySelector('.extra'), acts = a.querySelector('.msg-actions');
    if (m.pending && !m.text) {
      mdBox.innerHTML = `<div class="thinking"><span class="caret"></span>${m.search ? 'Ищу в Google и думаю…' : 'Думаю…'}</div>`;
    } else if (m.pending) {
      mdBox.innerHTML = md(m.text);
      (mdBox.lastElementChild || mdBox).insertAdjacentHTML('beforeend', '<span class="caret"></span>');
    } else {
      let cached = st.mdCache.get(m.id);
      if (!cached || cached.text !== m.text) { cached = { text: m.text, html: m.text ? md(m.text) : '' }; st.mdCache.set(m.id, cached); }
      mdBox.innerHTML = cached.html; enhance(mdBox);
    }
    let x = '';
    if (m.error) x += `<div class="err-box"><span>${esc(m.error)}</span><button data-act="retry">Повторить</button></div>`;
    if (m.note) x += `<div class="queries">${esc(m.note)}</div>`;
    if (m.sources?.length) {
      x += '<div class="sources">' + m.sources.slice(0, 12).map((s, i) =>
        `<a class="src" href="${esc(s.uri)}" target="_blank" rel="noopener noreferrer" title="${esc(s.title)}"><b>${i + 1}</b><span>${esc(s.title || hostOf(s.uri))}</span></a>`).join('') + '</div>';
    }
    if (m.queries?.length) {
      x += '<div class="queries"><span>Искал:</span>' + m.queries.slice(0, 4).map(q =>
        `<a href="https://www.google.com/search?q=${encodeURIComponent(q)}" target="_blank" rel="noopener noreferrer">${icon('search')}${esc(q)}</a>`).join('') + '</div>';
    }
    extra.innerHTML = x;
    acts.innerHTML = m.pending ? '' : `${m.text ? `<button data-act="copy" title="Копировать" aria-label="Копировать ответ">${icon('copy')}</button>` : ''}<button data-act="regen" title="Ответить заново" aria-label="Ответить заново">${icon('refresh')}</button>${m.model ? `<span class="msg-meta">${esc(modelLabel(m.model))} · ${hhmm(m.at)}</span>` : ''}`;
  }

  function loadMoreEl(count) {
    const b = document.createElement('button');
    b.className = 'load-more'; b.textContent = `Показать ранние сообщения (${count})`;
    return b;
  }
  function observeMore() {
    moreObserver?.disconnect();
    const lm = box.querySelector('.load-more'); if (!lm || !('IntersectionObserver' in window)) return;
    moreObserver = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) loadEarlier(); }, { root: thread, rootMargin: '400px 0px 0px 0px' });
    moreObserver.observe(lm);
  }
  function loadEarlier() {
    const c = currentChat(); const lm = box.querySelector('.load-more');
    if (!c || !lm || st.renderedFrom <= 0) return;
    const prevH = thread.scrollHeight, prevTop = thread.scrollTop;
    const start = Math.max(0, st.renderedFrom - PAGE);
    const frag = document.createDocumentFragment();
    for (let i = start; i < st.renderedFrom; i++) frag.append(renderMsg(c.messages[i]));
    lm.after(frag);
    st.renderedFrom = start;
    if (start === 0) { lm.remove(); moreObserver?.disconnect(); } else lm.textContent = `Показать ранние сообщения (${start})`;
    thread.scrollTop = prevTop + (thread.scrollHeight - prevH);
  }

  function greeting() {
    const h = new Date().getHours();
    const g = h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 17 ? 'Добрый день' : h < 23 ? 'Добрый вечер' : 'Доброй ночи';
    return `${g}. <em>Чем помочь?</em>`;
  }
  const SUGGEST = [
    ['Найди свежие новости', 'из мира технологий за эту неделю', 'Найди свежие новости из мира технологий за эту неделю и коротко перескажи главное'],
    ['Объясни простыми словами', 'почему растут цены и что такое инфляция', 'Объясни простыми словами, почему растут цены и что такое инфляция'],
    ['Составь план', 'как за месяц подтянуть английский', 'Составь план, как за месяц подтянуть английский, занимаясь по 30 минут в день'],
    ['Помоги с текстом', 'сделать его вежливее и короче', 'Сделай этот текст вежливее и короче:\n\n'],
  ];
  function renderSuggest() {
    $('#greeting').innerHTML = greeting();
    $('#suggest').innerHTML = SUGGEST.map(([b, d], i) => `<button data-sug="${i}"><b>${esc(b)}</b>${esc(d)}</button>`).join('');
  }
  $('#suggest').addEventListener('click', e => {
    const b = e.target.closest('[data-sug]'); if (!b) return;
    input.value = SUGGEST[+b.dataset.sug][2]; autosize(); updateSendBtn(); input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });

  function renderThread() {
    const c = currentChat();
    const hasKey = !!S.apiKey || DEMO;
    const has = !!(c && c.messages.length);
    $('#welcome').hidden = hasKey;
    $('#emptyState').hidden = !hasKey || has;
    $('#threadInner').hidden = !has;
    $('#demoBanner').hidden = !DEMO;
    box.replaceChildren(); moreObserver?.disconnect();
    if (!has) { renderSuggest(); thread.scrollTop = 0; return; }
    const start = Math.max(0, c.messages.length - PAGE);
    st.renderedFrom = start;
    const frag = document.createDocumentFragment();
    if (start > 0) frag.append(loadMoreEl(start));
    for (let i = start; i < c.messages.length; i++) frag.append(renderMsg(c.messages[i]));
    box.append(frag); markLast();
    st.stick = true;
    scrollToBottom();
    requestAnimationFrame(() => { scrollToBottom(); observeMore(); });
  }
  function appendMsg(m) {
    if ($('#threadInner').hidden) { renderThread(); return; }
    box.append(renderMsg(m)); markLast();
  }
  function scrollToBottom(smooth = false) {
    thread.scrollTo({ top: thread.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }
  thread.addEventListener('scroll', () => {
    const d = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
    st.stick = d < 120;
    $('#btnToBottom').hidden = st.stick || $('#threadInner').hidden;
    $('#topbar').classList.toggle('scrolled', thread.scrollTop > 4);
  }, { passive: true });
  $('#btnToBottom').onclick = () => { st.stick = true; scrollToBottom(true); };
  // stay pinned to the newest message while content settles (fonts, images, streaming text)
  if ('ResizeObserver' in window) new ResizeObserver(() => { if (st.stick && !$('#threadInner').hidden) scrollToBottom(); }).observe(box);

  box.addEventListener('click', e => {
    const cc = e.target.closest('.copy-code');
    if (cc) { const code = cc.parentElement.querySelector('code'); return copyText((code || cc.parentElement).innerText.replace(/Копировать$/, '')); }
    if (e.target.closest('.load-more')) return loadEarlier();
    const act = e.target.closest('[data-act]'); if (!act) return;
    const art = act.closest('.msg'), c = currentChat(); if (!art || !c) return;
    const idx = c.messages.findIndex(m => m.id === art.dataset.id); if (idx < 0) return;
    const m = c.messages[idx];
    switch (act.dataset.act) {
      case 'copy': return copyText(m.text);
      case 'regen': case 'retry': return regenerate(c, idx);
      case 'edit': return editMessage(c, idx, art);
    }
  });

  function editMessage(c, idx, art) {
    if (st.stream) return toast('Дождись конца ответа или останови его', '', 2500);
    const m = c.messages[idx];
    const wrap = document.createElement('div'); wrap.className = 'edit-box';
    wrap.innerHTML = `<textarea aria-label="Изменить сообщение"></textarea><div class="btns"><button class="btn" data-x="cancel">Отмена</button><button class="btn primary" data-x="save">Отправить заново</button></div>`;
    const ta = wrap.querySelector('textarea'); ta.value = m.text;
    art.replaceChildren(wrap); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    const close = () => art.replaceWith(renderMsg(m));
    wrap.querySelector('[data-x="cancel"]').onclick = e => { e.stopPropagation(); close(); markLast(); };
    wrap.querySelector('[data-x="save"]').onclick = e => {
      e.stopPropagation();
      const v = ta.value.trim(); if (!v && !m.files?.length) return;
      m.text = v; c.messages.splice(idx + 1);
      changed(c, { sync: false }); renderThread(); generate(c);
    };
    ta.addEventListener('keydown', e => {
      if (e.key === 'Escape') { close(); markLast(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) wrap.querySelector('[data-x="save"]').click();
    });
  }
  function regenerate(c, idx) {
    if (st.stream) return;
    if (idx !== c.messages.length - 1) {
      toast('Заново можно ответить только на последнее сообщение', '', 2500); return;
    }
    const m = c.messages[idx];
    c.messages.splice(idx, 1); st.mdCache.delete(m.id);
    msgEl(m.id)?.remove();
    generate(c);
  }

  /* ---------------- composer ---------------- */
  const input = $('#input'), sendBtn = $('#btnSend');
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, innerHeight * 0.4) + 'px';
  }
  function updateSendBtn() {
    if (st.stream) { sendBtn.disabled = false; return; }
    sendBtn.disabled = !input.value.trim() && !st.pending.length;
  }
  function setSending(on) {
    sendBtn.classList.toggle('stop', on);
    sendBtn.innerHTML = icon(on ? 'stop' : 'up');
    sendBtn.title = on ? 'Остановить' : 'Отправить';
    sendBtn.setAttribute('aria-label', sendBtn.title);
    updateSendBtn();
  }
  let draftT = 0;
  input.addEventListener('input', () => {
    autosize(); updateSendBtn();
    clearTimeout(draftT); draftT = setTimeout(() => ls.set('lavanda.draft', input.value), 400);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (S.enterSends || e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!st.stream) send(); }
  });
  sendBtn.onclick = () => { if (st.stream) st.stream.ctrl.abort(); else send(); };

  function updateSearchChip() { $('#btnSearch').setAttribute('aria-pressed', String(st.searchOn)); }
  $('#btnSearch').onclick = () => { st.searchOn = !st.searchOn; updateSearchChip(); };

  /* attachments */
  const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|js|mjs|ts|tsx|jsx|py|html?|css|scss|xml|ya?ml|log|sql|java|c|h|cpp|hpp|cs|go|rs|php|rb|kt|swift|sh|bat|ps1|ini|toml|env|srt|vtt)$/i;
  const toBase64 = blob => new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(r.error); r.readAsDataURL(blob);
  });
  async function compressImage(file) {
    if (/gif/.test(file.type)) return { data: await toBase64(file), mime: file.type };
    try {
      const bmp = await createImageBitmap(file);
      const max = 2048, k = Math.min(1, max / Math.max(bmp.width, bmp.height));
      if (k === 1 && file.size < 1.5e6 && /jpe?g|png|webp/.test(file.type)) { bmp.close?.(); return { data: await toBase64(file), mime: file.type }; }
      const cv = document.createElement('canvas');
      cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height); bmp.close?.();
      const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.86));
      if (!blob) throw new Error('canvas');
      return { data: await toBase64(blob), mime: 'image/jpeg' };
    } catch {
      return { data: await toBase64(file), mime: file.type || 'image/jpeg' };
    }
  }
  async function addFiles(list) {
    for (const f of list) {
      if (st.pending.length >= 10) { toast('За раз можно прикрепить до 10 файлов', 'err'); break; }
      const kind = f.type.startsWith('image/') ? 'image' : f.type === 'application/pdf' || /\.pdf$/i.test(f.name) ? 'pdf'
        : (f.type.startsWith('text/') || /json|xml|javascript|yaml|csv|sql/.test(f.type) || TEXT_EXT.test(f.name)) ? 'text' : null;
      if (!kind) { toast(`«${f.name}»: такой формат Gemini не читает. Подойдут фото, PDF и текстовые файлы.`, 'err', 5000); continue; }
      if (f.size > 18 * 1024 * 1024) { toast(`«${f.name}» больше 18 МБ. Такой файл не отправить.`, 'err'); continue; }
      const rec = { id: uid(), name: f.name || (kind === 'image' ? 'фото.jpg' : 'файл'), mime: f.type || 'text/plain', size: f.size, kind };
      try {
        if (kind === 'image') Object.assign(rec, await compressImage(f));
        else if (kind === 'pdf') { rec.mime = 'application/pdf'; rec.data = await toBase64(f); }
        else {
          rec.text = await f.text();
          if (rec.text.length > 400000) { rec.text = rec.text.slice(0, 400000); toast(`«${f.name}» очень большой, отправлю первые 400 тысяч символов`, '', 5000); }
        }
      } catch { toast(`Не получилось прочитать «${f.name}»`, 'err'); continue; }
      st.pending.push(rec);
    }
    renderAttachments(); updateSendBtn();
  }
  function renderAttachments() {
    const w = $('#attachments');
    w.innerHTML = st.pending.map(f => `<div class="att" data-att="${f.id}">${f.kind === 'image'
      ? `<img alt="" src="data:${esc(f.mime)};base64,${f.data}">` : `<span class="fi">${icon('file')}</span>`}<span>${esc(f.name)}</span><button aria-label="Убрать файл ${esc(f.name)}">${icon('x')}</button></div>`).join('');
  }
  $('#attachments').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const id = b.closest('[data-att]').dataset.att;
    st.pending = st.pending.filter(f => f.id !== id); renderAttachments(); updateSendBtn();
  });
  $('#btnAttach').onclick = () => $('#fileInput').click();
  $('#fileInput').addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });
  input.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  const composer = $('#composer');
  for (const t of [composer, thread]) {
    t.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); composer.classList.add('drag'); } });
    t.addEventListener('dragleave', e => { if (!t.contains(e.relatedTarget)) composer.classList.remove('drag'); });
    t.addEventListener('drop', e => { if (e.dataTransfer?.files?.length) { e.preventDefault(); composer.classList.remove('drag'); addFiles([...e.dataTransfer.files]); } });
  }

  /* voice */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = $('#btnMic');
  let rec = null;
  if (!SR) micBtn.hidden = true;
  micBtn.onclick = () => {
    if (rec) { rec.stop(); return; }
    try { rec = new SR(); } catch { toast('Голосовой ввод не поддерживается в этом браузере', 'err'); return; }
    rec.lang = 'ru-RU'; rec.interimResults = true; rec.continuous = !coarse;
    const base = input.value ? input.value.replace(/\s*$/, ' ') : '';
    let fin = '';
    rec.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) fin += r[0].transcript; else interim += r[0].transcript;
      }
      input.value = base + fin + interim; autosize(); updateSendBtn();
    };
    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Нет доступа к микрофону. Разреши его для этого сайта в настройках браузера.', 'err', 6000);
      else if (e.error === 'network') toast('Для распознавания речи нужен интернет', 'err');
      else if (e.error !== 'no-speech' && e.error !== 'aborted') toast('Голосовой ввод: ' + e.error, 'err');
    };
    rec.onend = () => { rec = null; micBtn.classList.remove('rec'); micBtn.title = 'Голосовой ввод'; ls.set('lavanda.draft', input.value); };
    try { rec.start(); micBtn.classList.add('rec'); micBtn.title = 'Остановить запись'; }
    catch { rec = null; toast('Не получилось включить микрофон', 'err'); }
  };

  /* ---------------- Gemini ---------------- */
  const Gemini = (() => {
    const API = 'https://generativelanguage.googleapis.com/v1beta';
    class ApiError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
    async function apiErr(res) {
      let msg = res.statusText, code = '';
      try { const j = await res.json(); msg = j.error?.message || msg; code = j.error?.status || ''; } catch { /* not json */ }
      return new ApiError(res.status, msg, code);
    }
    const modelVer = id => parseFloat((id.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0');
    const tier = id => /flash-lite/.test(id) ? 2 : /flash/.test(id) ? 1 : /pro/.test(id) ? 3 : 4;
    const unstable = id => /preview|exp|\d{3,}$|-\d{2}-\d{2}/.test(id) ? 1 : 0;
    const sortModels = (a, b) => (modelVer(b.id) - modelVer(a.id)) || (unstable(a.id) - unstable(b.id)) || (tier(a.id) - tier(b.id)) || a.id.localeCompare(b.id);
    async function listModels(key) {
      const out = []; let token = '';
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${API}/models?pageSize=1000${token ? '&pageToken=' + encodeURIComponent(token) : ''}`, { headers: { 'x-goog-api-key': key } });
        if (!res.ok) throw await apiErr(res);
        const j = await res.json();
        out.push(...(j.models || []));
        token = j.nextPageToken; if (!token) break;
      }
      return out
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/i.test(m.name)
          && !/(embed|tts|image|audio|live|native|robotics|computer|aqa|veo|imagen|gemma)/i.test(m.name))
        .map(m => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || m.name.replace(/^models\//, '') }))
        .sort(sortModels);
    }
    function pickDefault(ms) {
      return ms.find(m => /flash/.test(m.id) && !/lite/.test(m.id) && !unstable(m.id))
        || ms.find(m => /flash/.test(m.id)) || ms[0];
    }
    /* SSE: splits a buffer into complete events; returns their data payloads and the unparsed rest */
    function parseSSE(buf) {
      const events = []; let m;
      const re = /\r?\n\r?\n/g; let last = 0;
      while ((m = re.exec(buf))) {
        const chunk = buf.slice(last, m.index); last = m.index + m[0].length;
        const data = chunk.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
        if (data) events.push(data);
      }
      return { events, rest: buf.slice(last) };
    }
    async function stream({ key, model, contents, system, search, signal, onText, onMeta, onFinish }) {
      const body = { contents };
      if (system && system.trim()) body.systemInstruction = { parts: [{ text: system.trim() }] };
      if (search) body.tools = [{ google_search: {} }];
      const res = await fetch(`${API}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
        method: 'POST', signal, body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      });
      if (!res.ok) throw await apiErr(res);
      const handle = data => {
        let j; try { j = JSON.parse(data); } catch { return; }
        if (j.error) throw new ApiError(j.error.code || 500, j.error.message || '', j.error.status || '');
        if (j.promptFeedback?.blockReason) throw new ApiError(400, 'blocked: ' + j.promptFeedback.blockReason, 'BLOCKED');
        const cand = j.candidates?.[0]; if (!cand) return;
        for (const p of cand.content?.parts || []) if (p.text && !p.thought) onText(p.text);
        if (cand.groundingMetadata) onMeta?.(cand.groundingMetadata);
        if (cand.finishReason) onFinish?.(cand.finishReason);
      };
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const { events, rest } = parseSSE(buf); buf = rest;
        events.forEach(handle);
      }
      buf += dec.decode();
      parseSSE(buf + '\n\n').events.forEach(handle);
    }
    return { listModels, pickDefault, stream, parseSSE, ApiError };
  })();

  function friendlyError(e) {
    const m = String(e?.message || '').toLowerCase(), s = e?.status;
    if (e instanceof TypeError || /failed to fetch|networkerror|load failed|network/.test(m)) {
      return navigator.onLine === false ? 'Нет интернета. Проверь подключение и нажми «Повторить».'
        : 'Не получилось связаться с Gemini. Проверь интернет или VPN и нажми «Повторить».';
    }
    if (/location is not supported|user location/.test(m)) return 'Gemini API недоступен в твоём регионе. Включи VPN и нажми «Повторить».';
    if (/api key not valid|api_key_invalid|api key expired/.test(m)) return 'Ключ Gemini не подходит. Проверь его в настройках.';
    if (e?.code === 'BLOCKED') return 'Gemini отказался отвечать на этот запрос из-за своих правил безопасности.';
    if (/access_token_type_unsupported/.test(m)) return 'Google не принял ключ нового формата (известный сбой на бесплатном тарифе). Создай в AI Studio ещё один ключ и вставь его.';
    if (s === 401 || s === 403) return 'Gemini не принял ключ. Проверь его в настройках или создай новый в AI Studio.';
    if (s === 404) return `Модель «${modelLabel(S.model)}» недоступна. Выбери другую модель вверху.`;
    if (s === 429) return 'Бесплатный лимит этой модели сейчас исчерпан. Подожди минуту или выбери модель полегче (Flash или Flash-Lite) вверху.';
    if (s === 400 && /search|tool/.test(m)) return 'Эта модель не умеет искать в Google. Выключи «Поиск Google» или выбери другую модель.';
    if (s >= 500) return 'Серверы Gemini перегружены. Подожди немного и нажми «Повторить».';
    return 'Ошибка Gemini: ' + (e?.message || 'неизвестная');
  }

  /* returns 'ok', 'badkey' (key rejected) or 'error' (network, region, etc.) */
  async function refreshModels(loud) {
    if (DEMO) { loud && toast('В превью список моделей примерный'); return 'ok'; }
    if (!S.apiKey) { loud && toast('Сначала вставь ключ Gemini', 'err'); return 'badkey'; }
    try {
      const ms = await Gemini.listModels(S.apiKey);
      if (!ms.length) throw new Error('Gemini не вернул ни одной модели');
      S.models = ms;
      if (!S.model || !ms.some(m => m.id === S.model)) S.model = Gemini.pickDefault(ms).id;
      saveSettings(); updateModelChip(); fillModelSelect();
      loud && toast(`Ключ работает. Модель: ${modelLabel(S.model)}`, 'ok');
      return 'ok';
    } catch (e) {
      loud && toast(friendlyError(e), 'err', 6000);
      const m = String(e?.message || '').toLowerCase();
      return (/api key not valid|api_key_invalid|api key expired/.test(m) || e?.status === 401) ? 'badkey' : 'error';
    }
  }

  async function buildContents(c, upto) {
    let msgs = c.messages.slice(0, upto).filter(m => !m.error && !m.pending && (m.text || m.files?.length));
    const lim = +S.context; if (lim > 0 && msgs.length > lim) msgs = msgs.slice(-lim);
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    const out = [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i], recent = i >= msgs.length - 10, parts = [];
      for (const f of m.files || []) {
        let r = st.fileCache.get(f.id);
        if (!r) { r = await DB.get('files', f.id).catch(() => null); if (r) st.fileCache.set(f.id, r); }
        if (!r) { parts.push({ text: `[Файл «${f.name}» прикреплён на другом устройстве, здесь его содержимого нет]` }); continue; }
        if (r.kind === 'text') parts.push({ text: `Файл «${r.name}»:\n\`\`\`\n${r.text}\n\`\`\`` });
        else if (recent) parts.push({ inlineData: { mimeType: r.mime, data: r.data } });
        else parts.push({ text: `[Ранее было прикреплено: «${r.name}»]` });
      }
      if (m.text) parts.push({ text: m.text });
      if (!parts.length) continue;
      const role = m.role === 'user' ? 'user' : 'model';
      if (out.length && out[out.length - 1].role === role) out[out.length - 1].parts.push(...parts);
      else out.push({ role, parts });
    }
    return out;
  }

  let rafT = 0, lastPaint = 0;
  function paintStream() {
    if (rafT) return;
    rafT = requestAnimationFrame(() => {
      rafT = 0;
      const s = st.stream; if (!s || s.chatId !== st.current) return;
      if (performance.now() - lastPaint < 60) { paintStream(); return; }
      lastPaint = performance.now();
      const el = msgEl(s.msg.id); if (el) fillModel(el, s.msg);
      if (st.stick) scrollToBottom();
    });
  }

  async function send() {
    if (st.stream) return;
    const text = input.value.trim(), atts = st.pending.slice();
    if (!text && !atts.length) return;
    if (!S.apiKey && !DEMO) { toast('Сначала подключи бесплатный ключ Gemini', 'err'); renderThread(); $('#welcomeKey')?.focus(); return; }
    if (rec) rec.stop();
    let c = currentChat();
    if (!c) { c = newChatObj(st.draftFolder); st.chats.set(c.id, c); st.current = c.id; ls.set('lavanda.last', c.id); }
    for (const f of atts) { st.fileCache.set(f.id, f); DB.put('files', { ...f, at: now() }).catch(() => toast('Файл не сохранился на устройстве', 'err')); }
    const um = { id: uid(), role: 'user', text, at: now(), files: atts.map(f => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, kind: f.kind })) };
    if (!um.files.length) delete um.files;
    c.messages.push(um);
    if (!c.titleManual && c.messages.filter(m => m.role === 'user').length === 1) c.title = makeTitle(text, atts);
    input.value = ''; autosize(); st.pending = []; renderAttachments(); ls.set('lavanda.draft', '');
    changed(c, { sync: false });
    appendMsg(um); renderNav(); updateTopbar();
    await generate(c);
  }

  async function generate(c) {
    const mm = { id: uid(), role: 'model', text: '', at: now(), pending: true, model: S.model, search: st.searchOn, sources: [], queries: [] };
    const upto = c.messages.length;
    c.messages.push(mm);
    const ctrl = new AbortController();
    st.stream = { chatId: c.id, msg: mm, ctrl };
    setSending(true);
    if (st.current === c.id) { appendMsg(mm); st.stick = true; scrollToBottom(); }
    try {
      if (DEMO) await demoStream(mm, ctrl.signal);
      else {
        const contents = await buildContents(c, upto);
        await Gemini.stream({
          key: S.apiKey, model: S.model || 'gemini-flash-latest', contents, system: S.system, search: mm.search, signal: ctrl.signal,
          onText: t => { mm.text += t; paintStream(); },
          onMeta: gm => {
            for (const ch of gm.groundingChunks || []) {
              const w = ch.web || ch.retrievedContext;
              if (w?.uri && !mm.sources.some(s => s.uri === w.uri)) mm.sources.push({ uri: w.uri, title: w.title || hostOf(w.uri) });
            }
            for (const q of gm.webSearchQueries || []) if (q && !mm.queries.includes(q)) mm.queries.push(q);
          },
          onFinish: r => {
            if (r === 'MAX_TOKENS') mm.note = 'Ответ обрезан: он получился слишком длинным. Напиши «продолжи».';
            else if (/SAFETY|PROHIBITED|BLOCKLIST|SPII/.test(r)) mm.note = 'Gemini прервал ответ из-за своих правил безопасности.';
            else if (r === 'RECITATION') mm.note = 'Gemini прервал ответ: он слишком близко повторял чужой текст.';
          },
        });
      }
      if (!mm.text.trim() && !mm.note) mm.error = 'Gemini вернул пустой ответ. Попробуй ещё раз или переформулируй вопрос.';
    } catch (e) {
      if (e?.name === 'AbortError') { if (!mm.text) mm.error = 'Ответ остановлен.'; }
      else { console.warn(e); mm.error = friendlyError(e); }
    } finally {
      mm.pending = false; delete mm.search;
      if (!mm.sources.length) delete mm.sources;
      if (!mm.queries.length) delete mm.queries;
      st.stream = null; setSending(false);
      const el = msgEl(mm.id);
      if (el && st.current === c.id) { el.replaceWith(renderMsg(mm)); markLast(); if (st.stick) scrollToBottom(); }
      if (!c.deleted) { changed(c); renderNav(); }
    }
  }

  function newChat(folderId = null) {
    st.current = null; st.draftFolder = folderId || null; ls.set('lavanda.last', '');
    renderThread(); renderNav(); updateTopbar(); closeSidebar();
    if (!coarse) input.focus();
  }
  function openChat(id) {
    if (id === st.current) { closeSidebar(); return; }
    st.current = id; st.draftFolder = null; ls.set('lavanda.last', id);
    renderThread(); renderNav(); updateTopbar(); closeSidebar();
  }
  $('#btnNewChat').onclick = () => newChat();

  /* ---------------- sync via GitHub gist ---------------- */
  const Sync = (() => {
    const GH = 'https://api.github.com', IDX = 'lavanda-index.json', DESC = 'Lavanda — синхронизация чатов (не удалять)';
    class SyncError extends Error {}
    let timer = 0, running = false, again = false, state = 'off', errText = '';
    const enabled = () => !!S.ghToken && !DEMO;
    const chatFile = id => `chat_${id}.json`;

    async function gh(path, opts = {}) {
      const res = await fetch(GH + path, {
        ...opts, cache: opts.cache || 'no-store',
        headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + S.ghToken, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      });
      if (res.status === 401) throw new SyncError('Токен GitHub не подходит или истёк. Вставь новый в настройках.');
      if (res.status === 403 || res.status === 429) {
        throw new SyncError(res.headers.get('x-ratelimit-remaining') === '0'
          ? 'GitHub временно ограничил запросы. Синхронизация продолжится позже.'
          : 'GitHub не дал доступ. Проверь, что у токена стоит галочка gist.');
      }
      if (res.status === 404) { const e = new SyncError('Хранилище не найдено'); e.notFound = true; throw e; }
      if (!res.ok) throw new SyncError('GitHub ответил ошибкой ' + res.status);
      return res.status === 204 ? null : res.json();
    }
    async function findGist() {
      for (let page = 1; page <= 10; page++) {
        const list = await gh(`/gists?per_page=100&page=${page}`);
        if (!list?.length) break;
        const g = list.find(g => g.files && g.files[IDX]);
        if (g) return g.id;
      }
      return '';
    }
    async function fileText(f) {
      if (!f) return null;
      if (!f.truncated && typeof f.content === 'string') return f.content;
      const r = await fetch(f.raw_url, { cache: 'no-store' });
      if (!r.ok) throw new SyncError('Не получилось скачать данные синхронизации');
      return r.text();
    }
    const stripChat = c => ({
      id: c.id, title: c.title, titleManual: !!c.titleManual, folderId: c.folderId || null, pinned: !!c.pinned,
      createdAt: c.createdAt, updatedAt: c.updatedAt, deleted: false,
      messages: c.messages.filter(m => !m.pending).map(m => {
        const o = { id: m.id, role: m.role, text: m.text, at: m.at };
        for (const k of ['files', 'sources', 'queries', 'error', 'note', 'model']) if (m[k] !== undefined) o[k] = m[k];
        return o;
      }),
    });

    /* Pure merge plan: newest updatedAt wins per chat and per folder */
    function plan(localChats, localFolders, remote) {
      const r = remote || { chats: {}, folders: {} }, rc = r.chats || {}, rf = r.folders || {};
      const down = [], up = [], delLocal = [], folderToLocal = [];
      const mergedFolders = { ...rf }; let foldersChanged = false;
      for (const id of new Set([...localChats.keys(), ...Object.keys(rc)])) {
        const L = localChats.get(id), R = rc[id];
        if (!R) { up.push(id); continue; }
        if (!L) { if (!R.deleted) down.push(id); continue; }
        if (R.updatedAt > L.updatedAt) { if (R.deleted) { if (!L.deleted) delLocal.push(id); } else down.push(id); }
        else if (L.updatedAt > R.updatedAt) up.push(id);
      }
      for (const id of new Set([...localFolders.keys(), ...Object.keys(rf)])) {
        const L = localFolders.get(id), R = rf[id];
        if (L && (!R || L.updatedAt > R.updatedAt)) { mergedFolders[id] = L; foldersChanged = true; }
        else if (R && (!L || R.updatedAt > L.updatedAt)) folderToLocal.push(R);
      }
      return { down, up, delLocal, folderToLocal, mergedFolders, foldersChanged };
    }

    function setStatus(s, text = '') {
      state = s; errText = text;
      const map = {
        off: ['', 'Синхронизация выключена'],
        busy: ['busy', 'Синхронизирую…'],
        ok: ['ok', S.lastSync ? `Синхронизировано в ${hhmm(S.lastSync)}` : 'Синхронизировано'],
        err: ['err', text || 'Ошибка синхронизации'],
      };
      const [cls, label] = map[s];
      for (const [d, t] of [['#syncDot', '#syncText'], ['#syncDot2', '#syncText2']]) {
        $(d).className = 'dot ' + cls; $(t).textContent = label;
      }
      $('#syncStatus').title = label;
      $('#syncOff').hidden = enabled();
      $('#syncOn').hidden = !enabled();
    }

    async function run() {
      if (!enabled()) { setStatus('off'); return; }
      if (running) { again = true; return; }
      running = true; setStatus('busy');
      try {
        // 'no-cache' revalidates by ETag: when nothing changed GitHub answers 304 and almost nothing is downloaded
        let gistId = S.gistId, g = null;
        if (gistId) { try { g = await gh('/gists/' + gistId, { cache: 'no-cache' }); } catch (e) { if (e.notFound) gistId = ''; else throw e; } }
        if (!gistId) { gistId = await findGist(); if (gistId) g = await gh('/gists/' + gistId, { cache: 'no-cache' }); }
        let remote = null;
        if (g) { const t = await fileText(g.files?.[IDX]); try { remote = t ? JSON.parse(t) : null; } catch { remote = null; } }

        const p = plan(st.chats, st.folders, remote);
        const streamingId = st.stream?.chatId;
        let touchedCurrent = false;

        for (const f of p.folderToLocal) { st.folders.set(f.id, f); await DB.put('folders', f); }
        for (const id of p.delLocal) {
          if (id === streamingId) continue;
          const c = st.chats.get(id);
          Object.assign(c, { deleted: true, messages: [], title: '', pinned: false, updatedAt: remote.chats[id].updatedAt });
          await DB.put('chats', c);
          if (id === st.current) touchedCurrent = true;
        }
        for (const id of p.down) {
          if (id === streamingId) continue;
          const t = await fileText(g?.files?.[chatFile(id)]);
          if (!t) continue;
          let rc; try { rc = JSON.parse(t); } catch { continue; }
          rc.deleted = false; rc.messages = rc.messages || [];
          st.chats.set(id, rc); await DB.put('chats', rc);
          if (id === st.current) touchedCurrent = true;
        }

        const files = {}, index = { v: 1, app: 'lavanda', updatedAt: now(), chats: { ...(remote?.chats || {}) }, folders: p.mergedFolders };
        let upCount = 0;
        for (const id of p.up) {
          const c = st.chats.get(id);
          if (!c || (id === streamingId && c.messages.some(m => m.pending))) continue;
          index.chats[id] = { updatedAt: c.updatedAt, deleted: !!c.deleted };
          if (c.deleted) { if (g?.files?.[chatFile(id)]) files[chatFile(id)] = null; }
          else files[chatFile(id)] = { content: JSON.stringify(stripChat(c)) };
          upCount++;
        }
        const names = Object.keys(files), created = !g;
        if (created) {
          const res = await gh('/gists', { method: 'POST', body: JSON.stringify({ description: DESC, public: false, files: { [IDX]: { content: JSON.stringify(index) } } }) });
          gistId = res.id;
        }
        // chat files first, the index last: another device only follows the index
        for (let i = 0; i < names.length; i += 15) {
          const part = {}; for (const n of names.slice(i, i + 15)) part[n] = files[n];
          await gh('/gists/' + gistId, { method: 'PATCH', body: JSON.stringify({ files: part }) });
        }
        if (names.length || (!created && (upCount || p.foldersChanged))) {
          await gh('/gists/' + gistId, { method: 'PATCH', body: JSON.stringify({ files: { [IDX]: { content: JSON.stringify(index) } } }) });
        }
        S.gistId = gistId; S.lastSync = now(); saveSettings();
        if (p.down.length || p.delLocal.length || p.folderToLocal.length) {
          renderNav();
          if (touchedCurrent) { const c = currentChat(); if (!c || c.deleted) newChat(); else { renderThread(); updateTopbar(); } }
        }
        setStatus('ok');
      } catch (e) {
        console.warn('sync', e);
        setStatus('err', e instanceof SyncError ? e.message : navigator.onLine === false ? 'Нет интернета, синхронизирую позже' : 'Не получилось синхронизировать');
      } finally {
        running = false;
        if (again) { again = false; setTimeout(run, 400); }
      }
    }
    function schedule(ms = 2500) { if (!enabled()) return; clearTimeout(timer); timer = setTimeout(run, ms); }
    async function connect(token) {
      S.ghToken = token; S.gistId = '';
      try { await gh('/gists?per_page=1'); }
      catch (e) { S.ghToken = ''; setStatus('off'); throw e; }
      saveSettings(); await run();
    }
    function disconnect() { S.ghToken = ''; S.gistId = ''; S.lastSync = 0; saveSettings(); clearTimeout(timer); setStatus('off'); }
    function init() {
      setStatus(enabled() ? 'ok' : 'off');
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(300); });
      addEventListener('online', () => schedule(300));
      setInterval(() => { if (enabled() && document.visibilityState === 'visible' && !running) run(); }, 90000);
      if (enabled()) run();
    }
    return { run, schedule, connect, disconnect, init, plan, enabled, get state() { return state; }, get error() { return errText; } };
  })();

  /* ---------------- settings dialog ---------------- */
  const setOv = $('#settings');
  function fillModelSelect() {
    const sel = $('#setModel');
    sel.innerHTML = S.models.length
      ? S.models.map(m => `<option value="${esc(m.id)}"${m.id === S.model ? ' selected' : ''}>${esc(m.name)}</option>`).join('')
      : `<option value="">${S.apiKey ? 'Нажми «Проверить ключ»' : 'Сначала вставь ключ'}</option>`;
  }
  function openSettings(focusSync) {
    closeMenu(); closeSidebar();
    $('#setKey').value = S.apiKey; fillModelSelect();
    $('#setSystem').value = S.system; $('#setContext').value = String(S.context);
    $('#setSearch').checked = !!S.search; $('#setEnter').checked = !!S.enterSends;
    $('#setToken').value = '';
    $$('#fsSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.fs === S.fs)));
    $('#syncOff').hidden = Sync.enabled(); $('#syncOn').hidden = !Sync.enabled();
    setOv.hidden = false;
    if (focusSync) $('#btnSyncConnect').closest('.set-section').scrollIntoView({ block: 'start' });
    else setOv.querySelector('.dialog-body').scrollTop = 0;
  }
  const closeSettings = () => { setOv.hidden = true; };
  $('#btnSettings').onclick = () => openSettings(false);
  $('#syncStatus').onclick = () => openSettings(true);
  setOv.addEventListener('click', e => { if (e.target === setOv || e.target.closest('[data-close]')) closeSettings(); });
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-toggle-pw]'); if (!t) return;
    const i = document.getElementById(t.dataset.togglePw); i.type = i.type === 'password' ? 'text' : 'password';
  });

  $('#setKey').addEventListener('change', async e => {
    const v = e.target.value.trim(); if (v === S.apiKey) return;
    S.apiKey = v; saveSettings(); renderThread();
    if (v) refreshModels(true);
  });
  $('#btnCheckKey').onclick = async () => {
    const v = $('#setKey').value.trim();
    if (v !== S.apiKey) { S.apiKey = v; saveSettings(); renderThread(); }
    await refreshModels(true);
  };
  $('#setModel').addEventListener('change', e => { if (e.target.value) { S.model = e.target.value; saveSettings(); updateModelChip(); } });
  let sysT = 0;
  $('#setSystem').addEventListener('input', e => { clearTimeout(sysT); sysT = setTimeout(() => { S.system = e.target.value; saveSettings(); }, 300); });
  $('#setContext').addEventListener('change', e => { S.context = +e.target.value; saveSettings(); });
  $('#setSearch').addEventListener('change', e => { S.search = e.target.checked; st.searchOn = S.search; saveSettings(); updateSearchChip(); });
  $('#setEnter').addEventListener('change', e => { S.enterSends = e.target.checked; saveSettings(); });
  $('#fsSeg').addEventListener('click', e => {
    const b = e.target.closest('[data-fs]'); if (!b) return;
    S.fs = b.dataset.fs; saveSettings(); applyFs();
    $$('#fsSeg button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  });
  const applyFs = () => { document.documentElement.dataset.fs = S.fs; };

  $('#btnSyncConnect').onclick = async () => {
    if (DEMO) { toast('В превью синхронизация не работает. В установленной версии — работает.'); return; }
    const t = $('#setToken').value.trim();
    if (!t) { toast('Вставь токен GitHub', 'err'); return; }
    const b = $('#btnSyncConnect'); b.disabled = true; b.textContent = 'Подключаю…';
    try { await Sync.connect(t); toast('Синхронизация подключена', 'ok'); $('#syncOff').hidden = true; $('#syncOn').hidden = false; }
    catch (e) { toast(e.message || 'Не получилось подключиться к GitHub', 'err', 6000); }
    finally { b.disabled = false; b.innerHTML = `${icon('cloud')}Подключить синхронизацию`; }
  };
  $('#btnSyncNow').onclick = () => Sync.run();
  $('#btnSyncOff').onclick = async () => {
    if (!(await confirmDialog('Отключить синхронизацию на этом устройстве? Чаты останутся здесь и в GitHub.', 'Отключить'))) return;
    Sync.disconnect(); $('#syncOff').hidden = false; $('#syncOn').hidden = true;
  };

  /* export / import / wipe */
  $('#btnExport').onclick = () => {
    if (DEMO) { toast('В превью скачивание не работает. В установленной версии — работает.'); return; }
    const data = { app: 'lavanda', v: 1, exportedAt: new Date().toISOString(), folders: [...st.folders.values()], chats: liveChats() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `lavanda-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  $('#btnImport').onclick = () => $('#importInput').click();
  $('#importInput').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (d.app !== 'lavanda' || !Array.isArray(d.chats)) throw new Error('bad');
      let n = 0;
      for (const fo of d.folders || []) { const L = st.folders.get(fo.id); if (!L || fo.updatedAt > L.updatedAt) { st.folders.set(fo.id, fo); await DB.put('folders', fo); } }
      for (const c of d.chats) { const L = st.chats.get(c.id); if (!L || c.updatedAt > L.updatedAt) { st.chats.set(c.id, c); await DB.put('chats', c); n++; } }
      renderNav(); Sync.schedule(500); toast(`Загружено чатов: ${n}`, 'ok');
    } catch { toast('Это не похоже на копию чатов Лаванды', 'err'); }
  });
  $('#btnWipe').onclick = async () => {
    const msg = Sync.enabled()
      ? 'Удалить все чаты и папки с этого устройства? Синхронизация включена, поэтому при следующем запуске они снова скачаются из GitHub.'
      : 'Удалить все чаты и папки с этого устройства? Восстановить их можно только из скачанной копии.';
    if (!(await confirmDialog(msg))) return;
    if (st.stream) st.stream.ctrl.abort();
    await Promise.all(['chats', 'folders', 'files'].map(s => DB.clear(s).catch(() => {})));
    st.chats.clear(); st.folders.clear(); st.fileCache.clear(); st.mdCache.clear();
    closeSettings(); newChat(); toast('Готово', 'ok');
  };

  /* install */
  let installPrompt = null;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; $('#installSection').hidden = false; $('#btnInstall').hidden = false; });
  addEventListener('appinstalled', () => { $('#installSection').hidden = true; toast('Лаванда установлена', 'ok'); });
  if (!standalone && /iphone|ipad|ipod/i.test(navigator.userAgent) && !DEMO) {
    $('#installSection').hidden = false; $('#btnInstall').hidden = true;
    $('#installText').innerHTML = 'На iPhone: открой этот сайт в Safari, нажми <b>Поделиться</b> и выбери <b>На экран «Домой»</b>.';
  }
  $('#btnInstall').onclick = async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice.catch(() => {}); installPrompt = null; };

  /* welcome */
  $('#welcomeSave').onclick = async () => {
    const v = $('#welcomeKey').value.trim();
    if (!/^\S{20,}$/.test(v)) { toast('Ключ выглядит неполным. Скопируй его целиком, без пробелов.', 'err'); return; }
    const b = $('#welcomeSave'); b.disabled = true; b.textContent = 'Проверяю…';
    S.apiKey = v; saveSettings();
    const res = await refreshModels(true);
    b.disabled = false; b.textContent = 'Подключить';
    if (res === 'badkey') { S.apiKey = ''; saveSettings(); return; }
    if (res === 'error' && !S.model) { S.model = 'gemini-flash-latest'; saveSettings(); updateModelChip(); }
    renderThread(); input.focus();
  };
  $('#welcomeKey').addEventListener('keydown', e => { if (e.key === 'Enter') $('#welcomeSave').click(); });

  /* keyboard */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!menu.hidden) { closeMenu(); return; }
      if (!setOv.hidden) { closeSettings(); return; }
      if (appEl.classList.contains('side-open')) { closeSidebar(); return; }
      if (rec) rec.stop();
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.altKey && (e.code === 'KeyN')) { e.preventDefault(); newChat(); }
    if (mod && !e.altKey && e.code === 'KeyK') { e.preventDefault(); if (isMobile()) openSidebar(); $('#searchInput').focus(); }
  });

  /* ---------------- demo seed (preview only) ---------------- */
  function seedDemo() {
    const t = now(), H = 36e5, fid = 'demofolder1';
    st.folders.set(fid, { id: fid, name: 'Учёба', createdAt: t - 50 * H, updatedAt: t - 50 * H, deleted: false });
    st.openFolders.add(fid);
    const mk = (id, title, ago, extra, msgs) => st.chats.set(id, { id, title, titleManual: false, folderId: null, pinned: false, createdAt: t - ago * H, updatedAt: t - ago * H, deleted: false, messages: msgs, ...extra });
    mk('demo1', 'Почему растут цены', 0.4, {}, [
      { id: 'd1a', role: 'user', text: 'Объясни простыми словами, почему растут цены и что такое инфляция', at: t - 0.5 * H },
      { id: 'd1b', role: 'model', model: 'gemini-flash', at: t - 0.4 * H, text:
        'Инфляция — это когда на одни и те же деньги со временем можно купить меньше. Цены растут не на один товар, а почти на всё сразу.\n\n**Главные причины:**\n\n1. **Денег становится больше, чем товаров.** Если у людей появилось больше денег, а хлеба и машин столько же, продавцы поднимают цены.\n2. **Дорожает производство.** Растут цены на топливо, сырьё и зарплаты, и компании перекладывают это в цену.\n3. **Ожидания.** Если все ждут подорожания, то покупают заранее, и спрос сам разгоняет цены.\n\nНебольшая инфляция, около 2–4% в год, считается нормой. Проблемы начинаются, когда она становится двузначной.\n\n> Простой пример: если инфляция 8%, то 1000 рублей через год «весят» как 926 сегодняшних.',
        sources: [{ uri: 'https://ru.wikipedia.org/wiki/Инфляция', title: 'ru.wikipedia.org' }, { uri: 'https://cbr.ru', title: 'cbr.ru' }, { uri: 'https://fincult.info', title: 'fincult.info' }],
        queries: ['что такое инфляция простыми словами', 'причины роста цен'] },
    ]);
    mk('demo2', 'План подготовки к экзамену', 26, { folderId: fid }, [
      { id: 'd2a', role: 'user', text: 'Составь план подготовки к экзамену по истории за 3 недели', at: t - 27 * H },
      { id: 'd2b', role: 'model', model: 'gemini-flash', at: t - 26 * H, text:
        'Вот спокойный план на три недели, по 1,5 часа в день:\n\n| Неделя | Темы | Как проверить себя |\n|---|---|---|\n| 1 | Древняя Русь и Московское царство | 20 дат на карточках |\n| 2 | Российская империя | Схема реформ по векам |\n| 3 | XX век и повторение | Два пробных варианта |\n\nВ последние два дня новое не учи: только повторение и сон.' },
    ]);
    mk('demo3', 'Рецепт сырников без муки', 70, { pinned: true }, [
      { id: 'd3a', role: 'user', text: 'Как сделать сырники без муки, чтобы не разваливались?', at: t - 71 * H },
      { id: 'd3b', role: 'model', model: 'gemini-flash', at: t - 70 * H, text: 'Возьми сухой творог 5–9%, одно яйцо на 400 г и 2 столовые ложки манки или рисовой муки. Дай массе постоять 15 минут, чтобы крупа набухла, и жарь на среднем огне под крышкой.' },
    ]);
    mk('demo4', 'Код: сортировка списка в Python', 200, { folderId: fid }, [
      { id: 'd4a', role: 'user', text: 'Как отсортировать список словарей по ключу?', at: t - 201 * H },
      { id: 'd4b', role: 'model', model: 'gemini-flash', at: t - 200 * H, text: 'Через `sorted` с параметром `key`:\n\n```python\nusers = [{"name": "Аня", "age": 24}, {"name": "Борис", "age": 19}]\nby_age = sorted(users, key=lambda u: u["age"])\n```\n\nЧтобы по убыванию, добавь `reverse=True`.' },
    ]);
    st.current = 'demo1';
  }
  async function demoStream(mm, signal) {
    const text = 'Это превью Лаванды, поэтому ответ ненастоящий. В установленной версии здесь потоком ответит **Gemini**, а при включённом поиске Google внизу появятся ссылки на источники.\n\nПока можно проверить остальное: создать папку, переименовать или закрепить чат, прикрепить фото.';
    for (let i = 0; i < text.length; i += 4) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      mm.text += text.slice(i, i + 4); paintStream();
      await new Promise(r => setTimeout(r, 22));
    }
    if (mm.search) { mm.sources = [{ uri: 'https://ai.google.dev/gemini-api/docs', title: 'ai.google.dev' }]; mm.queries = ['пример поискового запроса']; }
  }

  /* ---------------- boot ---------------- */
  async function init() {
    applyFs(); updateSearchChip(); setSending(false);
    const persistent = await DB.init();
    if (!persistent && !DEMO) toast('Браузер не даёт сохранять данные: чаты пропадут после закрытия. Не открывай приложение в режиме инкогнито.', 'err', 8000);
    navigator.storage?.persist?.().catch(() => {});
    if (DEMO) seedDemo();
    else {
      const [chats, folders] = await Promise.all([DB.all('chats').catch(() => []), DB.all('folders').catch(() => [])]);
      for (const c of chats) {
        for (const m of c.messages || []) if (m.pending) { m.pending = false; if (!m.text) m.error = 'Ответ прервался. Нажми «Повторить».'; }
        st.chats.set(c.id, c);
      }
      for (const f of folders) st.folders.set(f.id, f);
      const last = ls.get('lavanda.last', '');
      if (last && st.chats.get(last) && !st.chats.get(last).deleted) st.current = last;
      input.value = ls.get('lavanda.draft', '') || '';
    }
    renderNav(); renderThread(); updateTopbar(); updateModelChip(); autosize(); updateSendBtn();
    if (S.apiKey && !S.models.length) refreshModels(false);
    Sync.init();
    if ('serviceWorker' in navigator && location.protocol === 'https:' && !DEMO) navigator.serviceWorker.register('sw.js').catch(() => {});
    if (!coarse && (S.apiKey || DEMO)) input.focus({ preventScroll: true });
  }

  window.__lavanda = { parseSSE: Gemini.parseSSE, plan: Sync.plan, st, S };
  init();
})();
