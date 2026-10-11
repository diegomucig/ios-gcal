'use strict';
/* Calendario iOS — vista calendario in stile iPhone per Google Calendar.
 * Usa le chiavi già presenti in _config/google-sync.md (nessun nuovo login).
 * Funziona su PC, tablet e iPhone (solo requestUrl, nessuna API Node). */
const { Plugin, ItemView, Modal, Notice, PluginSettingTab, Setting, requestUrl, setIcon } = require('obsidian');

const VIEW_TYPE = 'ios-gcal-view';
const PALETTE = ['#007AFF', '#FF3B30', '#34C759', '#FF9500', '#AF52DE', '#FF2D55', '#5AC8FA', '#A2845E', '#FFCC00', '#30B0C7'];
const MESI = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
const MESI_BREVI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const GIORNI = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];
const GIORNI_BREVI = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const HOUR_PX = 52;
const FUTURI = 'Promemoria/Futuri';
const PASSATI = 'Promemoria/Passati';
const cartellaPerData = (giorno) => (giorno >= ymd(new Date()) ? FUTURI : PASSATI);
const FENCING = 'Fencing';
const REGISTRO = 'Fencing/Registro gare.md';
const CESTINO = '_da eliminare';
const UNIV = 'University';
const LUOGO_UNIVERSITA = 'Università degli Studi di Udine, Via delle Scienze, 206, 33100 Udine UD';
const CAT_GARA = 'Gara di scherma';
const SYNC_URI = 'obsidian://quickadd?choice=Sincronizza%20Calendar';

const DEFAULTS = {
  configPath: '_config/google-sync.md',
  defaultView: 'month',
  weekStartsMonday: true,
  hidden: {},
  lastView: 'month',
  sidebarClosed: false,
};

/* ---------- utilità data ---------- */
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const parseLocal = (dateStr, timeStr) => { const [y, m, d] = dateStr.split('-').map(Number); const [hh, mm] = (timeStr || '00:00').split(':').map(Number); return new Date(y, m - 1, d, hh, mm); };

/* --- stesse regole dello script di sync, per riconoscere cosa è ancora da sincronizzare --- */
function orarioNorm(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
  const m = String(v).match(/^(\d{1,2}):(\d{2})/);
  return m ? m[1].padStart(2, '0') + ':' + m[2] : '';
}
function luogoTesto(v) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  const m = s.match(/^\[([^\]]*)\]\(/);
  return m ? m[1].trim() : s;
}
function hashS(s) {
  let x = 5381;
  for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0;
  return (x >>> 0).toString(36);
}
function quandoSync(giorno, hhmm, ore) {
  if (!hhmm) return { start: { date: giorno }, end: { date: ymd(addDays(parseYmd(giorno), 1)) } };
  const f = (d) => `${ymd(d)}T${hm(d)}:00`;
  const inizio = parseLocal(giorno, hhmm);
  const fine = new Date(inizio.getFullYear(), inizio.getMonth(), inizio.getDate(), inizio.getHours() + ore, inizio.getMinutes());
  return { start: { dateTime: f(inizio), timeZone: 'Europe/Rome' }, end: { dateTime: f(fine), timeZone: 'Europe/Rome' } };
}
const mapsLink = (t) => (t ? `[${t}](https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(t)})` : '');
const safeName = (n) => n.replace(/[\\/:*?"<>|#^\[\]]/g, '').trim();
function stagione(giorno) {
  const [y, m] = giorno.split('-').map(Number);
  const y0 = m >= 9 ? y : y - 1;
  return `SS ${String(y0).slice(2)}-${String(y0 + 1).slice(2)}`;
}

function h(tag, cls, text, parent) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined && text !== null && text !== '') el.textContent = text;
  if (parent) parent.appendChild(el);
  return el;
}

