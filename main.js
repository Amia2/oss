'use strict';
// HWPX = ZIP + XML (OWPML). JSZip으로 압축을 풀고, 브라우저 내장 DOMParser로 XML을 읽는다.

const $ = (id) => document.getElementById(id);
const PX = 1 / 75; // HWPUNIT(1/7200 inch) -> px(96dpi)
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml' };

// ---- XML 헬퍼: 접두사(hp:, hh:)에 의존하지 않도록 localName으로 찾는다 ----
const kids = (el, n) => Array.from(el.children).filter((c) => c.localName === n);
const first = (el, n) => (el ? kids(el, n)[0] : undefined);
const all = (el, n) => Array.from(el.getElementsByTagNameNS('*', n));
const num = (v) => Number(v) || 0;

function parseXml(text, label) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error(`${label} 파싱 실패`);
  return doc;
}
const findEntry = (zip, path) => {
  const p = path.replace(/^\.?\//, '').toLowerCase();
  return Object.values(zip.files).find((f) => !f.dir && f.name.toLowerCase() === p);
};
async function readXml(zip, path) {
  const f = findEntry(zip, path);
  if (!f) throw new Error(`${path} 파일이 없습니다`);
  return parseXml(await f.async('string'), path);
}
const baseName = (p) => p.split('/').pop().replace(/\.[^.]+$/, '');

// ---- 1단계: header.xml 의 글자/문단 스타일 ----
function parseHeader(doc) {
  const charPr = new Map(), paraPr = new Map();
  for (const el of all(doc, 'charPr')) {
    const ul = first(el, 'underline'), st = first(el, 'strikeout');
    charPr.set(el.getAttribute('id'), {
      size: num(el.getAttribute('height')) / 100, // 1000 = 10pt
      color: el.getAttribute('textColor'),
      bold: !!first(el, 'bold'),
      italic: !!first(el, 'italic'),
      underline: !!ul && ul.getAttribute('type') !== 'NONE',
      strike: !!st && st.getAttribute('shape') !== 'NONE',
    });
  }
  for (const el of all(doc, 'paraPr')) {
    const align = all(el, 'align')[0]?.getAttribute('horizontal');
    const ls = all(el, 'lineSpacing')[0];
    paraPr.set(el.getAttribute('id'), {
      align: { CENTER: 'center', RIGHT: 'right', JUSTIFY: 'justify', LEFT: 'left' }[align],
      lineHeight: ls && ls.getAttribute('type') === 'PERCENT' ? num(ls.getAttribute('value')) / 100 : 0,
    });
  }
  return { charPr, paraPr };
}

// ---- 2단계: content.hpf (섹션 순서, 이미지 ID -> 파일) ----
async function loadManifest(zip) {
  const f = findEntry(zip, 'Contents/content.hpf');
  const items = new Map(); let spine = [];
  if (f) {
    const doc = parseXml(await f.async('string'), 'content.hpf');
    for (const it of all(doc, 'item')) items.set(it.getAttribute('id'), it.getAttribute('href'));
    spine = all(doc, 'itemref').map((r) => items.get(r.getAttribute('idref'))).filter((h) => /section\d+\.xml$/i.test(h || ''));
  }
  if (!spine.length) {
    spine = Object.keys(zip.files).filter((n) => /^contents\/section\d+\.xml$/i.test(n)).sort();
  }
  return { items, spine };
}
async function loadImages(zip, manifest) {
  const urls = new Map();
  for (const f of Object.values(zip.files)) {
    if (f.dir || !/^bindata\//i.test(f.name)) continue;
    const ext = f.name.split('.').pop().toLowerCase();
    const blob = new Blob([await f.async('uint8array')], { type: MIME[ext] || '' });
    urls.set(baseName(f.name), URL.createObjectURL(blob));
  }
  for (const [id, href] of manifest.items) {
    const u = href && urls.get(baseName(href));
    if (u) urls.set(id, u);
  }
  return urls;
}

// ---- 3단계: 렌더링 (textContent / append(text)만 사용 -> XSS 방지) ----
function renderText(t, span) {
  for (const n of t.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) span.append(n.data);
    else if (n.localName === 'lineBreak') span.append(document.createElement('br'));
    else if (n.localName === 'tab') span.append('\u2003');
    else if (n.localName === 'nbSpace') span.append('\u00A0');
    else if (n.localName === 'fwSpace') span.append('\u3000');
  }
}
function applyChar(span, c) {
  if (!c) return;
  if (c.size) span.style.fontSize = c.size + 'pt';
  if (/^#[0-9a-f]{6}$/i.test(c.color || '')) span.style.color = c.color;
  if (c.bold) span.style.fontWeight = 'bold';
  if (c.italic) span.style.fontStyle = 'italic';
  const deco = [c.underline && 'underline', c.strike && 'line-through'].filter(Boolean).join(' ');
  if (deco) span.style.textDecoration = deco;
}
function missing(msg) {
  const s = document.createElement('span'); s.className = 'missing'; s.textContent = msg; return s;
}
function renderPic(pic, ctx) {
  const ref = all(pic, 'img')[0]?.getAttribute('binaryItemIDRef');
  const url = ctx.urls.get(ref);
  if (!url) return missing(`[이미지 없음: ${ref}]`);
  const w = num(first(pic, 'curSz')?.getAttribute('width')) || num(first(pic, 'sz')?.getAttribute('width'));
  const img = new Image();
  img.src = url; img.alt = '문서 이미지'; img.style.maxWidth = '100%';
  if (w) img.style.width = w * PX + 'px';
  img.onerror = () => img.replaceWith(missing('[표시할 수 없는 이미지 형식]'));
  return img;
}
function renderTable(tbl, ctx) {
  const t = document.createElement('table'); t.className = 'hwpx-tbl';
  const sz = first(tbl, 'sz');
  if (sz) t.style.width = num(sz.getAttribute('width')) * PX + 'px';
  for (const tr of kids(tbl, 'tr')) {
    const row = t.insertRow();
    for (const tc of kids(tr, 'tc')) {
      const td = row.insertCell();
      const span = first(tc, 'cellSpan');
      if (span) { td.colSpan = num(span.getAttribute('colSpan')) || 1; td.rowSpan = num(span.getAttribute('rowSpan')) || 1; }
      const cw = num(first(tc, 'cellSz')?.getAttribute('width'));
      if (cw) td.style.width = cw * PX + 'px';
      for (const p of kids(first(tc, 'subList') || tc, 'p')) td.append(renderParagraph(p, ctx));
    }
  }
  return t;
}
function renderParagraph(p, ctx) {
  const box = document.createElement('div'); box.className = 'hwpx-p';
  const pp = ctx.styles.paraPr.get(p.getAttribute('paraPrIDRef'));
  if (pp?.align) box.style.textAlign = pp.align;
  if (pp?.lineHeight) box.style.lineHeight = pp.lineHeight;
  for (const run of kids(p, 'run')) {
    const cp = ctx.styles.charPr.get(run.getAttribute('charPrIDRef'));
    for (const node of run.children) {
      if (node.localName === 't') {
        const span = document.createElement('span');
        applyChar(span, cp); renderText(node, span); box.append(span);
      } else if (node.localName === 'tbl') box.append(renderTable(node, ctx));
      else if (node.localName === 'pic') box.append(renderPic(node, ctx));
    }
  }
  if (!box.childNodes.length) box.append(document.createElement('br')); // 빈 문단도 줄 높이 유지
  return box;
}
function renderSection(doc, ctx) {
  const sheet = document.createElement('section'); sheet.className = 'sheet';
  const pg = all(doc, 'pagePr')[0], mg = first(pg, 'margin');
  if (pg) sheet.style.width = num(pg.getAttribute('width')) * PX + 'px';
  if (mg) sheet.style.padding = ['top', 'right', 'bottom', 'left'].map((k) => num(mg.getAttribute(k)) * PX + 'px').join(' ');
  for (const p of kids(doc.documentElement, 'p')) sheet.append(renderParagraph(p, ctx));
  return sheet;
}


// ---- DOCX 지원: WordprocessingML(document.xml) 렌더링 ----
const wordKids = (el, n) => Array.from(el?.children || []).filter((c) => c.localName === n);
const wordAll = (el, n) => Array.from(el?.getElementsByTagNameNS('*', n) || []);

function wordText(node, target) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) target.append(child.data);
    else if (child.nodeType === Node.ELEMENT_NODE) {
      switch (child.localName) {
        case 't': target.append(child.textContent || ''); break;
        case 'tab': target.append('\u2003'); break;
        case 'br':
        case 'cr': target.append(document.createElement('br')); break;
        case 'noBreakHyphen': target.append('\u2011'); break;
        case 'softHyphen': target.append('\u00AD'); break;
        case 'drawing':
        case 'pict':
          // 이미지는 기본 텍스트 렌더링 범위 밖이므로 문서의 텍스트/표 구조를 우선 표시한다.
          break;
        default: wordText(child, target);
      }
    }
  }
}

