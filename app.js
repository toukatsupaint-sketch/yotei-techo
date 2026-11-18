(() => {
  'use strict';

  // ===== Googleカレンダーの予定の色（色ID → 色） =====
  const PALETTE = {
    '1':  { name: 'ラベンダー',   hex: '#7986CB' },
    '2':  { name: 'セージ',       hex: '#33B679' },
    '3':  { name: 'ブドウ',       hex: '#8E24AA' },
    '4':  { name: 'フラミンゴ',   hex: '#E67C73' },
    '5':  { name: 'バナナ',       hex: '#F6BF26' },
    '6':  { name: 'ミカン',       hex: '#F4511E' },
    '7':  { name: 'ピーコック',   hex: '#039BE5' },
    '8':  { name: 'グラファイト', hex: '#616161' },
    '9':  { name: 'ブルーベリー', hex: '#3F51B5' },
    '10': { name: 'バジル',       hex: '#0B8043' },
    '11': { name: 'トマト',       hex: '#D50000' },
  };
  // 凡例の並び：協力会社（トマト・フラミンゴ・バナナ・バジル）→ 自社（既定色）→ その他の色
  const COLOR_ORDER = ['11', '4', '5', '10', '', '6', '2', '7', '9', '1', '3', '8'];
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const CONFIG = window.YOTEI_CONFIG || { companies: {} };
  const companies = CONFIG.companies || {};

  // ===== 保存（端末内） =====
  const store = {
    get(k, def) { try { const v = localStorage.getItem('yotei:' + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
    set(k, v) { try { localStorage.setItem('yotei:' + k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動作は続ける */ } },
  };
  let settings = Object.assign({ apiUrl: '', apiKey: '', fontScale: 1.15, demo: false }, store.get('settings', {}));

  // ===== 日付ユーティリティ（日付は「通し日数」で扱う） =====
  const DAY = 86400000;
  const dn = (y, m, d) => Math.round(Date.UTC(y, m, d) / DAY);
  const fromDn = (n) => { const d = new Date(n * DAY); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), w: d.getUTCDay() }; };
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (n) => { const o = fromDn(n); return `${o.y}-${pad(o.m + 1)}-${pad(o.d)}`; };
  const dnOfStr = (s) => dn(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const minutesOfStr = (s) => s.length > 10 ? (+s.slice(11, 13)) * 60 + (+s.slice(14, 16)) : 0;
  const hm = (min) => `${Math.floor(min / 60)}:${pad(min % 60)}`;
  const todayDn = () => { const t = new Date(); return dn(t.getFullYear(), t.getMonth(), t.getDate()); };
  const jpDate = (n) => { const o = fromDn(n); return `${o.m + 1}月${o.d}日(${WD[o.w]})`; };

  // ===== 状態 =====
  const now = new Date();
  let view = { y: now.getFullYear(), m: now.getMonth() };
  let data = null;          // 表示中の月のデータ
  let lastFetch = 0;
  let fetchSeq = 0;

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  function gridRange(y, m) {
    const first = dn(y, m, 1);
    const start = first - fromDn(first).w;
    const last = dn(y, m + 1, 0);
    const end = last + (6 - fromDn(last).w);
    return { start, end, first, last };
  }

  // ===== 色 =====
  function colorOf(colorId) {
    if (colorId && PALETTE[colorId]) return PALETTE[colorId].hex;
    return (data && data.calendarColor) || '#039BE5';
  }
  function textOn(hex) {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return L > 0.45 ? '#202124' : '#ffffff';
  }
  function colorLabel(colorId) {
    const company = (companies[colorId] || '').trim();
    const cname = PALETTE[colorId] ? PALETTE[colorId].name : 'カレンダーの既定色';
    return { company, cname };
  }

  // ===== 予定の整理 =====
  function normalize(raw) {
    const out = { bars: [], timed: [] };
    for (const e of raw.events || []) {
      const s = dnOfStr(e.start);
      const ev = Object.assign({}, e, { s });
      if (e.allDay) {
        ev.e = Math.max(s, dnOfStr(e.end) - 1); // 終了日は翌日表記なので1日戻す
        out.bars.push(ev);
      } else {
        ev.sMin = minutesOfStr(e.start);
        ev.eMin = minutesOfStr(e.end);
        let endDay = dnOfStr(e.end);
        if (ev.eMin === 0 && endDay > s) endDay -= 1;
        ev.e = endDay;
        if (endDay > s) out.bars.push(ev); else out.timed.push(ev);
      }
    }
    out.bars.sort((a, b) => a.s - b.s || (b.e - b.s) - (a.e - a.s) || (a.sMin || 0) - (b.sMin || 0) || a.title.localeCompare(b.title, 'ja'));
    out.timed.sort((a, b) => a.s - b.s || a.sMin - b.sMin || a.eMin - b.eMin || a.title.localeCompare(b.title, 'ja'));
    out.holidays = {};
    for (const h of raw.holidays || []) out.holidays[dnOfStr(h.date)] = h.name;
    return out;
  }

  // ===== 描画 =====
  function render() {
    const { y, m } = view;
    $('monthTitle').textContent = `${y}年${m + 1}月`;
    const cal = $('calendar');
    cal.textContent = '';
    const r = gridRange(y, m);
    const today = todayDn();
    const nd = data ? normalize(data) : { bars: [], timed: [], holidays: {} };

    const timedByDay = {};
    for (const ev of nd.timed) (timedByDay[ev.s] = timedByDay[ev.s] || []).push(ev);

    for (let ws = r.start; ws <= r.end; ws += 7) {
      const we = ws + 6;
      const week = el('div', 'week');

      // 帯の段（レーン）割り当て
      const segs = [];
      const laneEnds = [];
      for (const b of nd.bars) {
        if (b.e < ws || b.s > we) continue;
        const s = Math.max(b.s, ws), e = Math.min(b.e, we);
        let lane = laneEnds.findIndex((end) => end < s);
        if (lane === -1) { lane = laneEnds.length; laneEnds.push(e); } else laneEnds[lane] = e;
        segs.push({ b, s, e, lane });
      }
      const L = laneEnds.length;
      const timedRow = L + 2;
      week.style.gridTemplateRows = `auto ${'auto '.repeat(L)}1fr`;

      // 背景のマス
      for (let i = 0; i < 7; i++) {
        const d = ws + i;
        const o = fromDn(d);
        const c = el('div', 'cell');
        c.style.gridColumn = i + 1;
        if (o.m !== m) c.classList.add('other');
        if (d === today) c.classList.add('today');
        week.appendChild(c);
      }
      // 日付
      for (let i = 0; i < 7; i++) {
        const d = ws + i;
        const o = fromDn(d);
        const h = el('div', 'daynum');
        h.style.gridColumn = i + 1;
        if (o.w === 0) h.classList.add('sun');
        if (o.w === 6) h.classList.add('sat');
        if (nd.holidays[d]) h.classList.add('hol');
        if (o.m !== m) h.classList.add('other');
        if (d === today) h.classList.add('today');
        h.appendChild(el('span', 'n', o.d === 1 && o.m !== m ? `${o.m + 1}/${o.d}` : String(o.d)));
        if (nd.holidays[d]) h.appendChild(el('span', 'hname', nd.holidays[d]));
        week.appendChild(h);
      }
      // 期間予定の帯
      for (const g of segs) {
        const color = colorOf(g.b.colorId);
        const bar = el('button', 'bar');
        bar.type = 'button';
        bar.style.gridRow = g.lane + 2;
        bar.style.gridColumn = `${g.s - ws + 1} / span ${g.e - g.s + 1}`;
        bar.style.background = color;
        bar.style.color = textOn(color);
        if (g.b.s < g.s) { bar.classList.add('cont-l'); bar.appendChild(el('span', 'arrow', '◀')); }
        const txt = el('span', 'btxt');
        if (!g.b.allDay && g.b.s === g.s) txt.appendChild(el('span', 'btime', hm(g.b.sMin) + ' '));
        txt.appendChild(document.createTextNode(g.b.title || '（タイトルなし）'));
        bar.appendChild(txt);
        if (g.b.e > g.e) { bar.classList.add('cont-r'); bar.appendChild(el('span', 'arrow', '▶')); }
        bar.addEventListener('click', () => showDetail(g.b));
        week.appendChild(bar);
      }
      // 時間のある予定（時刻順）
      for (let i = 0; i < 7; i++) {
        const d = ws + i;
        const list = timedByDay[d];
        if (!list) continue;
        const box = el('div', 'timed');
        box.style.gridColumn = i + 1;
        box.style.gridRow = timedRow;
        for (const ev of list) {
          const b = el('button', 'ev');
          b.type = 'button';
          b.style.setProperty('--c', colorOf(ev.colorId));
          b.appendChild(el('span', 't', hm(ev.sMin)));
          b.appendChild(el('span', 's', ev.title || '（タイトルなし）'));
          b.addEventListener('click', () => showDetail(ev));
          box.appendChild(b);
        }
        week.appendChild(box);
      }
      cal.appendChild(week);
    }
    renderLegend(nd, r);
  }

  function renderLegend(nd, r) {
    const counts = {};
    for (const ev of [...nd.bars, ...nd.timed]) {
      if (ev.e < r.first || ev.s > r.last) continue;
      const k = ev.colorId && PALETTE[ev.colorId] ? ev.colorId : '';
      counts[k] = (counts[k] || 0) + 1;
    }
    const ul = $('legend');
    ul.textContent = '';
    for (const id of COLOR_ORDER) {
      const { company, cname } = colorLabel(id);
      const used = counts[id] > 0;
      if (!used && !company) continue; // 未使用かつ会社名なしの色は省略
      const li = el('li', used ? '' : 'unused');
      const sw = el('span', 'sw');
      sw.style.background = colorOf(id);
      li.appendChild(sw);
      const name = el('span', '', company || cname);
      li.appendChild(name);
      if (company) li.appendChild(el('span', 'cname', cname));
      if (used) li.appendChild(el('span', 'count', `${counts[id]}件`));
      ul.appendChild(li);
    }
    if (!ul.children.length) ul.appendChild(el('li', 'empty-msg', 'この月の予定はありません'));
  }

  // ===== 予定の詳細 =====
  function plainText(s) {
    if (!s) return '';
    const withBreaks = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n');
    const doc = new DOMParser().parseFromString(withBreaks, 'text/html');
    return (doc.body.textContent || '').trim();
  }
  function showDetail(ev) {
    const color = colorOf(ev.colorId);
    $('detailColor').style.background = color;
    $('detailTitle').textContent = ev.title || '（タイトルなし）';
    const dl = $('detailList');
    dl.textContent = '';
    const add = (label, value) => { if (!value) return null; dl.appendChild(el('dt', '', label)); const dd = el('dd'); if (typeof value === 'string') dd.textContent = value; else dd.appendChild(value); dl.appendChild(dd); return dd; };

    let when;
    if (ev.allDay) {
      when = ev.e > ev.s ? `${jpDate(ev.s)} 〜 ${jpDate(ev.e)}（${ev.e - ev.s + 1}日間）` : `${jpDate(ev.s)}（終日）`;
    } else if (ev.e > ev.s) {
      when = `${jpDate(ev.s)} ${hm(ev.sMin)} 〜 ${jpDate(ev.e)} ${hm(ev.eMin)}`;
    } else {
      when = `${jpDate(ev.s)} ${hm(ev.sMin)} 〜 ${hm(ev.eMin)}`;
    }
    add('日時', when);
    const { company, cname } = colorLabel(ev.colorId && PALETTE[ev.colorId] ? ev.colorId : '');
    add('協力会社', company ? `${company}（${cname}）` : `${cname}（会社名未設定）`);
    if (ev.location) {
      const a = el('a', '', ev.location);
      a.href = 'https://maps.apple.com/?q=' + encodeURIComponent(ev.location);
      a.target = '_blank'; a.rel = 'noopener';
      add('場所', a);
    }
    add('メモ', plainText(ev.description));
    $('detailBackdrop').hidden = false;
  }

  // ===== データ読み込み =====
  function setStatus(text, cls) {
    const s = $('status');
    s.textContent = text;
    s.className = 'status' + (cls ? ' ' + cls : '');
  }
  const cacheKey = (y, m) => `cache:${y}-${pad(m + 1)}`;
  const timeLabel = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${pad(d.getMinutes())}`; };

  async function load() {
    const { y, m } = view;
    const seq = ++fetchSeq;
    const cached = store.get(cacheKey(y, m), null);
    data = cached;
    render();

    if (settings.demo) {
      data = demoData(y, m);
      lastFetch = Date.now();
      render();
      setStatus('デモ表示中（設定から接続できます）');
      return;
    }
    if (!settings.apiUrl || !settings.apiKey) {
      setStatus('未接続：⚙ から設定してください', 'err');
      openSettings();
      return;
    }

    setStatus('読み込み中…', 'loading');
    const r = gridRange(y, m);
    const url = settings.apiUrl + (settings.apiUrl.includes('?') ? '&' : '?') +
      new URLSearchParams({ key: settings.apiKey, from: ymd(r.start), to: ymd(r.end), _: Date.now() }).toString();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      const json = await res.json();
      if (seq !== fetchSeq) return; // 月を切り替えた後の古い応答は捨てる
      if (json.error) throw new Error(json.error);
      data = json;
      lastFetch = Date.now();
      store.set(cacheKey(y, m), json);
      render();
      setStatus(`更新 ${timeLabel(json.fetchedAt || new Date().toISOString())}`);
    } catch (err) {
      if (seq !== fetchSeq) return;
      const msg = err.name === 'AbortError' ? '時間切れ' : (err.message || '通信エラー');
      setStatus(cached ? `読み込み失敗（${timeLabel(cached.fetchedAt)}時点を表示）` : `読み込み失敗：${msg}`, 'err');
      console.error(err);
    } finally {
      clearTimeout(timer);
    }
  }

  function moveMonth(delta) {
    const d = new Date(view.y, view.m + delta, 1);
    view = { y: d.getFullYear(), m: d.getMonth() };
    window.scrollTo(0, 0);
    load();
  }
  function goToday() {
    const t = new Date();
    const same = view.y === t.getFullYear() && view.m === t.getMonth();
    view = { y: t.getFullYear(), m: t.getMonth() };
    if (same) render(); else load();
    requestAnimationFrame(() => {
      const c = document.querySelector('.cell.today');
      if (c) {
        const top = c.parentElement.getBoundingClientRect().top + window.scrollY - document.querySelector('.topbar').offsetHeight - 6;
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
    });
  }

  // ===== 設定 =====
  function applyFont() {
    document.documentElement.style.setProperty('--fs', settings.fontScale);
    for (const b of document.querySelectorAll('#fontSeg button')) b.classList.toggle('on', +b.dataset.size === +settings.fontScale);
  }
  function openSettings() {
    $('apiUrlInput').value = settings.apiUrl;
    $('apiKeyInput').value = settings.apiKey;
    $('settingsError').hidden = true;
    applyFont();
    $('settingsBackdrop').hidden = false;
  }
  function saveSettings() {
    const url = $('apiUrlInput').value.trim();
    const key = $('apiKeyInput').value.trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) {
      $('settingsError').textContent = 'URLは https://script.google.com/macros/s/…/exec の形で入れてください';
      $('settingsError').hidden = false;
      return;
    }
    if (!key) {
      $('settingsError').textContent = '合言葉を入れてください';
      $('settingsError').hidden = false;
      return;
    }
    settings.apiUrl = url;
    settings.apiKey = key;
    settings.demo = false;
    store.set('settings', settings);
    $('settingsBackdrop').hidden = true;
    load();
  }

  // ===== デモデータ（接続前の見た目確認用） =====
  function demoData(y, m) {
    const D = (d) => ymd(dn(y, m, d));
    const T = (d, h, mi = 0) => `${D(d)}T${pad(h)}:${pad(mi)}`;
    const ev = (title, start, end, colorId, extra = {}) => Object.assign({ id: title + start, title, start, end, allDay: start.length === 10, colorId, location: '', description: '' }, extra);
    const events = [
      ev('〇〇邸 外壁塗装', D(3), D(13), '', { location: '千葉県松戸市', description: '足場：3日設置\n下塗り→中塗り→上塗り' }),
      ev('△△マンション 大規模修繕', D(-2), D(21), '10'),
      ev('□□ビル 屋上防水', D(14), D(19), '4'),
      ev('◇◇様邸 付帯部塗装', D(22), D(27), '5'),
      ev('☆☆アパート 鉄部塗装', D(27), D(36), '11'),
      ev('見積提出', D(8), D(9), '11'),
      ev('材料搬入', D(17), D(18), '2'),
      ev('夜間作業 ××駅前', T(11, 20), T(13, 5), '8'),
      ev('現場調査 松戸', T(10, 8), T(10, 9), '4'),
      ev('打合せ（元請）', T(10, 9, 30), T(10, 10, 30), '1'),
      ev('近隣あいさつ', T(10, 10), T(10, 11), '2'),
      ev('塗料受け取り', T(10, 13), T(10, 13, 30), '6'),
      ev('色決め立会い', T(10, 14, 30), T(10, 15, 30), '3'),
      ev('職人手配の電話', T(10, 16), T(10, 16, 30)),
      ev('見積作成', T(10, 18), T(10, 20), '11'),
      ev('完了検査', T(19, 10), T(19, 11), '10'),
      ev('請求書送付', T(25, 9), T(25, 9, 30)),
      ev('足場解体', T(24, 8), T(24, 12), '5'),
      ev('打合せ', T(4, 15), T(4, 16), '1'),
    ];
    const t = new Date();
    if (t.getFullYear() === y && t.getMonth() === m) {
      events.push(ev('朝礼', T(t.getDate(), 7, 45), T(t.getDate(), 8), '8'));
      events.push(ev('現場確認', T(t.getDate(), 13), T(t.getDate(), 14), '7'));
    }
    return { calendarColor: '#039BE5', events, holidays: [], fetchedAt: new Date().toISOString() };
  }

  // ===== イベント =====
  $('prevBtn').addEventListener('click', () => moveMonth(-1));
  $('nextBtn').addEventListener('click', () => moveMonth(1));
  $('todayBtn').addEventListener('click', goToday);
  $('refreshBtn').addEventListener('click', load);
  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsSave').addEventListener('click', saveSettings);
  $('settingsClose').addEventListener('click', () => { $('settingsBackdrop').hidden = true; });
  $('demoBtn').addEventListener('click', () => { settings.demo = true; store.set('settings', settings); $('settingsBackdrop').hidden = true; load(); });
  $('detailClose').addEventListener('click', () => { $('detailBackdrop').hidden = true; });
  for (const id of ['detailBackdrop', 'settingsBackdrop']) {
    $(id).addEventListener('click', (e) => { if (e.target.id === id) $(id).hidden = true; });
  }
  $('fontSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    settings.fontScale = +b.dataset.size;
    store.set('settings', settings);
    applyFont();
  });

  // 左右スワイプで月を切り替え
  let touch = null;
  $('calendar').addEventListener('touchstart', (e) => { if (e.touches.length === 1) touch = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }, { passive: true });
  $('calendar').addEventListener('touchend', (e) => {
    if (!touch) return;
    const dx = e.changedTouches[0].clientX - touch.x, dy = e.changedTouches[0].clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.8) moveMonth(dx < 0 ? 1 : -1);
  }, { passive: true });

  // アプリに戻ってきたら最新を読み込む（1分以上たっていれば）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastFetch > 60000) load();
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted) load(); });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  applyFont();
  load();
})();