function readableOn(hex) {
  const c = (hex || '#007AFF').replace('#', '');
  const r = parseInt(c.substr(0, 2), 16), g = parseInt(c.substr(2, 2), 16), b = parseInt(c.substr(4, 2), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 175 ? '#1c1c1e' : '#ffffff';
}

/* ---------- plugin ---------- */
module.exports = class IosGcalPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.token = null;
    this.tokenExp = 0;
    this.calendars = [];
    this.calendarsLimited = false;
    this.cache = new Map();      // "YYYY-MM" -> true (mese caricato)
    this.events = new Map();     // calId|id -> evento normalizzato
    this.registerView(VIEW_TYPE, (leaf) => new CalendarView(leaf, this));
    this.addRibbonIcon('calendar-days', 'Calendario', () => this.activateView());
    this.addCommand({ id: 'open-calendar', name: 'Apri calendario', callback: () => this.activateView() });
    this.addCommand({ id: 'new-event', name: 'Nuovo evento', callback: async () => { await this.activateView(); } });
    this.addSettingTab(new IosGcalSettings(this.app, this));
    this.cfg = {};
    this._dirty = true;
    this._merged = [];
    const touch = (file) => {
      this._dirty = true;
      if (file && file.path && file.path.startsWith(FENCING + '/') && file.path !== REGISTRO) this.registroLink(file);
      if (file && file.path && (file.path.startsWith(FUTURI + '/') || file.path.startsWith(PASSATI + '/'))) { clearTimeout(this._sm); this._sm = setTimeout(() => this.smista(), 1500); }
      this.pingViews();
    };
    this.registerEvent(this.app.metadataCache.on('changed', touch));
    this.registerEvent(this.app.vault.on('delete', () => touch(null)));
    this.registerEvent(this.app.vault.on('rename', () => touch(null)));
    this.registerInterval(window.setInterval(() => this.smista(), 30 * 60 * 1000));
    this.app.workspace.onLayoutReady(() => {
      setTimeout(() => this.smista(), 1500);
      this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(FENCING + '/') && f.path !== REGISTRO).forEach((f) => this.registroLink(f));
    });
  }

  /* Futuri <-> Passati in base alla data della nota (la data di oggi è ancora "futuro") */
  async smista() {
    if (this._smistando) return;
    this._smistando = true;
    try {
      const oggi = ymd(new Date());
      const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(FUTURI + '/') || f.path.startsWith(PASSATI + '/'));
      for (const f of files) {
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
        const giorno = fm && fm.Data ? String(fm.Data).slice(0, 10) : '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(giorno)) continue;
        if (String(fm.Categoria || '').trim() === CAT_GARA && fm.Nome) { // le gare vanno subito in Fencing, nella cartella della stagione
          const safe = safeName(String(fm.Nome)) || 'Gara';
          const base = `${giorno} ${safe}`, cart = `${FENCING}/${stagione(giorno)}/${base}`;
          let cur = '';
          for (const part of cart.split('/')) { cur = cur ? cur + '/' + part : part; if (!this.app.vault.getAbstractFileByPath(cur)) await this.app.vault.createFolder(cur); }
          let dp = `${cart}/${base}.md`;
          if (this.app.vault.getAbstractFileByPath(dp)) dp = `${cart}/${base} - ${Date.now()}.md`;
          try { await this.app.fileManager.renameFile(f, dp); } catch (e) { /* riprova */ }
          continue;
        }
        const inFuturi = f.path.startsWith(FUTURI + '/');
        const dest = inFuturi ? (giorno < oggi ? PASSATI : null) : (giorno >= oggi ? FUTURI : null);
        if (!dest) continue;
        if (!this.app.vault.getAbstractFileByPath(dest)) await this.app.vault.createFolder(dest);
        let path = `${dest}/${f.name}`;
        if (this.app.vault.getAbstractFileByPath(path)) path = `${dest}/${f.basename} - ${Date.now()}.md`;
        try { await this.app.fileManager.renameFile(f, path); } catch (e) { /* riprova al prossimo giro */ }
      }
    } finally { this._smistando = false; }
  }

  pingViews() {
    clearTimeout(this._ping);
    this._ping = setTimeout(() => this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((l) => l.view && l.view.render && l.view.render()), 250);
  }

  /* una gara con il risultato compilato entra nei collegamenti del Registro gare */
  async registroLink(file) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const ris = fm && (fm.Risultati !== undefined ? fm.Risultati : fm.risultati);
    if (ris === undefined || ris === null || String(ris).trim() === '') return;
    const reg = this.app.vault.getAbstractFileByPath(REGISTRO);
    if (!reg) return;
    const RX = /(%%COLLEGAMENTI-INIZIO%%\n)([\s\S]*?)(> %%COLLEGAMENTI-FINE%%)/;
    try {
      await this.app.vault.process(reg, (txt) => {
        const m = txt.match(RX);
        if (!m) return txt;
        const esistenti = [...m[2].matchAll(/\[\[([^\]]+)\]\]/g)].map((x) => x[1]);
        if (esistenti.includes(file.basename)) return txt;
        esistenti.push(file.basename);
        return txt.replace(RX, (_, a, b, c) => `${a}> ${esistenti.map((n) => `[[${n}]]`).join(' · ')}\n${c}`);
      });
    } catch (e) { /* riprova alla prossima modifica */ }
  }

  onunload() { this.app.workspace.detachLeavesOfType(VIEW_TYPE); }

  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  saveSettings() { return this.saveData(this.settings); }

  /* ----- configurazione e token ----- */
  async readConfig() {
    const path = this.settings.configPath;
    let txt;
    try { txt = await this.app.vault.adapter.read(path); }
    catch (e) { throw new Error(`Non trovo ${path}. Controlla il percorso nelle impostazioni del plugin.`); }
    const cfg = {};
    txt.split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*(?:[-*]\s*)?`?([A-Za-z0-9_]+)`?\s*[:=]\s*`?(.*?)`?\s*$/);
      if (m && m[2]) cfg[m[1]] = m[2].trim();
    });
    this.cfg = cfg;
    return cfg;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExp - 60000) return this.token;
    const cfg = await this.readConfig();
    if (!cfg.CLIENT_ID || !cfg.CLIENT_SECRET || !cfg.REFRESH_TOKEN) throw new Error('Mancano CLIENT_ID, CLIENT_SECRET o REFRESH_TOKEN in ' + this.settings.configPath);
    const body = new URLSearchParams({ client_id: cfg.CLIENT_ID, client_secret: cfg.CLIENT_SECRET, refresh_token: cfg.REFRESH_TOKEN, grant_type: 'refresh_token' }).toString();
    const r = await requestUrl({ url: 'https://oauth2.googleapis.com/token', method: 'POST', contentType: 'application/x-www-form-urlencoded', body, throw: false });
    if (r.status !== 200) throw new Error('Login Google non riuscito (' + r.status + '). Il refresh token potrebbe essere scaduto.');
    this.token = r.json.access_token;
    this.tokenExp = Date.now() + (r.json.expires_in || 3600) * 1000;
    return this.token;
  }

  async api(method, path, query, body) {
    const token = await this.getToken();
    let url = 'https://www.googleapis.com/calendar/v3' + path;
    if (query) url += '?' + new URLSearchParams(query).toString();
    const opts = { url, method, headers: { Authorization: 'Bearer ' + token }, throw: false };
    if (body) { opts.contentType = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await requestUrl(opts);
    if (r.status >= 400) { const err = new Error((r.json && r.json.error && r.json.error.message) || ('Errore ' + r.status)); err.status = r.status; throw err; }
    return r.status === 204 ? null : r.json;
  }

  /* ----- calendari ----- */
  async loadCalendars() {
    let list = null;
    try {
      const res = await this.api('GET', '/users/me/calendarList', { minAccessRole: 'reader', maxResults: '250' });
      list = (res.items || []).map((c, i) => ({
        id: c.id, name: c.summaryOverride || c.summary || c.id,
        color: c.backgroundColor || PALETTE[i % PALETTE.length],
        writable: c.accessRole === 'owner' || c.accessRole === 'writer', primary: !!c.primary,
      }));
      this.calendarsLimited = false;
    } catch (e) {
      if (e.status !== 403 && e.status !== 401) throw e;
      this.calendarsLimited = true;
    }
    if (!list) {
      const cfg = await this.readConfig();
      const nomi = { PRINCIPALE: 'Principale', SCHERMA: 'Scherma', UNIVERSITY: 'University' };
      const colori = { PRINCIPALE: '#007AFF', SCHERMA: '#FF9500', UNIVERSITY: '#34C759' };
      list = Object.keys(cfg).filter((k) => k.startsWith('CALENDARIO_')).map((k, i) => {
        const key = k.replace('CALENDARIO_', '');
        return { id: cfg[k], name: nomi[key] || key.charAt(0) + key.slice(1).toLowerCase(), color: colori[key] || PALETTE[i % PALETTE.length], writable: true, primary: key === 'PRINCIPALE' };
      });
    }
    this.calendars = list;
    return list;
  }

  isHidden(id) { return !!this.settings.hidden[id]; }
  async toggleCalendar(id) {
    if (this.settings.hidden[id]) delete this.settings.hidden[id]; else this.settings.hidden[id] = true;
    await this.saveSettings();
  }
  calendarById(id) { return this.calendars.find((c) => c.id === id); }

  /* ----- eventi ----- */
  normalize(calId, e) {
    const allDay = !!(e.start && e.start.date);
    const start = allDay ? parseYmd(e.start.date) : new Date(e.start.dateTime);
    const end = allDay ? parseYmd(e.end.date) : new Date(e.end.dateTime);
    return {
      key: calId + '|' + e.id, id: e.id, calId, allDay, start, end,
      title: e.summary || '(Senza titolo)', location: e.location || '', description: e.description || '',
      vaultTipo: e.extendedProperties && e.extendedProperties.private ? e.extendedProperties.private.vaultTipo : '',
      vaultCorso: e.extendedProperties && e.extendedProperties.private ? e.extendedProperties.private.vaultCorso : '',
      status: e.status, link: e.htmlLink, fromVault: !!(e.extendedProperties && e.extendedProperties.private && (e.extendedProperties.private.vaultTipo || e.extendedProperties.private.vaultHash)),
    };
  }

  async ensureMonth(year, month) {
    const key = year + '-' + pad(month + 1);
    if (this.cache.has(key)) return;
    const from = new Date(year, month, 1, 0, 0), to = new Date(year, month + 1, 1, 0, 0);
    await Promise.all(this.calendars.map(async (cal) => {
      let pageToken;
      do {
        const q = { timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '2500' };
        if (pageToken) q.pageToken = pageToken;
        let res;
        try { res = await this.api('GET', '/calendars/' + encodeURIComponent(cal.id) + '/events', q); }
        catch (e) { if (e.status === 404) return; throw e; }
        (res.items || []).forEach((it) => { if (it.status !== 'cancelled' && it.start && it.end) { const ev = this.normalize(cal.id, it); this.events.set(ev.key, ev); } });
        pageToken = res.nextPageToken;
      } while (pageToken);
    }));
    this.cache.set(key, true);
    this._dirty = true;
  }

  async ensureRange(from, to) {
    const months = [];
    let d = new Date(from.getFullYear(), from.getMonth(), 1);
    while (d < to) { months.push([d.getFullYear(), d.getMonth()]); d = new Date(d.getFullYear(), d.getMonth() + 1, 1); }
    await Promise.all(months.map(([y, m]) => this.ensureMonth(y, m)));
  }

  clearCache() { this.cache.clear(); this.events.clear(); this._dirty = true; }

  /* ----- note del vault: sono loro la fonte di verità per gli eventi che hanno una nota ----- */
  parseNote(file) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || !fm.Nome) return null;
    const nome = String(fm.Nome).trim();
    const giorno = fm.Data ? String(fm.Data).slice(0, 10) : '';
    if (!nome || !/^\d{4}-\d{2}-\d{2}$/.test(giorno)) return null;
    const hhmm = orarioNorm(fm.Orario);
    const cat = String(fm.Categoria || '').trim();
    const cfg = this.cfg || {};
    const target = cat === CAT_GARA ? cfg.CALENDARIO_SCHERMA : cfg.CALENDARIO_PRINCIPALE;
    const luogo = luogoTesto(fm.Luogo) || (cat === 'Università' ? LUOGO_UNIVERSITA : '');
    const dettagli = fm.Dettagli ? String(fm.Dettagli) : '';
    const evento = { summary: nome, location: luogo, description: dettagli, ...quandoSync(giorno, hhmm, 1) };
    const impronta = hashS(JSON.stringify(evento) + '|' + target);
    const id = fm.GoogleEventId ? String(fm.GoogleEventId) : '';
    const calPrima = fm.GoogleCalendar ? String(fm.GoogleCalendar) : '';
    return { file, nome, giorno, hhmm, cat, target, luogo, luogoRaw: fm.Luogo ? String(fm.Luogo) : '', dettagli, id, calPrima, impronta, pending: !id || calPrima !== target || String(fm.GoogleHash || '') !== impronta };
  }

  noteEvent(n) {
    const start = parseLocal(n.giorno, n.hhmm || '00:00');
    const end = n.hhmm ? new Date(start.getTime() + 3600000) : addDays(start, 1);
    return { key: 'nota|' + n.file.path, id: n.id, calId: n.target, allDay: !n.hhmm, start, end, title: n.nome, location: n.luogo, description: n.dettagli, note: n, pending: n.pending, vaultTipo: '', vaultCorso: '' };
  }

  merged() {
    if (!this._dirty) return this._merged;
    const oggi = ymd(new Date());
    const files = this.app.vault.getMarkdownFiles().filter((f) => (f.path.startsWith(FUTURI + '/') || f.path.startsWith(PASSATI + '/') || (f.path.startsWith(FENCING + '/') && f.path !== REGISTRO) || f.path.startsWith(CESTINO + '/')));
    const attive = [], cestino = new Set();
    this.pendingDeletes = 0;
    files.forEach((f) => {
      const n = this.parseNote(f);
      if (!n) return;
      if (f.path.startsWith(CESTINO + '/')) { if (n.id && n.giorno >= oggi) { cestino.add(n.id); this.pendingDeletes++; } }
      else attive.push(n);
    });
    const byId = new Map();
    attive.forEach((n) => { if (n.id) byId.set(n.id, n); });
    let out = [];
    this.events.forEach((g) => { if (!cestino.has(g.id) && !byId.has(g.id)) out.push(g); });
    attive.forEach((n) => {
      if (n.id) { out.push(this.noteEvent(n)); return; }
      if (n.giorno < oggi) return; // come lo script: le note passate non si sincronizzano
      const ne = this.noteEvent(n);
      const i = out.findIndex((g) => !g.note && g.calId === n.target && sameDay(g.start, ne.start) && g.title.trim().toLowerCase() === n.nome.toLowerCase());
      if (i >= 0) out[i] = ne; else out.push(ne);
    });
    this._merged = out;
    this._dirty = false;
    return out;
  }

  pendingCount() { this.merged(); return this._merged.filter((e) => e.note && e.pending).length + (this.pendingDeletes || 0); }

  eventsBetween(from, to) {
    const out = [];
    this.merged().forEach((ev) => {
      if (this.isHidden(ev.calId)) return;
      if (ev.start < to && ev.end > from && !(ev.end.getTime() === ev.start.getTime() && ev.start < from)) out.push(ev);
    });
    out.sort((a, b) => (a.allDay === b.allDay ? a.start - b.start : a.allDay ? -1 : 1));
    return out;
  }

  eventsOnDay(day) { const s = startOfDay(day); return this.eventsBetween(s, addDays(s, 1)); }

  /* ----- scrittura ----- */
  buildBody(f) {
    const body = { summary: f.title, location: f.location || null, description: f.description || null };
    if (f.allDay) {
      body.start = { date: f.startDate, dateTime: null };
      body.end = { date: ymd(addDays(parseYmd(f.endDate), 1)), dateTime: null };
    } else {
      body.start = { dateTime: parseLocal(f.startDate, f.startTime).toISOString(), date: null };
      body.end = { dateTime: parseLocal(f.endDate, f.endTime).toISOString(), date: null };
    }
    return body;
  }

  async createEvent(calId, f) {
    const body = this.buildBody(f);
    Object.keys(body).forEach((k) => body[k] === null && delete body[k]);
    const clean = (o) => { Object.keys(o).forEach((k) => o[k] === null && delete o[k]); return o; };
    clean(body.start); clean(body.end);
    await this.api('POST', '/calendars/' + encodeURIComponent(calId) + '/events', null, body);
    this.clearCache();
  }

  async updateEvent(ev, calId, f) {
    const body = this.buildBody(f);
    if (calId !== ev.calId) {
      // cambio di calendario: sposta, poi aggiorna
      await this.api('POST', '/calendars/' + encodeURIComponent(ev.calId) + '/events/' + encodeURIComponent(ev.id) + '/move', { destination: calId });
    }
    await this.api('PATCH', '/calendars/' + encodeURIComponent(calId) + '/events/' + encodeURIComponent(ev.id), null, body);
    this.clearCache();
  }

  async deleteEvent(ev) {
    await this.api('DELETE', '/calendars/' + encodeURIComponent(ev.calId) + '/events/' + encodeURIComponent(ev.id));
    this.clearCache();
  }
};