function wordRun(run) {
  const span = document.createElement('span');
  const rPr = wordKids(run, 'rPr')[0];
  if (rPr) {
    if (wordKids(rPr, 'b').length && wordKids(rPr, 'b')[0].getAttribute('val') !== '0' &&
        wordKids(rPr, 'b')[0].getAttribute('val') !== 'false') span.style.fontWeight = 'bold';
    if (wordKids(rPr, 'i').length && wordKids(rPr, 'i')[0].getAttribute('val') !== '0' &&
        wordKids(rPr, 'i')[0].getAttribute('val') !== 'false') span.style.fontStyle = 'italic';
    if (wordKids(rPr, 'u').length && wordKids(rPr, 'u')[0].getAttribute('val') !== 'none')
      span.style.textDecoration = 'underline';
    const color = wordKids(rPr, 'color')[0]?.getAttribute('val');
    if (color && /^[0-9a-f]{6}$/i.test(color)) span.style.color = '#' + color;
    const size = wordKids(rPr, 'sz')[0]?.getAttribute('val');
    if (size && /^\d+$/.test(size)) span.style.fontSize = (Number(size) / 2) + 'pt';
    const fonts = wordKids(rPr, 'rFonts')[0];
    const font = fonts?.getAttribute('ascii') || fonts?.getAttribute('eastAsia');
    if (font) span.style.fontFamily = font;
  }
  wordText(run, span);
  return span;
}

