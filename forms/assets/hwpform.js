/* 서식 바로 작성 엔진 (한글 HWP·HWPX 원본 그대로)
   - 원본 한글 파일을 브라우저 안에서 열어(rhwp, MIT) 그대로 그리고,
     입력값을 원본 문서의 정해진 자리에 글자로 넣은 뒤 같은 형식(HWPX/HWP)이나 PDF로 내려받습니다.
   - 입력 내용은 이 브라우저(localStorage)에만 저장되고 어디로도 보내지 않습니다.

   서식 페이지는 window.DG_FORM 하나만 정의합니다.
   { id, title, file:'원본.hwpx', fields:[ ... ] }
   칸(field):
     id, label, type:'text'|'check'|'money'|'num', ph(예시), g(칸 목록 묶음 제목)
     at: 넣을 자리 — 표 칸 {s, p, path:[[표번호, 칸번호, 칸안문단]], o} / 본문 {s, p, o}
         (s 구역, p 문단, o 글자 위치: 문단 처음부터 몇 번째 글자 앞에 넣을지)
     eat: 넣는 글자 뒤 빈칸(스페이스)을 글자 폭만큼 최대 몇 개까지 지울지 (줄 맞춤 유지용)
     del: 채웠을 때 지울 원래 글자 수 (예: □ 를 ■ 로 바꿀 때 1)
     mark: 체크 표시 글자 (기본 '■'), w: 입력 칸 너비(쪽 px, 기본은 칸 오른쪽 끝까지)
     post: 넣는 글자 뒤에 붙일 글자(예: ' '), sum: [더할 칸 id...] 자동 합계 */
import init, { HwpDocument } from './rhwp/rhwp.js';

const F = window.DG_FORM;
const $ = (s, r) => (r || document).querySelector(s);
const KEY = 'dgform:' + F.id;
const EDIT = /[?&]edit=1/.test(location.search);
const pagesBox = $('#pages'), sideList = $('#sideList'), savedEl = $('#saved'), statusEl = $('#loadStatus');
let SRC = null, EXT = 'hwpx', doc = null, vals = {}, overlays = {}, sideEls = {}, pageInfo = [];

/* ── 글자 폭 측정 (rhwp 필수) ── */
let mctx = null, lastFont = '';
globalThis.measureTextWidth = (font, text) => {
  if (!mctx) mctx = document.createElement('canvas').getContext('2d');
  if (font !== lastFont) { mctx.font = font; lastFont = font; }
  return mctx.measureText(text).width;
};

/* ── 저장 ── */
function load() { try { const o = JSON.parse(localStorage.getItem(KEY) || 'null'); if (o && o.v) vals = o.v; } catch (e) {} }
let saveT;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    const has = Object.keys(vals).some(k => vals[k] !== '' && vals[k] !== false && vals[k] != null);
    try { if (has) localStorage.setItem(KEY, JSON.stringify({ v: vals, t: Date.now() })); else localStorage.removeItem(KEY); } catch (e) {}
    if (savedEl) { savedEl.textContent = has ? '이 기기에 자동 저장됨' : ''; savedEl.classList.toggle('on', has); }
  }, 250);
}

const digits = s => String(s == null ? '' : s).replace(/[^\d-]/g, '');
const comma = s => { const d = digits(s); if (d === '' || d === '-') return d; const n = parseInt(d, 10); return isNaN(n) ? '' : n.toLocaleString('ko-KR'); };
const num = s => { const n = parseInt(digits(s), 10); return isNaN(n) ? 0 : n; };
const byId = id => F.fields.find(f => f.id === id);
const vwidth = s => [...s].reduce((a, c) => a + (/[ᄀ-ᇿ　-鿿가-힯＀-￯]/.test(c) ? 2 : 1), 0);