/* ---------- vista ---------- */
class CalendarView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.mode = plugin.settings.lastView || plugin.settings.defaultView;
    this.cursor = startOfDay(new Date());   // giorno di riferimento
    this.selected = startOfDay(new Date()); // giorno selezionato (mese su mobile)
    this.loading = false;
    this.error = null;
    this.sidebarOpen = false;
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Calendario'; }
  getIcon() { return 'calendar-days'; }

  async onOpen() {
    this.contentEl.addClass('igc-root');
    this.ro = new ResizeObserver(() => this.applySize());
    this.ro.observe(this.contentEl);
    this.timer = window.setInterval(() => this.refresh(false), 5 * 60 * 1000);
    this.registerInterval(this.timer);
    await this.refresh(true);
  }
  async onClose() { if (this.ro) this.ro.disconnect(); }

  applySize() {
    const w = this.contentEl.clientWidth;
    this.contentEl.toggleClass('igc-narrow', w > 0 && w < 640);
  }

  weekStart(d) {
    const s = startOfDay(d);
    const dow = s.getDay();
    const diff = this.plugin.settings.weekStartsMonday ? (dow + 6) % 7 : dow;
    return addDays(s, -diff);
  }

  range() {
    if (this.mode === 'month') {
      const first = new Date(this.cursor.getFullYear(), this.cursor.getMonth(), 1);
      const s = this.weekStart(first);
      return [s, addDays(s, 42)];
    }
    if (this.mode === 'week') { const s = this.weekStart(this.cursor); return [s, addDays(s, 7)]; }
    if (this.mode === 'day') { return [startOfDay(this.cursor), addDays(startOfDay(this.cursor), 1)]; }
    return [startOfDay(this.cursor), addDays(startOfDay(this.cursor), 45)];
  }

  async refresh(full) {
    this.plugin.smista();
    this.loading = true; this.error = null;
    this.render();
    try {
      if (full || !this.plugin.calendars.length) { this.plugin.clearCache(); await this.plugin.loadCalendars(); }
      else if (full === false && this.plugin.cache.size) { /* aggiornamento periodico */ this.plugin.clearCache(); }
      const [a, b] = this.range();
      await this.plugin.ensureRange(a, b);
    } catch (e) { this.error = e.message || String(e); }
    this.loading = false;
    this.render();
  }

  async go(delta) {
    const c = this.cursor;
    if (this.mode === 'month') this.cursor = new Date(c.getFullYear(), c.getMonth() + delta, 1);
    else if (this.mode === 'week') this.cursor = addDays(c, 7 * delta);
    else if (this.mode === 'day') this.cursor = addDays(c, delta);
    else this.cursor = addDays(c, 30 * delta);
    if (this.mode === 'month') this.selected = this.cursor;
    await this.reload();
  }

  async reload() {
    this.render();
    try { const [a, b] = this.range(); await this.plugin.ensureRange(a, b); this.error = null; }
    catch (e) { this.error = e.message || String(e); }
    this.render();
  }

  title() {
    const c = this.cursor;
    if (this.mode === 'month') return { big: MESI[c.getMonth()], small: String(c.getFullYear()) };
    if (this.mode === 'week') {
      const s = this.weekStart(c), e = addDays(s, 6);
      return { big: s.getMonth() === e.getMonth() ? `${s.getDate()}–${e.getDate()} ${MESI_BREVI[s.getMonth()]}` : `${s.getDate()} ${MESI_BREVI[s.getMonth()]} – ${e.getDate()} ${MESI_BREVI[e.getMonth()]}`, small: String(e.getFullYear()) };
    }
    if (this.mode === 'day') return { big: `${GIORNI[c.getDay()]} ${c.getDate()}`, small: `${MESI[c.getMonth()]} ${c.getFullYear()}` };
    return { big: 'Agenda', small: `dal ${c.getDate()} ${MESI_BREVI[c.getMonth()]}` };
  }

  render() {
    const root = this.contentEl;
    const keepScroll = root.querySelector('.igc-scroll');
    const scrollTop = keepScroll ? keepScroll.scrollTop : null;
    root.empty ? root.empty() : (root.innerHTML = '');
    root.addClass('igc-root');
    this.applySize();

    const shell = h('div', 'igc-shell', null, root);
    const side = h('aside', 'igc-side' + (this.sidebarOpen ? ' open' : '') + (this.plugin.settings.sidebarClosed ? ' closed' : ''), null, shell);
    this.renderSidebar(side);
    const main = h('div', 'igc-main', null, shell);
    this.renderHeader(main);
    if (this.error) h('div', 'igc-banner igc-error', this.error, main);
    const body = h('div', 'igc-body', null, main);
    if (this.loading) h('div', 'igc-loading', 'Carico…', body);
    if (this.mode === 'month') this.renderMonth(body);
    else if (this.mode === 'agenda') this.renderAgenda(body);
    else this.renderTimeGrid(body, this.mode === 'week' ? 7 : 1);

    const sc = root.querySelector('.igc-scroll');
    if (sc) {
      if (scrollTop !== null && this._keepScroll) sc.scrollTop = scrollTop;
      else if (this.mode !== 'month' && this.mode !== 'agenda') sc.scrollTop = Math.max(0, Math.min(new Date().getHours() - 2, 7) * HOUR_PX);
    }
    this._keepScroll = true;
  }

  renderSidebar(side) {
    const hd = h('div', 'igc-side-title', 'Calendari', side);
    const list = h('div', 'igc-cal-list', null, side);
    this.plugin.calendars.forEach((cal) => {
      const row = h('label', 'igc-cal-row', null, list);
      const cb = h('input', '', null, row); cb.type = 'checkbox'; cb.checked = !this.plugin.isHidden(cal.id);
      cb.style.accentColor = cal.color;
      const dot = h('span', 'igc-dot', null, row); dot.style.background = cal.color;
      h('span', 'igc-cal-name', cal.name, row);
      cb.addEventListener('change', async () => { await this.plugin.toggleCalendar(cal.id); this.render(); });
    });
    const btn = h('button', 'igc-btn igc-btn-wide', '↻ Aggiorna', side);
    btn.addEventListener('click', () => this.refresh(true));
  }

  renderHeader(main) {
    const t = this.title();
    const bar = h('div', 'igc-header', null, main);
    const left = h('div', 'igc-h-left', null, bar);
    const menu = h('button', 'igc-icon-btn igc-menu-btn', null, left);
    menu.setAttribute('aria-label', 'Calendari');
    setIcon(menu, 'calendar-days');
    menu.addEventListener('click', async () => {
      if (this.contentEl.classList.contains('igc-narrow')) this.sidebarOpen = !this.sidebarOpen;
      else { this.plugin.settings.sidebarClosed = !this.plugin.settings.sidebarClosed; await this.plugin.saveSettings(); }
      this.render();
    });
    const ttl = h('div', 'igc-title', null, left);
    h('span', 'igc-title-big', t.big, ttl);
    h('span', 'igc-title-small', t.small, ttl);

    const right = h('div', 'igc-h-right', null, bar);
    const seg = h('div', 'igc-seg', null, right);
    [['month', 'Mese'], ['week', 'Settimana'], ['day', 'Giorno'], ['agenda', 'Agenda']].forEach(([m, label]) => {
      const b = h('button', 'igc-seg-btn' + (this.mode === m ? ' active' : ''), label, seg);
      b.addEventListener('click', async () => { this.mode = m; this.plugin.settings.lastView = m; this._keepScroll = false; await this.plugin.saveSettings(); await this.reload(); });
    });
    const nav = h('div', 'igc-nav', null, right);
    const prev = h('button', 'igc-icon-btn', '‹', nav); prev.setAttribute('aria-label', 'Precedente');
    const today = h('button', 'igc-btn', 'Oggi', nav);
    const next = h('button', 'igc-icon-btn', '›', nav); next.setAttribute('aria-label', 'Successivo');
    prev.addEventListener('click', () => this.go(-1));
    next.addEventListener('click', () => this.go(1));
    today.addEventListener('click', async () => { this.cursor = startOfDay(new Date()); this.selected = this.cursor; this._keepScroll = false; await this.reload(); });
    const pc = this.plugin.pendingCount();
    const sy = h('button', 'igc-btn igc-sync' + (pc ? ' has' : ''), pc ? `↻ Sincronizza · ${pc}` : '↻ Sync', right);
    sy.setAttribute('aria-label', 'Sincronizza Calendar');
    sy.addEventListener('click', () => { window.open(SYNC_URI); new Notice('Sincronizzazione avviata: quando finisce premi Aggiorna.'); });
    const add = h('button', 'igc-icon-btn igc-add', '+', right);
    add.setAttribute('aria-label', 'Nuovo evento');
    add.addEventListener('click', () => this.openEditor(null, this.mode === 'month' ? this.selected : this.cursor));
  }

  /* rotella del mouse: nel mese cambia mese; in settimana/giorno scorre le ore, con Maiusc (o scorrimento laterale) cambia settimana/giorno */
  wheelNav(el, verticale) {
    el.addEventListener('wheel', (e) => {
      if (e.target.closest && e.target.closest('.igc-daylist')) return;
      const orizz = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
      if (!verticale && !orizz) return;
      const d = orizz && Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : (e.deltaY || e.deltaX);
      if (Math.abs(d) < 4) return;
      e.preventDefault();
      const now = Date.now();
      if (this._wheelAt && now - this._wheelAt < 380) return;
      this._wheelAt = now;
      this.go(d > 0 ? 1 : -1);
    }, { passive: false });
  }

  /* ----- mese ----- */
  renderMonth(body) {
    const [start] = this.range();
    const wrap = h('div', 'igc-month', null, body);
    this.wheelNav(wrap, true);
    const head = h('div', 'igc-dow', null, wrap);
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i);
      h('div', 'igc-dow-cell', GIORNI_BREVI[d.getDay()], head);
    }
    const grid = h('div', 'igc-grid', null, wrap);
    const today = startOfDay(new Date());
    const m = this.cursor.getMonth();
    // 5 o 6 righe
    const lastDayOfMonth = new Date(this.cursor.getFullYear(), m + 1, 0);
    const rows = Math.ceil((Math.round((lastDayOfMonth - start) / 86400000) + 1) / 7);
    grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    for (let i = 0; i < rows * 7; i++) {
      const day = addDays(start, i);
      const cell = h('div', 'igc-cell' + (day.getMonth() !== m ? ' other' : '') + (sameDay(day, today) ? ' today' : '') + (sameDay(day, this.selected) ? ' selected' : ''), null, grid);
      const num = h('div', 'igc-num', String(day.getDate()), cell);
      if (day.getDate() === 1) num.textContent = `${day.getDate()} ${MESI_BREVI[day.getMonth()]}`;
      const evs = this.plugin.eventsOnDay(day);
      const pills = h('div', 'igc-pills', null, cell);
      evs.slice(0, 3).forEach((ev) => {
        const cal = this.plugin.calendarById(ev.calId) || { color: '#007AFF' };
        const p = h('div', 'igc-pill' + (ev.allDay ? ' allday' : '') + (ev.pending ? ' pend' : ''), null, pills);
        if (ev.allDay) { p.style.background = cal.color; p.style.color = readableOn(cal.color); p.textContent = ev.title; }
        else { const dt = h('span', 'igc-pdot', null, p); dt.style.background = cal.color; h('span', 'igc-ptxt', ev.title, p); h('span', 'igc-ptime', hm(ev.start), p); }
        p.addEventListener('click', (e) => { e.stopPropagation(); this.openEditor(ev); });
      });
      if (evs.length > 3) {
        const more = h('div', 'igc-more', `+${evs.length - 3} altri`, pills);
        more.addEventListener('click', (e) => { e.stopPropagation(); this.selected = day; new DayModal(this.app, this, day).open(); });
      }
      const dots = h('div', 'igc-dots', null, cell);
      const seen = new Set();
      evs.forEach((ev) => { if (seen.size < 4 && !seen.has(ev.calId)) { seen.add(ev.calId); const dd = h('span', 'igc-dot', null, dots); dd.style.background = (this.plugin.calendarById(ev.calId) || { color: '#007AFF' }).color; } });
      cell.addEventListener('click', () => { this.selected = day; if (day.getMonth() !== m) { this.cursor = new Date(day.getFullYear(), day.getMonth(), 1); this.reload(); } else this.render(); });
      cell.addEventListener('dblclick', () => this.openEditor(null, day));
    }
    // elenco del giorno selezionato (visibile su schermi stretti)
    const dayList = h('div', 'igc-daylist', null, wrap);
    h('div', 'igc-daylist-title', `${GIORNI[this.selected.getDay()]} ${this.selected.getDate()} ${MESI[this.selected.getMonth()]}`, dayList);
    const evs = this.plugin.eventsOnDay(this.selected);
    if (!evs.length) h('div', 'igc-empty', 'Nessun evento', dayList);
    evs.forEach((ev) => this.eventRow(dayList, ev, false));
  }

  eventRow(parent, ev, showDay) {
    const cal = this.plugin.calendarById(ev.calId) || { color: '#007AFF', name: '' };
    const row = h('div', 'igc-row', null, parent);
    const time = h('div', 'igc-row-time', null, row);
    if (ev.allDay) h('span', '', 'Tutto il giorno', time);
    else { h('span', 'igc-t1', hm(ev.start), time); h('span', 'igc-t2', hm(ev.end), time); }
    const bar = h('div', 'igc-row-bar', null, row); bar.style.background = cal.color;
    const info = h('div', 'igc-row-info', null, row);
    h('div', 'igc-row-title', ev.title + (ev.pending ? '  ↻' : ''), info);
    if (ev.location) {
      const a = h('a', 'igc-row-loc', '📍 ' + ev.location, info);
      a.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(ev.location);
      a.addEventListener('click', (e) => e.stopPropagation());
    }
    h('div', 'igc-row-cal', cal.name, info);
    row.addEventListener('click', () => this.openEditor(ev));
    return row;
  }

  /* ----- agenda ----- */
  renderAgenda(body) {
    const [a, b] = this.range();
    const sc = h('div', 'igc-scroll igc-agenda', null, body);
    const evs = this.plugin.eventsBetween(a, b);
    if (!evs.length) h('div', 'igc-empty', 'Nessun evento nei prossimi 45 giorni', sc);
    let cur = null;
    for (let i = 0; i < 45; i++) {
      const day = addDays(a, i);
      const list = evs.filter((ev) => ev.start < addDays(day, 1) && ev.end > day);
      if (!list.length) continue;
      const sec = h('div', 'igc-agenda-day', null, sc);
      const hd = h('div', 'igc-agenda-head' + (sameDay(day, new Date()) ? ' today' : ''), `${GIORNI[day.getDay()]} ${day.getDate()} ${MESI[day.getMonth()]}`, sec);
      list.forEach((ev) => this.eventRow(sec, ev, true));
    }
  }

  /* ----- settimana / giorno ----- */
  renderTimeGrid(body, ndays) {
    const [start] = this.range();
    const days = []; for (let i = 0; i < ndays; i++) days.push(addDays(start, i));
    const wrap = h('div', 'igc-tg', null, body);
    this.wheelNav(wrap, false);
    const head = h('div', 'igc-tg-head', null, wrap);
    head.style.gridTemplateColumns = `48px repeat(${ndays}, 1fr)`;
    h('div', 'igc-tg-corner', null, head);
    const today = startOfDay(new Date());
    days.forEach((d) => {
      const c = h('div', 'igc-tg-dayhead' + (sameDay(d, today) ? ' today' : ''), null, head);
      h('span', 'igc-tg-dow', GIORNI_BREVI[d.getDay()], c);
      h('span', 'igc-tg-dnum', String(d.getDate()), c);
    });
    // riga "tutto il giorno"
    const ad = h('div', 'igc-tg-allday', null, wrap);
    ad.style.gridTemplateColumns = `48px repeat(${ndays}, 1fr)`;
    h('div', 'igc-tg-adlabel', 'giorno', ad);
    let anyAllDay = false;
    days.forEach((d) => {
      const col = h('div', 'igc-tg-adcol', null, ad);
      this.plugin.eventsOnDay(d).filter((e) => e.allDay).forEach((ev) => {
        anyAllDay = true;
        const cal = this.plugin.calendarById(ev.calId) || { color: '#007AFF' };
        const p = h('div', 'igc-pill allday', ev.title, col); p.style.background = cal.color; p.style.color = readableOn(cal.color);
        p.addEventListener('click', () => this.openEditor(ev));
      });
    });
    if (!anyAllDay) ad.addClass('empty');

    const sc = h('div', 'igc-scroll igc-tg-scroll', null, wrap);
    const grid = h('div', 'igc-tg-grid', null, sc);
    grid.style.gridTemplateColumns = `48px repeat(${ndays}, 1fr)`;
    grid.style.height = (24 * HOUR_PX) + 'px';
    const hours = h('div', 'igc-tg-hours', null, grid);
    for (let hh = 1; hh < 24; hh++) { const l = h('div', 'igc-tg-hour', `${pad(hh)}:00`, hours); l.style.top = (hh * HOUR_PX - 7) + 'px'; }
    days.forEach((d) => {
      const col = h('div', 'igc-tg-col' + (sameDay(d, today) ? ' today' : ''), null, grid);
      for (let hh = 1; hh < 24; hh++) { const ln = h('div', 'igc-tg-line', null, col); ln.style.top = (hh * HOUR_PX) + 'px'; }
      col.addEventListener('dblclick', (e) => {
        const r = col.getBoundingClientRect();
        const mins = Math.max(0, Math.min(23 * 60, Math.round((e.clientY - r.top) / HOUR_PX * 4) * 15));
        const base = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(mins / 60), mins % 60);
        this.openEditor(null, base, true);
      });
      const evs = this.plugin.eventsOnDay(d).filter((e) => !e.allDay);
      this.layoutColumn(evs, d).forEach(({ ev, top, height, lane, lanes }) => {
        const cal = this.plugin.calendarById(ev.calId) || { color: '#007AFF' };
        const b = h('div', 'igc-block' + (ev.pending ? ' pend' : ''), null, col);
        b.style.top = top + 'px'; b.style.height = Math.max(height, 20) + 'px';
        b.style.left = `calc(${(lane / lanes) * 100}% + 1px)`; b.style.width = `calc(${100 / lanes}% - 3px)`;
        b.style.setProperty('--c', cal.color);
        h('div', 'igc-block-title', ev.title + (ev.pending ? ' ↻' : ''), b);
        if (height > 34) h('div', 'igc-block-time', `${hm(ev.start)} – ${hm(ev.end)}`, b);
        if (height > 52 && ev.location) h('div', 'igc-block-time', ev.location, b);
        b.addEventListener('click', (e) => { e.stopPropagation(); this.openEditor(ev); });
      });
      if (sameDay(d, today)) {
        const now = new Date();
        const nl = h('div', 'igc-now', null, col);
        nl.style.top = ((now.getHours() * 60 + now.getMinutes()) / 60 * HOUR_PX) + 'px';
      }
    });
  }

  layoutColumn(evs, day) {
    const ds = startOfDay(day), de = addDays(ds, 1);
    const items = evs.map((ev) => {
      const s = ev.start < ds ? ds : ev.start, e = ev.end > de ? de : ev.end;
      const smin = (s - ds) / 60000, emin = Math.max((e - ds) / 60000, smin + 20);
      return { ev, smin, emin, lane: 0, lanes: 1 };
    }).sort((a, b) => a.smin - b.smin || b.emin - a.emin);
    let group = [], groupEnd = -1;
    const flush = () => { const n = group.reduce((m, it) => Math.max(m, it.lane + 1), 1); group.forEach((it) => { it.lanes = n; }); group = []; };
    items.forEach((it) => {
      if (group.length && it.smin >= groupEnd) { flush(); groupEnd = -1; }
      const used = new Set(group.filter((g) => g.emin > it.smin).map((g) => g.lane));
      let lane = 0; while (used.has(lane)) lane++;
      it.lane = lane; group.push(it); groupEnd = Math.max(groupEnd, it.emin);
    });
    flush();
    return items.map((it) => ({ ev: it.ev, top: it.smin / 60 * HOUR_PX, height: (it.emin - it.smin) / 60 * HOUR_PX - 1, lane: it.lane, lanes: it.lanes }));
  }

  openEditor(ev, day, withTime) {
    new EventModal(this.app, this.plugin, ev, day, withTime, async () => { this._keepScroll = true; await this.reload(); }).open();
  }
}