function wordParagraph(p) {
  const box = document.createElement('div');
  box.className = 'hwpx-p';
  box.style.whiteSpace = 'pre-wrap';
  const pPr = wordKids(p, 'pPr')[0];
  const jc = wordKids(pPr, 'jc')[0]?.getAttribute('val');
  const align = { center: 'center', right: 'right', both: 'justify', distribute: 'justify', left: 'left' }[jc];
  if (align) box.style.textAlign = align;
  const spacing = wordKids(pPr, 'spacing')[0];
  if (spacing?.getAttribute('line')) {
    const line = Number(spacing.getAttribute('line'));
    if (Number.isFinite(line) && line > 0) box.style.lineHeight = (line / 240) + 'em';
  }
  for (const child of p.children) {
    if (child.localName === 'r') box.append(wordRun(child));
    else if (child.localName === 'hyperlink') {
      for (const r of wordKids(child, 'r')) box.append(wordRun(r));
    } else if (child.localName === 'bookmarkStart' || child.localName === 'bookmarkEnd' ||
               child.localName === 'proofErr' || child.localName === 'pPr') {
      // 화면에 출력하지 않는 구조/서식 정보
    } else if (child.localName === 'sdt') {
      for (const p2 of wordAll(child, 'p')) box.append(wordParagraph(p2));
    }
  }
  if (!box.childNodes.length) box.append(document.createElement('br'));
  return box;
}

