---
name: gocr
description: Graph-Oriented Code Review — claim-based artifacts (review.yaml + a served interactive story-deck report) in two modes. change mode reviews a commit/branch/PR (evidence as source:selection recipes over pinned alpha/omega shas and their derived delta; gate = every changed line claimed). explore mode maps a codebase territory at one pinned sha (gate = every scope file cited). Use when the user says "gocr", "gocr this commit/branch/PR", "gocr explore <area>", "gocr serve", "generate a claim review", "graph review", "map this subsystem with gocr", or wants a large AI-generated change reviewed by claims instead of by reading the raw diff.
---

# GOCR v2 — claim-based review of one change

One artifact structure, two obligation modes:

- **`change:`** — a transition between two pinned universes: **alpha**
  (sha before) → **delta** (the diff, derived live from the shas) →
  **omega** (sha after). Gate: every changed line claimed.
- **`explore:`** — one pinned universe (**omega**) plus a declared
  **scope** (a path filter pipeline): a map of a territory. Gate: every
  scope file cited by at least one claim. Breadth proof, not depth.

Either way the artifact is **claims whose evidence selects from the
pinned sources**, one suggested reading walk, and the machine-checked
coverage guarantee. The reader reads claims about omega — what the
system is; the gate reads the obligation — what must not go unexamined.
The artifact stores **recipes, never results**: even the delta is
derived (`git diff alpha omega`), and resolution is live, so nothing in
it can go quietly stale. Re-running an artifact's recipes at a later
sha tells you whether its claims still hold.

Tool: `python3 <skill-base-dir>/gocr.py` — the base directory is shown
in the "Base directory for this skill" line when this skill loads;
use that absolute path wherever commands below say gocr.py.
- `coverage review.yaml` — the gate (self-describing via the yaml)
- `resolve review.yaml <selection | claim-id>` — show what evidence names
- `stats review.yaml` — per-claim mechanical signals
- `files <diff-path-or-url>` — per-file shape of a diff
- `serve review.yaml [port]` — **the report**: a local story-deck UI
Run from the repo root — alpha/omega resolution shells out to git at the
pinned shas.

The work is split across **roles** — distinct hats with different
incentives, so no single author curates the whole artifact:
**Claimant** (asserts) → **Detective** (anchors & gates) → **Quant**
(deterministic script, never a model) → **Report Maker** (renders) →
**Reviewer** (adjudicates; human, optionally pre-screened by skeptics).

## Hard rules (each one exists because its absence was a designed failure)

1. **GOCR reviews; it never fixes.** The run's only outputs are
   `review.yaml` and the served report URL — no agent in the run edits
   the reviewed code, and no "issues found" list lands in chat. Anything
   an agent suspects is wrong goes *into the artifact* for the human to
   judge: an `open_questions` entry on the claim it shadows, or — when
   it stands alone — its own claim tagged `finding`, anchored like any
   other. Fixing is a separate request the human makes *after* walking
   the deck (see "Acting on a review"); reverting to a generic
   find-issues-then-fix review is the second central GOCR failure mode.
2. **The code's author never authors the claims.** Always spawn a fresh
   subagent (Agent tool, general-purpose) to draft `review.yaml` from the
   diff — even (especially) when the current session wrote the code. A
   graph curated by the party under review is the central GOCR failure
   mode.
3. **The gate must exit 0 before you render.** `gocr.py coverage
   review.yaml` at changed-line granularity: no unclaimed lines, no
   stale or empty selections. Loop the drafting agent until clean.
4. **No numeric scores.** No percentages, no importance numbers, no
   estimated minutes. Ordering is ordinal and every ordering reason must
   be mechanical and checkable ("wired into 4 files", "shares
   _BAROMETER_SPEC with C1") — never vibes.
5. **Verdicts belong to the human.** Every claim ships
   `verdict: unverified`. Never mark verified/refuted/trusted yourself;
   the generator records `open_questions` instead.
6. **Everything is pinned to shas.** `alpha`/`omega` are exact shas in
   the header; the delta derives from them, so no diff file ships by
   default. Pinning is what makes plain line ranges stable and every
   recipe re-runnable forever. (`delta: <file>` exists only for
   repo-less review of a fetched `.diff`; `source:` records provenance
   in either mode.)
7. **Absence claims are grep recipes, not prose.** "X is gone/retired/
   never called" gets `grep: X` / `in: omega` (and usually the paired
   `in: alpha` showing it existed before) — resolution produces the
   0-matches proof live. Never a quoted result string; the artifact
   stores no results.