/* ---------- anteprima del giorno ---------- */
class DayModal extends Modal {
  constructor(app, view, day) { super(app); this.view = view; this.day = day; }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('igc-modal'); contentEl.addClass('igc-daymodal');
    h('h3', 'igc-m-title', `${GIORNI[this.day.getDay()]} ${this.day.getDate()} ${MESI[this.day.getMonth()]}`, contentEl);
    const list = h('div', 'igc-daymodal-list', null, contentEl);
    const evs = this.view.plugin.eventsOnDay(this.day);
    if (!evs.length) h('div', 'igc-empty', 'Nessun evento', list);
    evs.forEach((ev) => {
      const row = this.view.eventRow(list, ev, false);
      row.addEventListener('click', () => { this.close(); });
    });
    const btns = h('div', 'igc-m-btns', null, contentEl);
    h('span', 'igc-spacer', null, btns);
    const nuovo = h('button', 'igc-btn igc-primary', 'Nuovo evento', btns);
    nuovo.addEventListener('click', () => { this.close(); this.view.openEditor(null, this.day); });
  }
  onClose() { this.contentEl.empty ? this.contentEl.empty() : (this.contentEl.innerHTML = ''); }
}

/* ---------- finestra evento ---------- */
const CATEGORIE_NUOVE = [['Personale', 'Personale', '#007AFF'], [CAT_GARA, 'Gara', '#FF9500'], ['Università (appello)', 'Appello', '#34C759'], ['Solo calendario', 'Solo calendario', '#8E8E93']];