/* ── 문서 다루기 ── */
const isCell = a => a.path && a.path.length;
const pathJson = a => JSON.stringify(a.path.map(x => ({ controlIndex: x[0], cellIndex: x[1], cellParaIndex: x[2] })));
const paraKey = a => a.s + ':' + a.p + ':' + (isCell(a) ? JSON.stringify(a.path) : 'b');
function textAt(d, a, o, n) {
  try {
    if (isCell(a)) {
      if (a.path.length === 1) { const [ci, cell, cp] = a.path[0]; return d.getTextInCell(a.s, a.p, ci, cell, cp, o, n); }
      return '';
    }
    return d.getTextRange(a.s, a.p, o, n);
  } catch (e) { return ''; }
}
function del(d, a, o, n) {
  if (n <= 0) return;
  if (isCell(a)) d.deleteTextInCellByPath(a.s, a.p, pathJson(a), o, n);
  else d.deleteText(a.s, a.p, o, n);
}
function ins(d, a, o, t) {
  if (!t) return;
  if (isCell(a)) d.insertTextInCellByPath(a.s, a.p, pathJson(a), o, t);
  else d.insertText(a.s, a.p, o, t);
  // 원본 자리의 글자색이 흐리거나 흰색(안내 문구 등)이면 검정으로
  try {
    let pr;
    if (isCell(a) && a.path.length === 1) { const [ci, cell, cp] = a.path[0]; pr = JSON.parse(d.getCellCharPropertiesAt(a.s, a.p, ci, cell, cp, o)); }
    else if (!isCell(a)) pr = JSON.parse(d.getCharPropertiesAt(a.s, a.p, o));
    if (pr && pr.textColor && pr.textColor.toLowerCase() !== '#000000') {
      const c = pr.textColor.replace('#', ''), r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
      if ((r * 299 + g * 587 + b * 114) / 1000 > 140) {
        const props = JSON.stringify({ textColor: '#000000' });
        if (isCell(a)) { const [ci, cell, cp] = a.path[0]; d.applyCharFormatInCell(a.s, a.p, ci, cell, cp, o, o + t.length, props); }
        else d.applyCharFormat(a.s, a.p, o, o + t.length, props);
      }
    }
  } catch (e) {}
}
function fillDoc(d) {
  // 같은 문단 안에서는 뒤쪽 자리부터 넣어야 앞 자리 위치가 밀리지 않음
  const list = F.fields.filter(f => f.at && (f.type === 'check' ? vals[f.id] : (vals[f.id] != null && vals[f.id] !== '')));
  list.sort((x, y) => paraKey(x.at) === paraKey(y.at) ? y.at.o - x.at.o : 0);
  const groups = {};
  list.forEach(f => (groups[paraKey(f.at)] = groups[paraKey(f.at)] || []).push(f));
  Object.values(groups).forEach(g => {
    g.sort((x, y) => y.at.o - x.at.o);
    g.forEach(f => {
      const a = f.at;
      try {
        if (f.type === 'check') { del(d, a, a.o, f.del == null ? 1 : f.del); ins(d, a, a.o, f.mark || '■'); return; }
        const t = String(vals[f.id]) + (f.post || '');
        if (f.del) del(d, a, a.o, f.del);
        if (f.eat) {
          const after = textAt(d, a, a.o, f.eat); let n = 0;
          while (n < after.length && after[n] === ' ') n++;
          del(d, a, a.o, Math.min(n, vwidth(t)));
        }
        ins(d, a, a.o, t);
      } catch (e) { console.warn('칸 넣기 실패', f.id, e); }
    });
  });
  return d;
}
const freshDoc = () => { const d = new HwpDocument(new Uint8Array(SRC)); try { d.setFileName && d.setFileName(F.file); } catch (e) {} return d; };

/* ── 그리기 ── */
function renderPages() {
  if (doc) { try { doc.free(); } catch (e) {} }
  doc = fillDoc(freshDoc());
  const n = doc.pageCount();
  while (pagesBox.children.length > n) pagesBox.lastChild.remove();
  for (let i = 0; i < n; i++) {
    let pg = pagesBox.children[i];
    if (!pg) {
      pg = document.createElement('div'); pg.className = 'page'; pg.dataset.p = i;
      pg.innerHTML = '<div class="svg"></div>'; pagesBox.appendChild(pg);
    }
    const info = JSON.parse(doc.getPageInfo(i)); pageInfo[i] = info;
    pg.style.aspectRatio = info.width + '/' + info.height;
    pg.style.setProperty('--pw', (info.width * 25.4 / 96).toFixed(2) + 'mm');
    pg.style.setProperty('--ph', (info.height * 25.4 / 96).toFixed(2) + 'mm');
    $('.svg', pg).innerHTML = doc.renderPageSvg(i);
  }
}
let renderT;
const scheduleRender = () => { clearTimeout(renderT); renderT = setTimeout(renderPages, 180); };

