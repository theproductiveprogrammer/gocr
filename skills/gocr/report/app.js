
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

// Understand: strings and comments can open on an earlier line (python
// docstrings, /* */ blocks), so the tokenizer carries {str, cmt} state
// from line to line; the resolver seeds it for file selections by
// scanning the lines above the range. Returns {html, state}.
function hlLine(t, lang, state) {
  const kw = KW[lang] || KW.clike;
  const st = { str: state ? state.str : null, cmt: state ? state.cmt : false };
  let out = '', i = 0;
  const push = (cls, s) => { if (s) out += cls
    ? `<span class="${cls}">${esc(s)}</span>` : esc(s); };
  // block-comment continuation ("* javadoc body") when we have no seed
  if (!state && lang === 'clike' && /^\s*\*/.test(t))
    return { html: `<span class="tok-c">${esc(t)}</span>`, state: st };
  while (i < t.length) {
    if (st.str) {                              // inside a multi-line string
      const j = t.indexOf(st.str, i);
      if (j < 0) { push('tok-s', t.slice(i)); break; }
      push('tok-s', t.slice(i, j + st.str.length));
      i = j + st.str.length; st.str = null; continue;
    }
    if (st.cmt) {                              // inside a block comment
      const j = t.indexOf('*/', i);
      if (j < 0) { push('tok-c', t.slice(i)); break; }
      push('tok-c', t.slice(i, j + 2)); i = j + 2; st.cmt = false; continue;
    }
    const ch = t[i], rest = t.slice(i);
    if ((ch === '/' && t[i + 1] === '/' && lang === 'clike') ||
        (ch === '#' && (lang === 'py' || lang === 'sh')) ||
        (ch === '-' && t[i + 1] === '-' && lang === 'sql')) {
      push('tok-c', rest); break;
    }
    if (ch === '/' && t[i + 1] === '*' && lang !== 'py' && lang !== 'sh') {
      const e = t.indexOf('*/', i + 2);
      if (e < 0) { push('tok-c', rest); st.cmt = true; break; }
      push('tok-c', t.slice(i, e + 2)); i = e + 2; continue;
    }
    if (lang === 'py' && (rest.startsWith('"""') || rest.startsWith("'''"))) {
      const d = rest.slice(0, 3);
      const e = t.indexOf(d, i + 3);
      if (e < 0) { push('tok-s', rest); st.str = d; break; }
      push('tok-s', t.slice(i, e + 3)); i = e + 3; continue;
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
  return { html: out, state: st };
}

const DIFF_META = /^(diff |index |--- |\+\+\+ |@@|\\ No newline)/;

// The problem is delta evidence names diff line numbers, so the reader
// can't tell which file they are looking at without scrolling for a
// diff header.
// The way we solve this is reading the files back out of the resolved
// data - the per-row IDE info for ranges, the row path prefix for
// greps - and labeling the recipe with them.
// flow: renderClaim/renderEvidence -> evFiles() <-- HERE
function evFiles(data) {
  let files = [];
  if (data.kind === 'at' && data.src === 'delta')
    files = (data.ide || []).filter(Boolean).map(r => r[0]);
  else if (data.kind === 'grep' && data.in === 'delta')
    files = (data.hits || []).map(r => r.text.split(':', 1)[0]);
  else return '';
  const uniq = [...new Set(files)];
  if (!uniq.length) return '';
  const label = uniq.slice(0, 2).join(' · ')
    + (uniq.length > 2 ? ` +${uniq.length - 2} more` : '');
  return `<span class="evfiles">${esc(label)}</span>`;
}

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
  // a deck server started before question triage existed still sends
  // questions as bare strings - lift them so the slide never goes blank
  for (const c of A.claims)
    c.open_questions = c.open_questions.map(q =>
      typeof q === 'string' ? { text: q, status: '' } : q);
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

// The problem is every state change rebuilds the whole slide, so posting
// a comment or marking a question threw the reader back to the top and
// dropped the input they were typing in.
// The way we solve this is remembering the body's scroll and the focused
// input (by its position among inputs, plus its draft and caret) around
// the rebuild, and putting both back when the slide is the same one.
// flow: every state change -> render() <-- HERE
function render() {
  const key = ev ? `ev:${ev.ci}:${ev.ei}` : `pos:${pos}`;
  const body = $slide.querySelector('.body');
  const snap = $slide.dataset.key === key && body ? {
    top: body.scrollTop,
    panes: [...$slide.querySelectorAll('.ev-pane')].map(p => p.scrollTop),
    focus: (() => {
      const a = document.activeElement;
      if (!a || a.tagName !== 'INPUT') return null;
      const ins = [...$slide.querySelectorAll('input')];
      return { i: ins.indexOf(a), n: ins.length, v: a.value,
               s: a.selectionStart, e: a.selectionEnd };
    })(),
  } : null;
  if (ev) renderEvidence();
  else if (pos === 0) renderTitle();
  else if (pos < base()) renderStory();
  else if (pos >= endPos()) renderEnd();
  else renderClaim();
  $slide.dataset.key = key;
  if (!snap) return;
  const nb = $slide.querySelector('.body');
  if (nb) nb.scrollTop = snap.top;
  $slide.querySelectorAll('.ev-pane').forEach((p, i) => {
    if (snap.panes[i] != null) p.scrollTop = snap.panes[i]; });
  // Understand: only put the draft back when the slide still has the
  // same inputs - after a comment box closes, the index would land on a
  // different field and paste the draft there.
  const ins = $slide.querySelectorAll('input');
  if (snap.focus && snap.focus.i >= 0 && ins.length === snap.focus.n) {
    const el = ins[snap.focus.i];
    if (el) { el.value = snap.focus.v; el.focus();
      el.setSelectionRange(snap.focus.s, snap.focus.e); }
  }
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
          ? ` · ${A.coverage.stale.length} stale` : ''}${A.tests_dropped
          ? ' · test files skipped' : ''}</div>
      ${(A.members || []).map(m => {
        const p = m.coverage.total
          ? Math.round(100 * m.coverage.claimed / m.coverage.total) : 0;
        return `
        <div class="member">
          <span class="mname">${esc(m.name)}</span>
          <span class="mref">${esc(m.ref)}</span>
          <span class="mbar"><i style="width:${p}%"></i></span>
          <span class="mcov">${m.coverage.claimed}/${m.coverage.total}</span>
        </div>`;
      }).join('')}
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

// flow: serve deck — reader steps past the last claim and lands on the
// record: what they wrote, what they marked, and the hand-off line for
// the next agent. Only claims carrying work are listed.
function renderEnd() {
  const nc = walk.reduce((n, c) => n + c.comments.length, 0);
  const noq = walk.reduce((n, c) =>
    n + c.open_questions.filter(q => q.status !== 'ignore').length, 0);
  const nact = walk.reduce((n, c) =>
    n + c.open_questions.filter(q => q.status === 'act').length, 0);
  const work = walk.filter(c => c.comments.length
    || c.open_questions.some(q => q.status === 'act'));
  const row = (c) => {
    const k = c.open_questions.filter(q => q.status === 'act').length;
    return `
    <li onclick="gotoClaim(${walk.indexOf(c)})">
      <span class="wid">${esc(c.id)}</span>${esc(c.title || c.id)}
      <div class="lwhy">${[
        c.comments.length ? `${c.comments.length} comment${
          c.comments.length === 1 ? '' : 's'}` : '',
        k ? `${k} to act on` : ''].filter(Boolean).join(' · ')}</div></li>`;
  };
  $slide.className = 'card claim end-slide';
  $slide.innerHTML = `
    <div class="kicker"><span>the record · ${esc(A.repo)}</span>
      <span>${endPos() + 1} / ${endPos() + 1}</span></div>
    <div class="body">
      <h2>End of the walk</h2>
      <div class="tally">
        ${nc ? `<span class="pill">${nc} comment${nc === 1 ? '' : 's'}</span>` : ''}
        ${nact ? `<span class="pill">${nact} to act on</span>` : ''}
        ${!nc && !nact ? `<span class="pill">nothing marked</span>` : ''}
      </div>
      <div class="meta">${noq} open question${noq === 1 ? '' : 's'} ·
        ${A.coverage.claimed}/${A.coverage.total} ${esc(A.coverage.unit)}</div>
      ${work.length ? `<div class="sec">for the next agent</div>
        <ol class="walklist">${work.map(row).join('')}</ol>` : ''}
      <div class="note">Everything you wrote and marked is already in
        the yaml. Hand it to any agent: "read the gocr review and
        address my comments and the questions marked act."</div>
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
      <span></span></div>
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
      ${c.open_questions.map((q, qi) => `
        <div class="oq ${q.status ? 'oq-' + q.status : ''}">
          <div class="oq-t">${mdlite(q.text)}</div>
          <div class="oq-acts">
            <button class="q-act ${q.status === 'act' ? 'on' : ''}"
              onclick="setQuestion(${qi}, 'act')">✓ act</button>
            <button class="q-ignore ${q.status === 'ignore' ? 'on' : ''}"
              onclick="setQuestion(${qi}, 'ignore')">✕ ignore</button>
          </div>
        </div>`).join('')}
      <div class="sec">evidence</div>
      ${c.evidence.map((e, i) => {
        const data = resCache[c.id + ':' + i];
        return `
        <div class="ev" onclick="openEvidence(${i})" title="open focus view">
          ${e.kind === 'at' ? `at: ${esc(e.raw)}`
            : `grep: ${pipelineChips(e.pipeline)} in: ${esc(e.in)}`}
          ${data ? evFiles(data) : `<span class="evfiles" data-fi="${i}"></span>`}
          ${e.note ? `<div class="n">${esc(e.note)}</div>` : ''}
        </div>
        <div class="ev-pane" data-ei="${i}">${!data
          ? '<div class="resolving">resolving…</div>'
          : data.error
            ? `<div class="resolving">${esc(data.error)}</div>`
            : evBody(c, data)}</div>`;
      }).join('')}
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
    const fi = document.querySelector(`.evfiles[data-fi="${i}"]`);
    if (fi && !resCache[key].error) fi.outerHTML = evFiles(resCache[key]);
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
      <div class="lines">${(() => {
        const isDelta = data.src === 'delta';
        // highlight state carried line to line; seeded by the resolver for
        // file selections (it scanned the lines above), reset per file in a diff
        let st = data.hl_state || null, lastPath = null;
        return data.lines.map(([n, t], i) => {
        const meta = isDelta && DIFF_META.test(t);
        const cls = !isDelta ? '' : meta ? 'meta'
          : t.startsWith('+') ? 'add' : t.startsWith('-') ? 'del' : '';
        const a = data.anchors[i];
        // delta lines carry their own [file, omega-line]; file lines use
        // the selection's path — either way the IDE link points somewhere real
        const ide = isDelta ? (data.ide || [])[i]
          : (data.path ? [data.path, n] : null);
        const path = ide ? ide[0] : data.path;
        if (isDelta && path !== lastPath) { st = null; lastPath = path; }
        const lang = LANG_OF(path);
        let tx;
        if (meta) tx = esc(t);
        else {
          const r = hlLine(isDelta ? t.slice(1) : t, lang, st);
          st = r.state;
          tx = (isDelta ? esc(t[0] || '') : '') + r.html;
        }
        return `<div class="ln ${cls}">
          <span class="plus" title="comment on this line"
            onclick="toggleCmt('${a}')">+</span>
          <span class="no">${n}</span>
          <span class="tx">${tx || ' '}</span>
          ${ide && ide[1] ? `<span class="go" title="open in IDE"
            onclick="openIDE('${esc(ide[0])}', ${ide[1]})">→</span>` : ''}
        </div>${cmtBoxFor(a)}${cmtFor(c, a)}`;
        }).join('');
      })()}</div>`;
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
  const recipe = (e.kind === 'at' ? `at: ${esc(e.raw)}`
    : `grep: ${pipelineChips(e.pipeline)} in: ${esc(e.in)}`)
    + evFiles(data);
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

// The problem is the conductor's doubts need a quick human triage on
// the slide: this one matters, that one doesn't - so the next agent
// knows which to work on.
// The way we solve this is a tri-state per question (blank / act /
// ignore) written straight to the yaml; clicking the lit state clears it.
// flow: claim slide question buttons -> setQuestion() <-- HERE
async function setQuestion(qi, status) {
  const c = walk[pos - base()];
  const q = c.open_questions[qi];
  const val = q.status === status ? '' : status;
  const r = await (await fetch('/api/question', { method: 'POST',
    body: JSON.stringify({ claim: c.id, idx: qi, status: val }) })).json();
  if (r.error) { alert(r.error); return; }
  q.status = val;
  render();
}

async function claimComment(text) {
  const c = walk[pos - base()];
  await fetch('/api/comment', { method: 'POST',
    body: JSON.stringify({ claim: c.id, text }) });
  c.comments.push({ at: null, text });
  const a = document.activeElement;
  if (a && a.classList.contains('cmt-in')) a.value = '';  // posted: clear
  render();
}

// The problem is evidence recipes are declarative - a reader who wants
// to re-run one shouldn't have to reverse-engineer the tool's rendering.
// The way we solve this is building the equivalent shell command (git
// show / git grep / git diff piped through grep -E) for the evidence on
// screen, behind a copy icon.
function repoCtx() {
  const c = walk[ev ? ev.ci : pos - base()];
  return { alpha: (c && c.alpha) || A.alpha,
           omega: (c && c.omega) || A.omega,
           root: (c && c.root) || null,
           tests: c && 'tests_dropped' in c ? c.tests_dropped : A.tests_dropped };
}

// The problem is delta line numbers count a diff with test files already
// dropped, so a bare `git diff` would put every anchor off by the size
// of the tests above it.
// The way we solve this is piping git diff through the same path regex
// the tool used, so the copied command reproduces the numbered delta.
// flow: claim slide — reader clicks the copy icon on delta evidence -> shellCmd -> deltaCmd() <-- HERE
function deltaCmd(git, r) {
  const diff = `${git} diff ${r.alpha} ${r.omega}`;
  if (!r.tests) return diff;
  const re = r.tests.replace(/\//g, '\\/');
  return `${diff} | awk '/^diff --git/{s=(substr($4,3) ~ /${re}/)} !s'`;
}

let currentCmd = '';
function shellCmd(e, data) {
  const q = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
  const r = repoCtx();
  const git = r.root ? `git -C ${q(r.root)}` : 'git';
  if (e.kind === 'at') {
    const m = e.raw.match(/^(alpha|omega|delta):(?:(.+):)?(\d+)-(\d+)$/);
    if (!m) return '';
    const [, src, path, a, b] = m;
    if (src === 'delta')
      return `${deltaCmd(git, r)} | sed -n '${a},${b}p'`;
    return `${git} show ${q(r[src] + ':' + path)} | sed -n '${a},${b}p'`;
  }
  let cmd = e.in === 'delta'
    ? `${deltaCmd(git, r)} | awk '/^diff --git/{p=substr($4,3)}` +
      ` /^[+-]/ && !/^\\+\\+\\+/ && !/^---/ {print p":"$0}'`
    : `${git} grep -nI -e "" ${r[e.in]} | sed 's/^[^:]*://'`;
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
    body: JSON.stringify({ path, line, root: repoCtx().root }) })).json();
  if (r.error) alert(r.error);
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowRight') { if (ev) stepEvidence(1); else next(); }
  if (e.key === 'ArrowLeft') { if (ev) stepEvidence(-1); else prev(); }
  if (e.key === 'Escape') closeEvidence();
});

load();