class EventModal extends Modal {
  constructor(app, plugin, ev, day, withTime, onDone) {
    super(app);
    this.plugin = plugin; this.ev = ev; this.onDone = onDone;
    const now = new Date();
    const base = day || startOfDay(now);
    let s, e;
    if (ev) { s = ev.start; e = ev.allDay ? addDays(ev.end, -1) : ev.end; }
    else if (withTime) { s = base; e = new Date(base.getTime() + 3600000); }
    else { s = new Date(base.getFullYear(), base.getMonth(), base.getDate(), Math.max(now.getHours() + 1, 8) % 24, 0); e = new Date(s.getTime() + 3600000); }
    this.kind = ev ? (ev.note ? 'note' : ev.vaultTipo === 'appello' ? 'appello' : 'google') : 'new';
    this.corsi = this.listCorsi();
    this.f = {
      title: ev ? ev.title : '',
      cat: ev ? (ev.note ? ev.note.cat || 'Personale' : '') : 'Personale',
      allDay: ev ? ev.allDay : false,
      startDate: ymd(s), startTime: hm(s), endDate: ymd(e), endTime: hm(e),
      location: ev ? (ev.note ? ev.note.luogo : ev.location) : '',
      description: ev ? ev.description : '',
      calId: ev ? ev.calId : ((plugin.calendars.find((c) => c.primary && c.writable) || plugin.calendars.find((c) => c.writable) || plugin.calendars[0] || {}).id),
      corso: ev && ev.vaultCorso ? ev.vaultCorso : (this.corsi[0] ? this.corsi[0].basename : ''),
    };
    if (this.kind === 'appello') { // il titolo è "Corso - Dettagli": si modifica il dettaglio
      const t = ev.title; const i = t.indexOf(' - ');
      this.f.description = i >= 0 ? t.slice(i + 3) : '';
      this.f.location = ev.location === LUOGO_UNIVERSITA ? '' : ev.location;
    }
  }