function wordTable(tbl) {
  const table = document.createElement('table');
  table.className = 'hwpx-tbl';
  for (const tr of wordKids(tbl, 'tr')) {
    const row = table.insertRow();
    for (const tc of wordKids(tr, 'tc')) {
      const cell = row.insertCell();
      const tcPr = wordKids(tc, 'tcPr')[0];
      const gridSpan = wordKids(tcPr, 'gridSpan')[0]?.getAttribute('val');
      if (gridSpan && Number(gridSpan) > 1) cell.colSpan = Number(gridSpan);
      for (const child of tc.children) {
        if (child.localName === 'p') cell.append(wordParagraph(child));
        else if (child.localName === 'tbl') cell.append(wordTable(child));
      }
    }
  }
  return table;
}

async function openDocx(file, viewer) {
  const zip = await JSZip.loadAsync(file);
  const entry = findEntry(zip, 'word/document.xml');
  if (!entry) throw new Error('DOCX 내부에 word/document.xml 파일이 없습니다.');
  const xml = parseXml(await entry.async('string'), 'word/document.xml');
  const body = wordAll(xml, 'body')[0];
  if (!body) throw new Error('DOCX 본문(body)을 찾을 수 없습니다.');
  const page = document.createElement('section');
  page.className = 'sheet';
  page.style.width = '794px';
  page.style.maxWidth = '100%';
  page.style.padding = '72px 68px';
  page.style.minHeight = '1123px';
  for (const child of body.children) {
    if (child.localName === 'p') page.append(wordParagraph(child));
    else if (child.localName === 'tbl') page.append(wordTable(child));
  }
  viewer.append(page);
  $('tree').textContent = Object.values(zip.files)
    .map((f) => (f.dir ? f.name : `${f.name}  (${f._data?.uncompressedSize ?? '?'} B)`)).join('\n');
  $('structure').hidden = false;
  return { entries: Object.keys(zip.files).filter((n) => !zip.files[n].dir).length };
}


// ---- 4단계: 파일 열기 / UI ----
let currentUrls = [];
async function openHwpx(file) {
  const status = $('status'), viewer = $('viewer');
  status.className = ''; status.textContent = `${file.name} 여는 중...`;
  currentUrls.forEach(URL.revokeObjectURL); currentUrls = []; viewer.replaceChildren();
  try {
    if (/\.hwp$/i.test(file.name)) throw new Error('.hwp(바이너리) 형식은 지원하지 않습니다. .hwpx 또는 .docx로 열어 주세요.');
    if (/\.docx$/i.test(file.name)) {
      const result = await openDocx(file, viewer);
      status.textContent = `${file.name} - DOCX 문서 열기 완료 (내부 파일 ${result.entries}개)`;
      return;
    }
    if (!/\.hwpx$/i.test(file.name)) throw new Error('지원하지 않는 형식입니다. .hwpx 또는 .docx 파일을 선택해 주세요.');
    const zip = await JSZip.loadAsync(file);
    const styles = parseHeader(await readXml(zip, 'Contents/header.xml'));
    const manifest = await loadManifest(zip);
    const urls = await loadImages(zip, manifest);
    currentUrls = [...new Set(urls.values())];
    const ctx = { styles, urls };
    for (const path of manifest.spine) viewer.append(renderSection(await readXml(zip, path), ctx));
    $('tree').textContent = Object.values(zip.files).map((f) => (f.dir ? f.name : `${f.name}  (${f._data?.uncompressedSize ?? '?'} B)`)).join('\n');
    $('structure').hidden = false;
    status.textContent = `${file.name} - HWPX 섹션 ${manifest.spine.length}개, 이미지 ${urls.size}개`;
  } catch (e) {
    status.className = 'error';
    status.textContent = `열 수 없습니다: ${e.message}`;
  }
}

$('file').addEventListener('change', (e) => e.target.files[0] && openHwpx(e.target.files[0]));
const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && openHwpx(e.dataTransfer.files[0]));