/* 입력 칸(겹쳐 놓는 칸) 위치: 원본 문서 기준으로 한 번 계산 */
function fieldRect(d, f) {
  const a = f.at;
  let r;
  if (isCell(a)) r = JSON.parse(d.getCursorRectByPath(a.s, a.p, pathJson(a), a.o));
  else r = JSON.parse(d.getCursorRect(a.s, a.p, a.o));
  if (!r || r.pageIndex == null) return null;
  const info = pageInfo[r.pageIndex] || JSON.parse(d.getPageInfo(r.pageIndex));
  let w = f.w;
  if (!w && isCell(a)) {
    try {
      const [ci, cell] = a.path[0];
      const bb = JSON.parse(d.getTableCellBboxes(a.s, a.p, ci, r.pageIndex)).find(c => c.cellIdx === cell);
      if (bb && a.path.length === 1) w = bb.x + bb.w - r.x - 4;
    } catch (e) {}
  }
  if (f.type === 'check') w = r.height;
  if (!w || w < 20) w = 120;
  const h = f.type === 'check' ? r.height : Math.max(r.height * 1.25, 16);
  const y = f.type === 'check' ? r.y : r.y - (h - r.height) / 2;
  return { page: r.pageIndex, x: r.x / info.width * 100, y: y / info.height * 100, w: w / info.width * 100, h: h / info.height * 100, fs: r.height * 0.78 / info.width * 100 };
}

function buildOverlays() {
  document.querySelectorAll('.page .fld,.page .ck').forEach(e => e.remove());
  overlays = {};
  const d = freshDoc();
  F.fields.forEach(f => {
    if (!f.at) return;
    let rc; try { rc = fieldRect(d, f); } catch (e) { console.warn('칸 위치 못 찾음', f.id, e); }
    if (!rc) return;
    const pg = pagesBox.children[rc.page]; if (!pg) return;
    let el;
    if (f.type === 'check') {
      el = document.createElement('button'); el.type = 'button'; el.className = 'ck'; el.setAttribute('role', 'checkbox');
      el.setAttribute('aria-checked', vals[f.id] ? 'true' : 'false');
      el.addEventListener('click', () => { setVal(f.id, !vals[f.id]); save(); scheduleRender(); });
    } else {
      el = document.createElement('input'); el.type = 'text'; el.autocomplete = 'off';
      el.className = 'fld' + (f.type === 'money' || f.align === 'r' ? ' r' : f.align === 'c' ? ' c' : '') + (f.sum ? ' calc' : '');
      if (f.type === 'money' || f.type === 'num') el.inputMode = 'numeric';
      if (f.ph) el.placeholder = f.ph;
      if (f.sum) { el.readOnly = true; el.title = '자동 합계'; }
      el.value = vals[f.id] || '';
      el.classList.toggle('has', !!el.value);
      el.addEventListener('input', () => onInput(f, el));
      el.style.setProperty('--fs', rc.fs.toFixed(3));
    }
    el.setAttribute('aria-label', f.label || f.id);
    if (f.label && !el.title) el.title = f.label;
    el.style.left = rc.x + '%'; el.style.top = rc.y + '%'; el.style.width = rc.w + '%'; el.style.height = rc.h + '%';
    el.dataset.id = f.id; pg.appendChild(el); overlays[f.id] = el;
  });
  d.free();
}

function setVal(id, v, from) {
  vals[id] = v;
  const f = byId(id);
  [overlays[id], sideEls[id]].forEach(el => {
    if (!el || el === from) return;
    if (f.type === 'check') { if (el.type === 'checkbox') el.checked = !!v; else el.setAttribute('aria-checked', v ? 'true' : 'false'); }
    else el.value = v == null ? '' : v;
  });
  if (overlays[id] && f.type !== 'check') overlays[id].classList.toggle('has', !!v);
}
function recalc() {
  F.fields.forEach(f => {
    if (!f.sum) return;
    let t = 0, any = false;
    f.sum.forEach(id => { const v = vals[id]; if (v !== '' && v != null) { any = true; t += num(v); } });
    setVal(f.id, any ? t.toLocaleString('ko-KR') : '');
  });
}
function onInput(f, el) {
  let v = el.value;
  if (f.type === 'money') { const pos = el.value.length - el.selectionStart; v = comma(v); el.value = v; try { const p = Math.max(0, v.length - pos); el.setSelectionRange(p, p); } catch (e) {} }
  else if (f.type === 'num') { v = v.replace(/[^\d.\-]/g, ''); el.value = v; }
  setVal(f.id, v, el); recalc(); save(); scheduleRender();
}