  listCorsi() {
    return this.app.vault.getMarkdownFiles().filter((f) => {
      if (!f.path.startsWith(UNIV + '/')) return false;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      return fm && 'appelli' in fm;
    }).sort((a, b) => a.basename.localeCompare(b.basename));
  }

  get mode() { // cosa si sta compilando
    if (this.kind === 'new') return { 'Personale': 'note', [CAT_GARA]: 'note', 'Università (appello)': 'appello', 'Solo calendario': 'google' }[this.f.cat];
    return this.kind;
  }

  onOpen() { this.contentEl.addClass('igc-modal'); this.draw(); }

  draw() {
    const { contentEl } = this;
    contentEl.empty ? contentEl.empty() : (contentEl.innerHTML = '');
    const f = this.f, mode = this.mode;
    h('h3', 'igc-m-title', this.ev ? 'Modifica evento' : 'Nuovo evento', contentEl);


    if (this.kind === 'new') {
      const chips = h('div', 'igc-chips', null, contentEl);
      CATEGORIE_NUOVE.forEach(([c, label, color]) => {
        const b = h('button', 'igc-chip' + (c === f.cat ? ' on' : ''), null, chips);
        b.style.setProperty('--c', color);
        h('span', 'igc-chip-dot', null, b);
        h('span', '', label, b);
        b.addEventListener('click', () => { f.cat = c; this.draw(); });
      });
    } else if (mode === 'note' || mode === 'appello') {
      const chips = h('div', 'igc-chips fixed', null, contentEl);
      const info = mode === 'appello' ? CATEGORIE_NUOVE[2] : (CATEGORIE_NUOVE.find((x) => x[0] === f.cat) || CATEGORIE_NUOVE[0]);
      const b = h('span', 'igc-chip on', null, chips); b.style.setProperty('--c', info[2]);
      h('span', 'igc-chip-dot', null, b); h('span', '', info[1], b);
    }

    if (mode !== 'appello') {
      const title = h('input', 'igc-input igc-input-title', null, contentEl); title.type = 'text'; title.placeholder = 'Titolo'; title.value = f.title;
      title.addEventListener('input', () => { f.title = title.value; });
      if (!this.ev) setTimeout(() => title.focus(), 50);
    } else {
      const card1 = h('div', 'igc-card', null, contentEl);
      const r1 = h('div', 'igc-field', null, card1); h('label', '', 'Corso', r1);
      if (this.kind === 'new') {
        const selC = h('select', 'igc-input', null, r1);
        this.corsi.forEach((c) => { const o = h('option', '', c.basename, selC); o.value = c.basename; if (c.basename === f.corso) o.selected = true; });
        selC.addEventListener('change', () => { f.corso = selC.value; });
        if (!this.corsi.length) h('span', 'igc-hint', 'Nessun corso con la proprietà "appelli"', r1);
      } else h('span', 'igc-static', f.corso, r1);
    }

    const card = h('div', 'igc-card', null, contentEl);
    if (mode === 'google') {
      const rowCal = h('div', 'igc-field', null, card); h('label', '', 'Calendario', rowCal);
      const sel = h('select', 'igc-input', null, rowCal);
      this.plugin.calendars.filter((c) => c.writable || (this.ev && c.id === this.ev.calId)).forEach((c) => { const o = h('option', '', c.name, sel); o.value = c.id; if (c.id === f.calId) o.selected = true; });
      sel.addEventListener('change', () => { f.calId = sel.value; });
      const rowAll = h('div', 'igc-field', null, card); h('label', '', 'Tutto il giorno', rowAll);
      const all = h('input', '', null, rowAll); all.type = 'checkbox'; all.checked = f.allDay;
      const mk = (label, dKey, tKey) => {
        const r = h('div', 'igc-field', null, card); h('label', '', label, r);
        const wrap = h('div', 'igc-dt', null, r);
        const d = h('input', 'igc-input', null, wrap); d.type = 'date'; d.value = f[dKey]; d.addEventListener('change', () => { f[dKey] = d.value; });
        const t = h('input', 'igc-input igc-time', null, wrap); t.type = 'time'; t.value = f[tKey]; t.addEventListener('change', () => { f[tKey] = t.value; });
        return t;
      };
      const t1 = mk('Inizio', 'startDate', 'startTime'), t2 = mk('Fine', 'endDate', 'endTime');
      const syncAll = () => { t1.style.display = t2.style.display = f.allDay ? 'none' : ''; };
      all.addEventListener('change', () => { f.allDay = all.checked; syncAll(); });
      syncAll();
    } else {
      const rd = h('div', 'igc-field', null, card); h('label', '', 'Data', rd);
      const d = h('input', 'igc-input', null, rd); d.type = 'date'; d.value = f.startDate; d.addEventListener('change', () => { f.startDate = d.value; });
      const rowAll = h('div', 'igc-field', null, card); h('label', '', 'Tutto il giorno', rowAll);
      const all = h('input', '', null, rowAll); all.type = 'checkbox'; all.checked = f.allDay;
      const rt = h('div', 'igc-field', null, card); h('label', '', 'Ora', rt);
      const t = h('input', 'igc-input igc-time', null, rt); t.type = 'time'; t.value = f.startTime; t.addEventListener('change', () => { f.startTime = t.value; });
      const syncAll = () => { rt.style.display = f.allDay ? 'none' : ''; };
      all.addEventListener('change', () => { f.allDay = all.checked; syncAll(); });
      syncAll();
    }

    const card2 = h('div', 'igc-card', null, contentEl);
    const rl = h('div', 'igc-field', null, card2); h('label', '', 'Luogo', rl);
    const loc = h('input', 'igc-input', null, rl); loc.type = 'text'; loc.placeholder = mode === 'appello' ? 'Vuoto = Università di Udine' : 'Indirizzo'; loc.value = f.location; loc.addEventListener('input', () => { f.location = loc.value; });
    if (f.location) {
      const a = h('a', 'igc-maps', 'Apri in Maps ↗', card2);
      a.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(f.location);
    }
    const rd2 = h('div', 'igc-field igc-field-col', null, card2); h('label', '', mode === 'appello' ? 'Dettagli (es. Primo parziale)' : 'Dettagli', rd2);
    const desc = h('textarea', 'igc-input', null, rd2); desc.rows = mode === 'appello' ? 2 : 4; desc.value = f.description; desc.addEventListener('input', () => { f.description = desc.value; });

    const btns = h('div', 'igc-m-btns', null, contentEl);
    if (this.ev) {
      const del = h('button', 'igc-btn igc-danger', 'Elimina', btns);
      del.addEventListener('click', () => this.doDelete(del));
    }
    h('span', 'igc-spacer', null, btns);
    const cancel = h('button', 'igc-btn', 'Annulla', btns); cancel.addEventListener('click', () => this.close());
    const save = h('button', 'igc-btn igc-primary', 'Salva', btns);
    save.addEventListener('click', () => this.doSave(save));
  }