8. **Selections stay declarative.** Ranges and grep filter-pipelines are
   the whole evidence language — no shell, no arbitrary commands. The
   Detective may run anything while *investigating*; what it records is
   the declarative selection it landed on. Evidence is the finding, not
   the search history.

## Writing rules (all reader-facing prose)

These apply to every word the human reads: claim `text`, `note`,
`open_questions`, and above all `story.why`. Agents drafting or editing
an artifact follow them; violating prose gets rewritten, not shipped.

- **4th-grade reading level.** Short sentences. One idea per sentence.
  Plain words wherever a plain word exists.
- **Title + body.** Every claim has a `title` (a few words, the
  assertion as a headline — this is what renders large) and a markdown
  `text` body (literal block `|`): short paragraphs, lists for
  enumerations, `code` for identifiers. Never make a paragraph do a
  headline's job.
- **A story is a story.** It should be easy and enjoyable to read — a
  guided tour, not a compressed dependency dump. Tell the reader what
  they will see at each stop and why the next stop follows naturally.
  There is no length limit; the enemy is density, not word count. Write
  it the way Enid Blyton writes an adventure: short paragraphs, one leg
  of the journey per paragraph, and it reads aloud without stumbling.
  One wall-of-text paragraph justifying every stop at once is the
  failure this rule exists to prevent.
- **Simplify the sentences, never the claims.** Every fact, number, and
  name stays — falsifiability survives. Only the packaging changes.
- **Banned:** arrow chains (`A → B → C`), more than one claim id in a
  sentence, nested or stacked parentheticals, id-soup of any kind. The
  walk list already carries the ids; the why names *subjects*, not ids.
- Rule 4 still holds — reasons stay mechanical, said plainly: "The
  server checks the clock before it checks who you are. So we read the
  clock rule first."

## Workflow

**1. Pin the obligation.** For a **change**: `alpha` = before sha,
`omega` = after sha (a SHA → `<sha>^`/`<sha>`; a range/branch →
merge-base/head; a PR → base/head shas — a stacked series is one
artifact, alpha = series base, omega = tip). The delta derives from the
shas — only pin a `delta:` file (with `source:`) when reviewing a
fetched `.diff` without the repo. For an **explore**: `omega` = the sha,
`scope:` = a path filter pipeline naming the promised territory — and
have the human eyeball the scope line, the way they'd eyeball a PR's
base branch: a lazy scope evades the gate legally. Artifacts live in
`<repo>/.gocr/<short-name>/`, untracked unless the user asks. Citing
*other* code state needs no extra machinery — that's what
`alpha:`/`omega:` selections are for.

**2. Inventory.** Change: `gocr.py files review.yaml` (or a diff path)
to see the shape — generated/vendored files (huge churn, zero review
value) are wholesale-claim candidates via one path-scoped delta grep.
Explore: `git ls-tree -r --name-only <omega> <dir>` to size the
territory before declaring scope.

**3. Claimant + Detective — fresh agent(s).** For a small change one
fresh subagent wears both hats; for a large or contested one, split them:
the **Claimant** reads the diff and asserts (claim texts, tags, story
draft) *without* anchoring; the **Detective** then anchors every claim,
hunts counter-evidence and open questions, and kills or flags any claim
it cannot anchor — unanchorable claims are the falsifiability test
failing, and they die visibly (a `refuted-in-drafting` note), never
silently. Spawn with: the diff path(s), the repo path, the run
inventory, the commit message (if any), and the review.yaml spec below.
Instruct the agent(s) to:
- Read the whole diff; group the change into 5–12 claims, each a
  falsifiable assertion about the change ("X can now Y", "Z retires",
  "invariant W holds"), tagged from: `feature`, `invariant`, `removal`,
  `rename`, `api-surface`, `drive-by`, `generated`, `cross-cutting`,
  `finding`.
- Select evidence by the grammar below: state claims cite `omega:`
  (the code as it now is — usually the best reading), transition claims
  cite `delta:` ranges, archaeology cites `alpha:`, wholesale claims
  (generated files, mechanical churn) use one path-scoped delta grep.
- Compare its claims against the commit message: anything real in the
  diff but absent from the message is a separate claim tagged
  `drive-by` — never silently folded into another claim.
- Prove absences with grep recipes (`in: omega`, paired with `in: alpha`
  for existed-before) — no quoted results, rule 7.
