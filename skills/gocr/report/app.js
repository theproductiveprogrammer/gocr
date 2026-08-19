
const _savedTheme = localStorage.getItem('gocr-theme');
if (_savedTheme) document.documentElement.dataset.theme = _savedTheme;
document.getElementById('theme').onclick = () => {
  const eff = document.documentElement.dataset.theme ||
    (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const next = eff === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('gocr-theme', next);
};

let A = null;        // artifact
let pos = 0;         // 0 = cover, then story slide (if any), then claims
let walk = [];       // claim objects in story order
let whys = [];       // per-leg why, parallel to walk
let ev = null;       // {ci, ei, data} when on an evidence slide
const resCache = {}; // "claimId:idx" -> resolved evidence, so claim
                     // slides re-render inline panes without refetching

// first claim's slide position: the story gets its own slide when it has
// per-leg whys (or a legacy why essay)
const base = () =>
  (A && (whys.some(Boolean) || A.story.why) ? 2 : 1);

// the closing slide's position — the record: tallies, gaps, hand-off
const endPos = () => walk.length + base();

const $slide = document.getElementById('slide');
const esc = (s) => (s ?? '').replace(/[&<>"]/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

const inline = (t) => t
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  .replace(/\*([^*\s][^*]*)\*/g, '<i>$1</i>');

// The problem is humans scan code by shape - keywords, strings and
// comments must pop without reading every word.
// The way we solve this is a tiny per-line tokenizer: keywords bold,
// strings dim, comments faint italic - shades and weight only, no new
// hues (saturation stays reserved for judgment).
const KW = Object.fromEntries(Object.entries({
  clike: 'abstract assert boolean break byte case catch char class const' +
    ' continue default do double else enum extends final finally float for' +
    ' func function go goto if implements import instanceof int interface' +
    ' let long map new package private protected public range record return' +
    ' select sealed short static struct super switch synchronized this throw' +
    ' throws try type typeof var void volatile while yield async await of' +
    ' export null true false undefined nil',
  py: 'and as assert async await break class continue def del elif else' +
    ' except finally for from global if import in is lambda nonlocal not or' +
    ' pass raise return try while with yield None True False self',
  sql: 'select from where insert into update delete create table alter drop' +
    ' index join left right inner outer on group by order limit having' +
    ' union all as and or not null primary key foreign references default' +
    ' values set materialize materialized column exists distinct',
  sh: 'if then else elif fi for while do done case esac function local' +
    ' return export echo exit set',
}).map(([k, v]) => [k, new Set(v.split(' '))]));

const LANG_OF = (path) => ({ py: 'py', sql: 'sql', sh: 'sh', bash: 'sh',
  zsh: 'sh', yml: 'py', yaml: 'py', toml: 'py', rb: 'py', properties: 'py',
}[(path || '').split('.').pop().toLowerCase()] || 'clike');

function hlLine(t, lang) {
  const kw = KW[lang] || KW.clike;
  // block-comment continuation ("* javadoc body", "*/") — the opener
  // lives on an earlier line, so treat the whole line as comment
  if (lang === 'clike' && /^\s*\*/.test(t))
    return `<span class="tok-c">${esc(t)}</span>`;
  let out = '', i = 0;
  const push = (cls, s) => { out += cls
    ? `<span class="${cls}">${esc(s)}</span>` : esc(s); };
  while (i < t.length) {
    const ch = t[i], rest = t.slice(i);
    if ((ch === '/' && t[i + 1] === '/' && lang === 'clike') ||
        (ch === '#' && (lang === 'py' || lang === 'sh')) ||
        (ch === '-' && t[i + 1] === '-' && lang === 'sql')) {
      push('tok-c', rest); break;
    }
    if (ch === '/' && t[i + 1] === '*') {
      const e = t.indexOf('*/', i + 2);
      const end = e < 0 ? t.length : e + 2;
      push('tok-c', t.slice(i, end)); i = end; continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < t.length && t[j] !== ch) j += t[j] === '\\' ? 2 : 1;
      const end = Math.min(j + 1, t.length);
      push('tok-s', t.slice(i, end)); i = end; continue;
    }
    let m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (m) {
      push(kw.has(m[0]) ? 'tok-k'
        : (/^[A-Z]/.test(m[0]) ? 'tok-t' : ''), m[0]);
      i += m[0].length; continue;
    }
    m = /^\d[\d_.xXa-fA-F]*/.exec(rest);
    if (m) { push('tok-n', m[0]); i += m[0].length; continue; }
    push('', ch); i++;
  }
  return out;
}

const DIFF_META = /^(diff |index |--- |\+\+\+ |@@|\\ No newline)/;

// a filter pipeline renders as one chip per pattern - never [a, b],
// which reads as a regex character class and lies about the meaning
function pipelineChips(pipeline) {
  return pipeline.map(p => {
    const neg = p.startsWith('!');
    return `<span class="fchip${neg ? ' neg' : ''}">${esc(p)}</span>`;
  }).join('');
}

// minimal markdown: blank line = paragraph, "- " runs = list, `code`,
// **bold**, *italic* — enough for claim bodies, notes and the story why
function mdlite(s) {
  const out = [];
  let para = [], list = [];
  const flushP = () => { if (para.length) {
    out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const flushL = () => { if (list.length) {
    out.push('<ul>' + list.map(x => '<li>' + inline(x) + '</li>').join('')
      + '</ul>'); list = []; } };
  for (const raw of esc(s ?? '').split('\n')) {
    const l = raw.trim();
    if (!l) { flushP(); flushL(); }
    else if (l.startsWith('- ')) { flushP(); list.push(l.slice(2)); }
    else if (list.length) { list[list.length - 1] += ' ' + l; }
    else { para.push(l); }
  }
  flushP(); flushL();
  return out.join('');
}

async function load() {
  A = await (await fetch('/api/artifact')).json();
  const legs = A.story.walk.length
    ? A.story.walk
    : A.claims.map(c => ({ id: c.id, why: '' }));
  const found = legs.filter(l => A.claims.some(c => c.id === l.id));
  walk = found.map(l => A.claims.find(c => c.id === l.id));
  whys = found.map(l => l.why || '');
  window.addEventListener('popstate', applyPath);
  applyPath();
}

// the URL mirrors the slide (/M3, /M3/2). The server hands every non-api,
// non-static path to index.html, so refresh, back/forward and shared
// links land on the right card with no server-side routing at all.
function pathFor() {
  if (ev) return `/${walk[ev.ci].id}/${ev.ei + 1}`;
  if (pos === 0) return '/';
  if (pos < base()) return '/story';
  if (pos >= endPos()) return '/end';
  return `/${walk[pos - base()].id}`;
}

function syncPath() {
  if (location.pathname !== pathFor())
    history.pushState(null, '', pathFor());
}

async function applyPath() {
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts[0] === 'story' && base() === 2) {
    pos = 1; ev = null; render(); return;
  }
  if (parts[0] === 'end') { pos = endPos(); ev = null; render(); return; }
  const ci = parts.length ? walk.findIndex(c => c.id === parts[0]) : -1;
  if (ci < 0) { pos = 0; ev = null; render(); return; }
  pos = ci + base();
  const ei = parts[1] ? parseInt(parts[1], 10) - 1 : -1;
  if (ei >= 0 && ei < walk[ci].evidence.length) {
    const r = await fetch(
      `/api/resolve?claim=${encodeURIComponent(walk[ci].id)}&idx=${ei}`);
    const data = await r.json();
    if (!data.error) { ev = { ci, ei, data }; render(); return; }
  }
  ev = null;
  render();
}

function render() {
  if (ev) renderEvidence();
  else if (pos === 0) renderTitle();
  else if (pos < base()) renderStory();
  else if (pos >= endPos()) renderEnd();
  else renderClaim();
}

// the cover's job: say what the change IS (story.summary) + the gate bar.
// The why lives on its own story slide — never here (the wall-of-text bug).
function renderTitle() {
  const pct = A.coverage.total
    ? Math.round(100 * A.coverage.claimed / A.coverage.total) : 0;
  $slide.className = 'card title-slide';
  $slide.innerHTML = `
    <div class="kicker"><span>${esc(A.mode)} · ${esc(A.repo)}</span>
      <span>1 / ${endPos() + 1}</span></div>
    <div class="body">
      <h1>${esc(A.title)}</h1>
      <div class="meta">${esc(A.ref || (A.omega || '').slice(0, 10))}</div>
      <div class="covbar"><i style="width:${pct}%"></i></div>
      <div class="meta">${A.coverage.claimed}/${A.coverage.total}
        ${esc(A.coverage.unit)}${A.coverage.stale.length
          ? ` · ${A.coverage.stale.length} stale` : ''}</div>
      ${A.story.summary
        ? `<div class="summary">${mdlite(A.story.summary)}</div>` : ''}
    </div>
    <div class="nav"><span class="badge">${walk.length} claims</span>
      <button onclick="next()">next &gt;</button></div>`;
}

// flow: serve deck — reader steps past the cover to the tour itinerary.
// Each leg row is the claim title plus its short why; a legacy why
// essay (old artifacts) renders above the list instead.
function renderStory() {
  $slide.className = 'card claim story-slide';
  $slide.innerHTML = `
    <div class="kicker"><span>the story · ${esc(A.repo)}</span>
      <span>2 / ${endPos() + 1}</span></div>
    <div class="body">
      <h2>${esc(A.story.title || 'How to read this deck')}</h2>
      ${A.story.why ? `<div class="claimbody">${mdlite(A.story.why)}</div>` : ''}
      <div class="sec">the walk</div>
      <ol class="walklist">${walk.map((c, i) => `
        <li onclick="gotoClaim(${i})">
          <span class="wid">${esc(c.id)}</span>${esc(c.title || c.id)}
          ${whys[i] ? `<div class="lwhy">${esc(whys[i])}</div>` : ''}
        </li>`).join('')}</ol>
    </div>
    <div class="nav"><button onclick="prev()">&lt;</button>
      <button onclick="next()">&gt;</button></div>`;
}

function gotoClaim(i) {
  pos = i + base();
  render();
  syncPath();
}

// flow: serve deck — reader stamps (or steps past) the last claim and
// lands on the record: verdict tally, what's still open, and the
// hand-off line for the next agent
function renderEnd() {
  const groups = { verified: [], refuted: [], trusted: [], unverified: [] };
  walk.forEach(c => (groups[c.verdict] || groups.unverified).push(c));
  const nc = walk.reduce((n, c) => n + c.comments.length, 0);
  const noq = walk.reduce((n, c) => n + c.open_questions.length, 0);
  const row = (c) => `
    <li onclick="gotoClaim(${walk.indexOf(c)})">
      <span class="wid">${esc(c.id)}</span>${esc(c.title || c.id)}</li>`;
  $slide.className = 'card claim end-slide';
  $slide.innerHTML = `
    <div class="kicker"><span>the record · ${esc(A.repo)}</span>
      <span>${endPos() + 1} / ${endPos() + 1}</span></div>
    <div class="body">
      <h2>End of the walk</h2>
      <div class="tally">
        ${['verified', 'refuted', 'trusted', 'unverified'].map(v =>
          groups[v].length
            ? `<span class="pill v-${v}">${groups[v].length} ${v}</span>`
            : '').join('')}
      </div>
      <div class="meta">${nc} comment${nc === 1 ? '' : 's'} ·
        ${noq} open question${noq === 1 ? '' : 's'} ·
        ${A.coverage.claimed}/${A.coverage.total} ${esc(A.coverage.unit)}</div>
      ${groups.refuted.length ? `<div class="sec">refuted</div>
        <ol class="walklist">${groups.refuted.map(row).join('')}</ol>` : ''}
      ${groups.unverified.length ? `<div class="sec">not yet stamped</div>
        <ol class="walklist">${groups.unverified.map(row).join('')}</ol>` : ''}
      <div class="note">Everything you stamped and wrote is already in
        the yaml. Hand it to any agent: "read the gocr review and
        address my comments, refuted claims, and open questions."</div>
    </div>
    <div class="nav"><button onclick="prev()">&lt;</button>
      <button onclick="pos=0;render();syncPath()">cover</button></div>`;
}

function renderClaim() {
  const c = walk[pos - base()];
  $slide.className = 'card claim';
  $slide.innerHTML = `
    <div class="kicker">
      <span>claim ${pos - base() + 1} / ${walk.length} · ${esc(c.id)}</span>
      <span class="pill v-${esc(c.verdict)}">${esc(c.verdict)}</span></div>
    <div class="body">
      <h2>${esc(c.title || c.id)}</h2>
      <div class="tags">${c.tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>
      <div class="claimbody">${mdlite(c.text)}</div>
      ${c.note ? `<div class="note">${mdlite(c.note)}</div>` : ''}
      ${c.comments.map((x, xi) => !x.at
        ? `<div class="cmt">${esc(x.text)}<span class="del"
             title="delete comment" onclick="delComment(${xi})">×</span></div>`
        : '').join('')}
      <div class="cmt-row">
        <input class="cmt-in" placeholder="add a comment…"
          onkeydown="if(event.key==='Enter'&&this.value.trim())
            claimComment(this.value.trim())">
        <button class="cmt-go" onclick="const i=this.previousElementSibling;
          if(i.value.trim()) claimComment(i.value.trim())">post</button>
      </div>
      ${c.open_questions.length ? `<div class="sec">open questions</div>` : ''}
      ${c.open_questions.map(q => `<div class="oq">${esc(q)}</div>`).join('')}
      <div class="sec">evidence</div>
      ${c.evidence.map((e, i) => {
        const data = resCache[c.id + ':' + i];
        return `
        <div class="ev" onclick="openEvidence(${i})" title="open focus view">
          ${e.kind === 'at' ? `at: ${esc(e.raw)}`
            : `grep: ${pipelineChips(e.pipeline)} in: ${esc(e.in)}`}
          ${e.note ? `<div class="n">${esc(e.note)}</div>` : ''}
        </div>
        <div class="ev-pane" data-ei="${i}">${!data
          ? '<div class="resolving">resolving…</div>'
          : data.error
            ? `<div class="resolving">${esc(data.error)}</div>`
            : evBody(c, data)}</div>`;
      }).join('')}
      <div class="sec">verdict</div>
      <div class="verdicts">${['verified', 'refuted', 'trusted'].map(v => `
        <button class="v-${v} ${c.verdict === v ? 'on' : ''}"
          onclick="setVerdict('${v}')">${
          {verified: '✓ verified', refuted: '✕ refuted', trusted: '~ trusted'}[v]
        }</button>`).join('')}</div>
    </div>
    <div class="nav">
      <button onclick="prev()">&lt;</button>
      <button onclick="next()">&gt;</button></div>`;
  hydrateClaim(c);
}

// The problem is evidence must be visible on the claim slide itself,
// but resolution is a live call per recipe.
// The way we solve this is rendering the slide at once with "resolving…"
// panes, then filling each pane in place as its resolution arrives —
// cached, so stepping back to a claim is instant.
// flow: renderClaim() -> hydrateClaim() <-- HERE
async function hydrateClaim(c) {
  for (let i = 0; i < c.evidence.length; i++) {
    const key = c.id + ':' + i;
    if (!resCache[key]) {
      const r = await fetch(
        `/api/resolve?claim=${encodeURIComponent(c.id)}&idx=${i}`);
      resCache[key] = await r.json();
    }
    if (ev || walk[pos - base()] !== c) return;  // reader moved on
    const pane = document.querySelector(`.ev-pane[data-ei="${i}"]`);
    if (pane) pane.innerHTML = resCache[key].error
      ? `<div class="resolving">${esc(resCache[key].error)}</div>`
      : evBody(c, resCache[key]);
  }
}

// the resolved code for one evidence item — shared by the claim slide's
// inline panes and the focus slide, so both carry the same line
// comments, IDE links and drift badge
function evBody(c, data) {
  if (data.kind === 'at') {
    return `
      ${data.drift !== null && data.drift !== undefined
        ? `<div class="badge ${data.drift ? 'drift' : ''}">
            ${data.drift ? '≠ working tree has drifted'
                         : '= matches working tree'}</div>` : ''}
      <div class="lines">${data.lines.map(([n, t], i) => {
        const isDelta = data.src === 'delta';
        const meta = isDelta && DIFF_META.test(t);
        const cls = meta ? 'meta'
          : t.startsWith('+') ? 'add' : t.startsWith('-') ? 'del' : '';
        const a = data.anchors[i];
        // delta lines carry their own [file, omega-line]; file lines use
        // the selection's path — either way the IDE link points somewhere real
        const ide = isDelta ? (data.ide || [])[i]
          : (data.path ? [data.path, n] : null);
        const lang = LANG_OF(ide ? ide[0] : data.path);
        const tx = meta ? esc(t)
          : isDelta ? esc(t[0] || '') + hlLine(t.slice(1), lang)
          : hlLine(t, lang);
        return `<div class="ln ${cls}">
          <span class="plus" title="comment on this line"
            onclick="toggleCmt('${a}')">+</span>
          <span class="no">${n}</span>
          <span class="tx">${tx || ' '}</span>
          ${ide && ide[1] ? `<span class="go" title="open in IDE"
            onclick="openIDE('${esc(ide[0])}', ${ide[1]})">→</span>` : ''}
        </div>${cmtBoxFor(a)}${cmtFor(c, a)}`;
      }).join('')}</div>`;
  }
  return data.count === 0
    ? `<div class="zero">0 lines selected — the absence, proven live.</div>`
    : `<div class="lines">${data.hits.map(h => {
        const ide = h.anchor &&
          h.anchor.match(/^(alpha|omega):(.+):(\d+)-\d+$/);
        return `<div class="hit">
          ${h.anchor ? `<span class="plus" title="comment"
            onclick="toggleCmt('${h.anchor}')">+</span>` : ''}
          ${esc(h.text)}
          ${ide ? `<span class="go" title="open in IDE"
            onclick="openIDE('${esc(ide[2])}', ${ide[3]})">→</span>` : ''}
        </div>${h.anchor ? cmtBoxFor(h.anchor) + cmtFor(c, h.anchor) : ''}`;
      }).join('')}</div>`;
}

function renderEvidence() {
  const c = walk[ev.ci];
  const e = c.evidence[ev.ei];
  const data = ev.data;
  const body = evBody(c, data);
  const recipe = e.kind === 'at' ? `at: ${esc(e.raw)}`
    : `grep: ${pipelineChips(e.pipeline)} in: ${esc(e.in)}`;
  currentCmd = shellCmd(e, data);
  $slide.className = 'card';
  $slide.innerHTML = `
    <div class="kicker"><span>evidence · ${esc(c.id)} ·
      ${ev.ei + 1} / ${c.evidence.length}</span>
      <span>${data.kind === 'grep' ? data.count + ' line(s)'
        : data.path
          ? `<span class="ide" title="open in IDE at line ${data.start}"
               onclick="openIDE('${esc(data.path)}', ${data.start})">
               ${esc(data.path)} ↗</span>`
          : 'delta'}</span></div>
    <div class="recipe">${recipe}
      <span class="copy" title="copy shell command that reproduces this"
        onclick="copyCmd(this)">⧉</span></div>
    ${e.note ? `<div class="note">${esc(e.note)}</div>` : ''}
    <div class="body">${body}</div>
    <div class="nav"><button onclick="closeEvidence()">&lt; back</button>
      <span>
      <button onclick="stepEvidence(-1)" ${ev.ei === 0 ? 'disabled' : ''}>
        &lt;</button>
      <button onclick="stepEvidence(1)"
        ${ev.ei >= c.evidence.length - 1 ? 'disabled' : ''}>&gt;</button>
      </span></div>`;
}

function cmtFor(claim, anchor) {
  return claim.comments.map((x, xi) => x.at === anchor
    ? `<div class="cmt"><span class="a">${esc(anchor)}</span> ${esc(x.text)}
        <span class="del" title="delete comment"
          onclick="delComment(${xi})">×</span></div>`
    : '').join('');
}

async function delComment(xi) {
  const c = walk[ev ? ev.ci : pos - base()];
  const cm = c.comments[xi];
  const r = await (await fetch('/api/uncomment', { method: 'POST',
    body: JSON.stringify({ claim: c.id, text: cm.text, at: cm.at }) })).json();
  if (r.error) { alert(r.error); return; }
  c.comments.splice(xi, 1);
  render();
}

function next() { if (ev) return;
  pos = Math.min(pos + 1, endPos()); render(); syncPath(); }
function prev() { if (ev) { closeEvidence(); return; }
  if (pos > 0) pos--; render(); syncPath(); }
function closeEvidence() { ev = null; render(); syncPath(); }

async function openEvidence(i) {
  const c = walk[pos - base()];
  const r = await fetch(
    `/api/resolve?claim=${encodeURIComponent(c.id)}&idx=${i}`);
  const data = await r.json();
  if (data.error) { alert(data.error); return; }
  resCache[c.id + ':' + i] = data;
  ev = { ci: pos - base(), ei: i, data };
  render();
  syncPath();
}

async function stepEvidence(d) {
  const c = walk[ev.ci];
  const i = ev.ei + d;
  if (i < 0 || i >= c.evidence.length) return;
  const r = await fetch(
    `/api/resolve?claim=${encodeURIComponent(c.id)}&idx=${i}`);
  const data = await r.json();
  if (data.error) { alert(data.error); return; }
  resCache[c.id + ':' + i] = data;
  ev = { ci: ev.ci, ei: i, data };
  render();
  syncPath();
}

// stamping a verdict advances to the next claim — the stamp is the
// "done with this slide" gesture; un-stamping stays put
async function setVerdict(v) {
  const c = walk[pos - base()];
  const val = c.verdict === v ? 'unverified' : v;
  await fetch('/api/verdict', { method: 'POST',
    body: JSON.stringify({ claim: c.id, verdict: val }) });
  c.verdict = val;
  if (val !== 'unverified') next();  // last claim's stamp lands on the record
  else render();
}

async function claimComment(text) {
  const c = walk[pos - base()];
  await fetch('/api/comment', { method: 'POST',
    body: JSON.stringify({ claim: c.id, text }) });
  c.comments.push({ at: null, text });
  render();
}

// The problem is evidence recipes are declarative - a reader who wants
// to re-run one shouldn't have to reverse-engineer the tool's rendering.
// The way we solve this is building the equivalent shell command (git
// show / git grep / git diff piped through grep -E) for the evidence on
// screen, behind a copy icon.
let currentCmd = '';
function shellCmd(e, data) {
  const q = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
  if (e.kind === 'at') {
    const m = e.raw.match(/^(alpha|omega|delta):(?:(.+):)?(\d+)-(\d+)$/);
    if (!m) return '';
    const [, src, path, a, b] = m;
    if (src === 'delta')
      return `git diff ${A.alpha} ${A.omega} | sed -n '${a},${b}p'`;
    return `git show ${q(A[src] + ':' + path)} | sed -n '${a},${b}p'`;
  }
  let cmd = e.in === 'delta'
    ? `git diff ${A.alpha} ${A.omega} | awk '/^diff --git/{p=substr($4,3)}` +
      ` /^[+-]/ && !/^\\+\\+\\+/ && !/^---/ {print p":"$0}'`
    : `git grep -nI -e "" ${A[e.in]} | sed 's/^[^:]*://'`;
  for (const p of e.pipeline) {
    const neg = p.startsWith('!');
    const pat = neg ? p.slice(1) : p;
    if (pat === '*' || pat === '') continue;
    cmd += ` | grep ${neg ? '-vE' : '-E'} ${q(pat)}`;
  }
  return cmd;
}

async function copyCmd(el) {
  await navigator.clipboard.writeText(currentCmd);
  el.textContent = '✓';
  setTimeout(() => { el.textContent = '⧉'; }, 900);
}

let cmtBox = null;   // anchor whose inline comment box is open

function cmtBoxFor(anchor) {
  if (cmtBox !== anchor) return '';
  return `<div class="cmt-box"><input placeholder="comment…"
    onkeydown="if(event.key==='Enter'&&this.value.trim())
      submitLineComment('${anchor}', this.value.trim());
      if(event.key==='Escape') toggleCmt(null)">
    <button class="cmt-go" onclick="const i=this.previousElementSibling;
      if(i.value.trim()) submitLineComment('${anchor}', i.value.trim())">
      post</button></div>`;
}

function toggleCmt(anchor) {
  cmtBox = cmtBox === anchor ? null : anchor;
  render();
  const box = document.querySelector('.cmt-box input');
  if (box) box.focus();
}

async function submitLineComment(anchor, text) {
  const c = walk[ev ? ev.ci : pos - base()];
  await fetch('/api/comment', { method: 'POST',
    body: JSON.stringify({ claim: c.id, text, at: anchor }) });
  c.comments.push({ at: anchor, text });
  cmtBox = null;
  render();
}

async function openIDE(path, line) {
  if (!path) return;
  const r = await (await fetch('/api/open', { method: 'POST',
    body: JSON.stringify({ path, line }) })).json();
  if (r.error) alert(r.error);
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowRight') { if (ev) stepEvidence(1); else next(); }
  if (e.key === 'ArrowLeft') { if (ev) stepEvidence(-1); else prev(); }
  if (e.key === 'Escape') closeEvidence();
});

load();