  /* ----- salvataggio ----- */
  async doSave(btn) {
    const f = this.f, mode = this.mode, p = this.plugin;
    if (mode !== 'appello' && !f.title.trim()) { new Notice('Metti un titolo'); return; }
    if (!f.startDate) { new Notice('Data non valida'); return; }
    if (mode === 'google') {
      const sD = f.allDay ? parseYmd(f.startDate) : parseLocal(f.startDate, f.startTime);
      const eD = f.allDay ? parseYmd(f.endDate) : parseLocal(f.endDate, f.endTime);
      if (eD < sD) { new Notice('La fine è prima dell\'inizio'); return; }
    }
    btn.disabled = true;
    try {
      let msg;
      if (mode === 'google') {
        if (this.ev) await p.updateEvent(this.ev, f.calId, f); else await p.createEvent(f.calId, f);
        msg = this.ev ? 'Evento aggiornato' : 'Evento creato';
      } else if (mode === 'note') {
        if (this.ev) await this.editNote(); else await this.createNote();
        msg = 'Nota salvata. Premi Sincronizza per portarla su Google Calendar.';
      } else {
        await this.saveAppello();
        msg = 'Appello salvato nella nota del corso. Dopo la sincronizzazione lo vedrai in calendario.';
      }
      this.close(); this.onDone(); new Notice(msg);
    } catch (err) { btn.disabled = false; new Notice('Errore: ' + (err.message || err)); }
  }