function buildSide() {
  if (!sideList) return; sideList.innerHTML = ''; sideEls = {};
  F.fields.forEach(f => {
    if (f.g) { const g = document.createElement('div'); g.className = 'grp'; g.textContent = f.g; sideList.appendChild(g); }
    const id = 's_' + f.id; let el;
    if (f.type === 'check') {
      const lb = document.createElement('label'); lb.className = 'chk';
      el = document.createElement('input'); el.type = 'checkbox'; el.id = id; el.checked = !!vals[f.id];
      el.addEventListener('change', () => { setVal(f.id, el.checked, el); save(); scheduleRender(); });
      lb.appendChild(el); lb.appendChild(document.createTextNode(f.label || f.id)); sideList.appendChild(lb);
    } else {
      const l = document.createElement('label'); l.htmlFor = id; l.textContent = f.label || f.id; sideList.appendChild(l);
      el = document.createElement('input'); el.type = 'text'; el.autocomplete = 'off'; el.className = 'in'; el.id = id;
      if (f.type === 'money' || f.type === 'num') el.inputMode = 'numeric';
      if (f.ph) el.placeholder = f.ph;
      if (f.sum) { el.readOnly = true; el.placeholder = '자동 합계'; }
      el.value = vals[f.id] || '';
      el.addEventListener('input', () => onInput(f, el));
      sideList.appendChild(el);
    }
    el.addEventListener('focus', () => {
      const t = overlays[f.id]; if (!t) return;
      t.classList.remove('hit'); void t.offsetWidth; t.classList.add('hit');
      if (window.matchMedia('(min-width:1061px)').matches) t.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    sideEls[f.id] = el;
  });
}

/* ── 내려받기 ── */
function download(kind) {
  const d = fillDoc(freshDoc());
  let bytes;
  try { bytes = kind === 'hwp' ? d.exportHwp() : d.exportHwpx(); }
  catch (e) { alert('파일을 만들지 못했습니다. 다른 형식으로 받아 보시거나 인쇄 · PDF 저장을 이용해 주세요.'); console.error(e); d.free(); return; }
  d.free();
  const blob = new Blob([bytes], { type: kind === 'hwp' ? 'application/x-hwp' : 'application/hwp+zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = F.title + '_작성.' + kind;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ── 버튼 ── */
const on = (sel, fn) => { const b = $(sel); if (b) b.addEventListener('click', fn); };
on('#btnPrint', () => { clearTimeout(renderT); renderPages(); window.print(); });
on('#btnHwpx', () => download('hwpx'));
on('#btnHwp', () => download('hwp'));
on('#btnClear', () => {
  if (!confirm('작성한 내용을 모두 지울까요? 이 기기에 저장된 내용도 함께 지워집니다.')) return;
  vals = {}; try { localStorage.removeItem(KEY); } catch (e) {}
  buildSide(); buildOverlays(); recalc(); save(); renderPages();
});
on('#btnList', () => document.body.classList.add('list-open'));
on('#btnListClose', () => document.body.classList.remove('list-open'));
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.body.classList.remove('list-open'); });
document.addEventListener('click', e => {
  if (document.body.classList.contains('list-open') && !e.target.closest('.side') && !e.target.closest('#btnList')) document.body.classList.remove('list-open');
});
const dlMenu = $('#dlMenu');
on('#btnDl', e => { e.stopPropagation(); dlMenu && dlMenu.classList.toggle('open'); });
document.addEventListener('click', e => { if (dlMenu && !e.target.closest('.dl')) dlMenu.classList.remove('open'); });

/* ── 시작 ── */
async function loadFonts() {
  if (!document.fonts || !document.fonts.load) return;
  const fams = ['Pretendard Variable', 'Noto Sans KR', 'Noto Serif KR'];
  try { await Promise.race([Promise.all(fams.flatMap(f => [document.fonts.load('16px "' + f + '"', '가나다'), document.fonts.load('bold 16px "' + f + '"', '가나다')])), new Promise(r => setTimeout(r, 4000))]); } catch (e) {}
}
async function start() {
  load();
  try {
    const wasm = new URL('./rhwp/rhwp_bg.wasm', import.meta.url);
    await Promise.all([loadFonts(), init({ module_or_path: wasm })]);
    const res = await fetch(F.file);
    if (!res.ok) throw new Error('서식 파일을 찾지 못했습니다');
    SRC = await res.arrayBuffer();
    EXT = /\.hwp$/i.test(F.file) ? 'hwp' : 'hwpx';
    document.body.dataset.ext = EXT;
    renderPages(); buildSide(); buildOverlays(); recalc(); save(); renderPages();
    if (statusEl) statusEl.hidden = true;
    if (EDIT) editMode();
  } catch (e) {
    console.error(e);
    if (statusEl) { statusEl.hidden = false; statusEl.classList.add('err'); statusEl.textContent = '서식을 여는 중 문제가 생겼습니다. 새로고침해 보시고, 계속되면 카카오톡으로 알려 주세요.'; }
  }
}
start();
window.addEventListener('beforeprint', () => { clearTimeout(renderT); });

/* ───── 칸 자리 잡기 모드 (주소 뒤에 ?edit=1, 관리용) ─────
   양식에서 글자를 넣을 자리를 누르면 그 위치 정보가 나오고, '칸 추가'로 목록에 넣습니다. */
function editMode() {
  const panel = document.createElement('div'); panel.className = 'epanel';
  panel.innerHTML = '<b>칸 자리 잡기</b> · 양식에서 글자를 넣을 자리를 누르세요<div id="ehit" class="ehit">-</div>' +
    '<div class="row"><button class="b" id="eAdd" type="button">이 자리에 칸 추가</button><button class="b" id="eChk" type="button">체크칸으로 추가</button><button class="b" id="eApply" type="button">글 내용 적용</button><button class="b" id="eCopy" type="button">복사</button></div>' +
    '<textarea id="ejson" spellcheck="false"></textarea>';
  document.body.appendChild(panel);
  const ta = $('#ejson'), hitEl = $('#ehit'); let last = null;
  const dump = () => { ta.value = '[\n' + F.fields.map(f => ' ' + JSON.stringify(f)).join(',\n') + '\n]'; };
  dump();
  pagesBox.addEventListener('click', e => {
    const pg = e.target.closest('.page'); if (!pg || e.target.closest('.fld,.ck')) return;
    const i = +pg.dataset.p, r = pg.getBoundingClientRect(), info = pageInfo[i];
    const x = (e.clientX - r.left) / r.width * info.width, y = (e.clientY - r.top) / r.height * info.height;
    const d = freshDoc(); const h = JSON.parse(d.hitTest(i, x, y));
    let at;
    if (h.cellPath) at = { s: h.sectionIndex, p: h.parentParaIndex, path: h.cellPath.map(c => [c.controlIndex, c.cellIndex, c.cellParaIndex]), o: h.charOffset };
    else at = { s: h.sectionIndex, p: h.paragraphIndex, o: h.charOffset };
    const before = textAt(d, at, Math.max(0, at.o - 8), Math.min(8, at.o)), after = textAt(d, at, at.o, 8);
    d.free(); last = at;
    hitEl.textContent = JSON.stringify(at) + '   「' + before + '│' + after + '」';
  });
  const add = type => {
    if (!last) return alert('먼저 양식에서 자리를 누르세요');
    const label = prompt('칸 이름 (칸 목록에 보일 이름)', ''); if (label == null) return;
    let n = 1; while (byId('f' + n)) n++;
    const f = { id: 'f' + n, label, at: last }; if (type) f.type = type;
    F.fields.push(f); dump(); buildSide(); buildOverlays();
  };
  on('#eAdd', () => add());
  on('#eChk', () => add('check'));
  on('#eApply', () => { try { F.fields = JSON.parse(ta.value); buildSide(); buildOverlays(); renderPages(); } catch (err) { alert('글 형식이 맞지 않습니다: ' + err.message); } });
  on('#eCopy', () => { ta.select(); try { navigator.clipboard.writeText(ta.value); } catch (e) { document.execCommand('copy'); } });
}