- Record `open_questions` per claim: behaviors the diff permits that the
  claim text doesn't promise (unguarded edge cases, silent precedence,
  asymmetries). These are the seeds of real findings — push the agent to
  find at least a few or say why there are none.
- When investigation turns up a suspected *problem* — a likely bug, a
  broken promise, a regression risk — it goes into the artifact, never
  into a fix (rule 1). A doubt that shadows an existing claim is an
  `open_questions` entry there; a problem that stands on its own becomes
  its own claim tagged `finding` ("the retry loop can drop the last
  error"), anchored like any other, so it gets its own slide and the
  human stamps the verdict.
- Write one `story`: a `summary` for the cover (two to four plain
  sentences saying what the change is and does), an ordered walk over
  claim ids, and a `why` telling the tour — one short paragraph per leg,
  each with its mechanical reason, per the writing rules.

**4. Gate.** `gocr.py coverage review.yaml`. Feed any UNCLAIMED lines
back to the Detective (SendMessage) — it must either extend an existing
claim's evidence or add a claim (often `drive-by`). Repeat until exit 0.
Never claim lines yourself to make the gate pass; that re-creates author
curation one step removed.

**5. Quant — a script, not a model.** Run `gocr.py stats review.yaml`:
per-claim delta lines claimed, alpha/omega cites, grep backing, plus the
"delta-only evidence" flag (claims that never look at either universe —
often under-verified). These are the only importance signals allowed —
every number is recomputable by anyone. No model-estimated importance,
no review-time guesses (rule 4); if a signal can't be recomputed from
the artifact, it doesn't exist.

**6. The report — Report Maker.** There is no rendered document (a
static REVIEW.md would be a cached result of rendering — the thing the
whole design forbids). The report is `gocr.py serve review.yaml`: a
local slide deck over (yaml + repo) that resolves live — one slide at a
time, PPT-style: cover (the story `summary` + coverage bar — what this
change *is*) → story slide (the `why` told in paragraphs, plus the walk
as a clickable itinerary) → one slide per claim in walk order →
evidence slides you step into (and between, `<`/`>`) and
back out of, with diff-styled resolution, per-line comments, a
working-tree drift badge on omega selections, and line numbers that
open the IDE (`GOCR_EDITOR` env, default `code -g {path}:{line}`).
Verdict buttons and comments write straight back into review.yaml —
comments are anchored by the same source:selection grammar
(`omega:path:203-203`) and are testimony, never evidence: they don't
touch coverage. The Report Maker's remaining craft is the story: walk
order and why, citing stats numbers as the mechanical reasons.

**7. Reviewer.** The human adjudicates — that never changes. If the user
asks for a **verify pass** first ("gocr verify"), spawn one skeptic
subagent per contested claim, prompted to REFUTE it from the evidence.
A skeptic that finds a problem appends an `open_questions` entry
prefixed with its lens (`"[skeptic:correctness] ..."`); one that finds
nothing writes nothing. Skeptics NEVER touch `verdict` — machine doubt
goes in open questions, judgment stays human.

**8. Hand over.** Start `serve` and give the user the URL. Final
message: the URL, where the yaml lives, claim count, the stats table's
standouts, and the open questions most worth their attention (drive-bys
and invariant gaps first). Review = walking the deck and setting each
claim's verdict; their comments land back in the yaml.

## Acting on a review (any agent, any later session)

The artifact is the handoff — it lives in the reviewed repo at
`.gocr/<name>/review.yaml`, so "read the gocr review and address it" is
the entire integration. Three signals, in priority order:

1. **`comments`** — the reviewer's work items. Each may carry an `at:`
   anchor (source:selection, pinned to the omega sha): resolve it with
   `gocr.py resolve` or `git show` to the exact lines meant. Check
   drift (pinned content vs working tree) before editing — the code may
   have moved since the review.
2. **`verdict: refuted`** — the reviewer judged that claim false.
   Either the code is wrong (fix it) or the claim was (note it); find
   out which before touching anything.
3. **`open_questions`** — doubts recorded during review; treat
   unaddressed ones as backlog candidates.

When work changes the code a claim describes, re-run
`gocr.py coverage`/`resolve` at a new omega to see which claims still
hold — the recipes are re-runnable by design.

## review.yaml spec

```yaml
gocr: 2

change:                           # ── review mode ──
  repo: <name>
  ref: <sha, range, or PR url>    # human-readable what-this-is
  alpha: <full sha>               # the universe before
  omega: <full sha>               # the universe after
  # delta: change.diff            # ONLY for repo-less review of a fetched diff
  source: <url, if any>           # provenance (both modes)
  title: <commit subject or user's words>
  authored_by: fresh-agent        # never the code author

# — or —
explore:                          # ── map mode ──
  repo: <name>
  omega: <full sha>               # the one pinned universe
  scope:                          # promised territory: path filter pipeline
    - "^backend/src/"
    - "!.*_test"
  source: <url, if any>
  title: <what this maps>
  authored_by: fresh-agent

claims:
  - id: C1
    title: Short headline, a few words   # the assertion as a headline
    text: |                              # markdown BODY, rendered as such:
      One falsifiable assertion, unpacked in short sentences.

      - use lists for enumerations (routers, files, steps)
      - use `code` for identifiers; paragraphs for flow
    note: >
      Optional, free-form, any length: why this matters, background,
      how it came to be — written for the human adjudicator. A note
      earns its place by saying what resolution can't show; prose that
      narrates what a recipe returns is a cached result and will rot.
    tags: [feature]
    verdict: unverified           # human-owned; generator never sets more
    comments:                     # written by the report UI, not generators
      - text: "claim-level reviewer comment"
      - at: omega:src/api/tools.py:203-203   # line-anchored, same grammar;
        text: "why not flush here?"          # testimony - never gates
    evidence:
      - at: delta:214-260
        note: free-form here too — what this selects and what to make of it
      - at: omega:src/api/tools.py:158-171
        note: the invariant as it now stands
      - grep: fit_barometer
        in: omega
        note: retired everywhere (resolution shows 0 — that IS the proof)
      - grep:
          - flag
          - "!flagFallen"
        in: delta
        note: every flag line except the fallback path
    open_questions:
      - >
        Something the diff permits that the claim doesn't promise.

story:
  title: <short>
  summary: |
    Two to four plain sentences: what this change is and what it does
    to the system. This is the cover of the deck — the first thing
    the reader sees, before any claim.
  walk: [C2, C1, ...]
  why: |
    The tour, told as a story on its own slide. One short paragraph
    per leg of the walk, each carrying its mechanical reason.

    Any length — but it must read aloud easily (writing rules).
```

## Evidence grammar (source:selection)

```
at: alpha:<path>:<a>-<b>     file lines in the before-universe (sha-pinned)
at: omega:<path>:<a>-<b>     file lines in the after-universe (sha-pinned)
at: delta:<a>-<b>            lines of the shipped diff file itself

grep: <pattern>              single filter, or a pipeline:
grep:
  - <pattern>                each pattern KEEPS matching lines;
  - "!<pattern>"             a leading ! DROPS matching lines
in: alpha|omega|delta        (quote !-leading patterns - yaml tags)
```

### How greps actually match (read this once — it explains everything)

A grep is NOT a glob and does NOT run against file contents directly.
It is a Python regex tested against **rendered strings**, one per line
of the source, with **the path glued onto the front**:

- alpha/omega render every line of every text file as
  `path:lineno:content` — e.g. `site/privacy/index.html:1:<!doctype html>`
- delta renders every changed line as `path:±content` — e.g.
  `backend/db.py:+def init_db():`

Because the string *starts with the path*, a `^`-anchored pattern is a
path filter; an unanchored pattern is a content filter; one pattern can
be both. That's the whole trick — path scoping is not a feature of the
pattern language, it's a consequence of the string format:

| Pattern | Matches | Effect |
|---|---|---|
| `^site/` | strings starting `site/…` | every file under site/ |
| `fit_barometer` | anywhere in the string | any line mentioning it |
| `^backend/.*def _tool_` | path AND content | tool defs, backend only |
| `"!^FEATURES.md"` | drops matches | everything except that file |

The pipeline starts from *every* line of the source; filters apply in
order. A pipeline that selects nothing is STALE to the gate. Remember
`.` is a regex dot — escape literal dots in paths (`\.py`).

Coverage — change mode: `delta` ranges and `in: delta` greps claim
changed lines; `alpha`/`omega` evidence is citable, never gated.
Explore mode: `omega` ranges and greps cite files; every scope file must
be cited (breadth, not depth — depth is what claims and verdicts are
for). Pinned shas make plain line ranges stable; recipes make every
proof re-runnable — including at future commits, where a re-run of an
omega recipe tells you whether the claim still holds. Stats are derived
by `gocr.py stats`, cited in rendered views, and never stored in the
artifact.