  async ensureFolder(path) {
    const parts = path.split('/'); let cur = '';
    for (const part of parts) {
      cur = cur ? cur + '/' + part : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) await this.app.vault.createFolder(cur);
    }
  }

  noteText(nome, data, orario, luogo, cat, dettagli, gara) {
    const q = (v) => '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    const r = ['---', `Nome: ${nome}`, `Data: ${data}`, `Orario: ${orario}`, `Luogo: ${q(mapsLink(luogo))}`, `Categoria: ${cat}`];
    if (dettagli || !gara) r.push(`Dettagli: ${dettagli}`);
    if (gara) r.push('Risultati:');
    r.push('---', '');
    return r.join('\n');
  }

  async createNote() {
    const f = this.f, app = this.app;
    const nome = f.title.trim(), safe = safeName(nome) || 'Evento';
    const orario = f.allDay ? '' : f.startTime;
    const gara = f.cat === CAT_GARA;
    const stamp = window.moment ? window.moment().format('HHmmss') : String(Date.now());
    let folder, base;
    if (gara) { base = `${f.startDate} ${safe}`; folder = `${FENCING}/${stagione(f.startDate)}/${base}`; }
    else { base = `${f.startDate} - ${safe}`; folder = cartellaPerData(f.startDate); }
    await this.ensureFolder(folder);
    let path = `${folder}/${base}.md`;
    if (app.vault.getAbstractFileByPath(path)) path = `${folder}/${base} - ${stamp}.md`;
    await app.vault.create(path, this.noteText(nome, f.startDate, orario, f.location.trim(), f.cat, f.description.trim(), gara));
  }

  async editNote() {
    const f = this.f, app = this.app, n = this.ev.note, file = n.file;
    const nome = f.title.trim();
    const orario = f.allDay ? '' : f.startTime;
    await app.fileManager.processFrontMatter(file, (fm) => {
      fm.Nome = nome; fm.Data = f.startDate; fm.Orario = orario;
      fm.Luogo = mapsLink(f.location.trim());
      if (f.description.trim() || 'Dettagli' in fm) fm.Dettagli = f.description.trim();
    });
    if (nome === n.nome && f.startDate === n.giorno) return;
    const safe = safeName(nome) || 'Evento';
    if (file.path.startsWith(FUTURI + '/') || file.path.startsWith(PASSATI + '/')) {
      const dest = cartellaPerData(f.startDate);
      await this.ensureFolder(dest);
      await app.fileManager.renameFile(file, `${dest}/${f.startDate} - ${safe}.md`);
    } else if (file.path.startsWith(FENCING + '/')) {
      const folder = file.parent, oldBase = file.basename, base = `${f.startDate} ${safe}`;
      await app.fileManager.renameFile(file, `${folder.path}/${base}.md`);
      if (folder.name === oldBase) { // cartella dedicata alla gara: la rinomino e la sposto nella stagione giusta
        const dest = `${FENCING}/${stagione(f.startDate)}`;
        await this.ensureFolder(dest);
        await app.fileManager.renameFile(folder, `${dest}/${base}`);
      }
    }
  }

  courseFile() { return this.app.vault.getMarkdownFiles().find((x) => x.path.startsWith(UNIV + '/') && x.basename === this.f.corso); }

  async saveAppello() {
    const f = this.f, file = this.courseFile();
    if (!file) throw new Error('Nota del corso non trovata');
    const orario = f.allDay ? '' : f.startTime;
    const voce = `${f.startDate} | ${orario} | ${mapsLink(f.location.trim())} | ${f.description.trim()}`;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (!Array.isArray(fm.appelli)) fm.appelli = fm.appelli ? [fm.appelli] : [];
      if (this.ev) {
        const i = this.trovaVoce(fm.appelli);
        if (i >= 0) fm.appelli[i] = voce; else fm.appelli.push(voce);
      } else fm.appelli.push(voce);
    });
  }

  trovaVoce(lista) {
    const g = ymd(this.ev.start), o = this.ev.allDay ? '' : hm(this.ev.start);
    const parti = (v) => String(v).split('|').map((x) => x.trim());
    let i = lista.findIndex((v) => { const [d, ora] = parti(v); return d === g && orarioNorm(ora) === o; });
    if (i < 0) i = lista.findIndex((v) => parti(v)[0] === g);
    return i;
  }

  /* ----- eliminazione ----- */
  async doDelete(btn) {
    const p = this.plugin, app = this.app, mode = this.mode;
    try {
      if (mode === 'google') {
        if (!confirm('Eliminare questo evento da Google Calendar?')) return;
        btn.disabled = true; await p.deleteEvent(this.ev);
        this.close(); this.onDone(); new Notice('Evento eliminato'); return;
      }
      if (mode === 'appello') {
        if (!confirm('Togliere questo appello dalla nota del corso? Sparirà da Google Calendar alla prossima sincronizzazione.')) return;
        const file = this.courseFile(); if (!file) throw new Error('Nota del corso non trovata');
        btn.disabled = true;
        await app.fileManager.processFrontMatter(file, (fm) => { const l = Array.isArray(fm.appelli) ? fm.appelli : []; const i = this.trovaVoce(l); if (i >= 0) l.splice(i, 1); fm.appelli = l; });
        this.close(); this.onDone(); new Notice('Appello tolto dalla nota. Sincronizza per eliminarlo da Google Calendar.'); return;
      }
      // evento con nota: la nota va in _da eliminare, l'evento sparisce dal calendario alla sincronizzazione
      const n = this.ev.note;
      const gara = n.file.path.startsWith(FENCING + '/');
      if (!confirm(gara ? `Eliminare la gara "${n.nome}"? La nota andrà in "${CESTINO}" e l'evento sparirà da Google Calendar alla prossima sincronizzazione.` : `Eliminare "${n.nome}"? La nota andrà in "${CESTINO}" e l'evento sparirà da Google Calendar alla prossima sincronizzazione.`)) return;
      btn.disabled = true;
      await this.ensureFolder(CESTINO);
      let dest = `${CESTINO}/${n.file.name}`;
      if (app.vault.getAbstractFileByPath(dest)) dest = `${CESTINO}/${n.file.basename} - ${Date.now()}.md`;
      const folder = n.file.parent;
      await app.fileManager.renameFile(n.file, dest);
      if (gara && folder && folder.path !== FENCING && folder.children && folder.children.length === 0) { try { await app.vault.delete(folder); } catch (e) { /* cartella non vuota o già tolta */ } }
      this.close(); this.onDone(); new Notice('Nota spostata in "' + CESTINO + '". Sincronizza per toglierlo da Google Calendar.');
    } catch (err) { btn.disabled = false; new Notice('Errore: ' + (err.message || err)); }
  }

  onClose() { this.contentEl.empty ? this.contentEl.empty() : (this.contentEl.innerHTML = ''); }
}

/* ---------- impostazioni ---------- */
class IosGcalSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty ? containerEl.empty() : (containerEl.innerHTML = '');
    new Setting(containerEl).setName('File con le chiavi').setDesc('Percorso della nota con CLIENT_ID, CLIENT_SECRET e REFRESH_TOKEN.')
      .addText((t) => t.setValue(this.plugin.settings.configPath).onChange(async (v) => { this.plugin.settings.configPath = v.trim(); await this.plugin.saveSettings(); this.plugin.token = null; }));
    new Setting(containerEl).setName('La settimana inizia di lunedì')
      .addToggle((t) => t.setValue(this.plugin.settings.weekStartsMonday).onChange(async (v) => { this.plugin.settings.weekStartsMonday = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Vista iniziale')
      .addDropdown((d) => d.addOption('month', 'Mese').addOption('week', 'Settimana').addOption('day', 'Giorno').addOption('agenda', 'Agenda').setValue(this.plugin.settings.defaultView)
        .onChange(async (v) => { this.plugin.settings.defaultView = v; this.plugin.settings.lastView = v; await this.plugin.saveSettings(); }));
  }
}
