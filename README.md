# GOCR — Graph-Oriented Code Review

Review a change by its **claims**, not its diff.

AI-assisted development produces changes either bigger or quicker than
humans used to to so review has become the bottleneck. GOCR's goal is
to turn human review into something that scales: a story they can read
and comment on.

To do this a fresh agent (never the code's author) figures out what the
change claims to do, anchors every claim to live-resolvable evidence,
and a hard **coverage gate** proves no changed line went unexamined.

Humans walk the claims in an interactive slide deck, check the evidence,
and provide their feedback.

The artifact stores recipes, never results — everything resolves live
against pinned git shas, so nothing in it can quietly go stale.

Two modes:

- **change** — review a commit, branch, or PR. Gate: every changed
  line claimed by some claim's evidence.
- **explore** — map a codebase territory at one sha (onboarding docs
  that can prove their own coverage). Gate: every scope file cited.

Test files are skipped in both modes by default (`tests: review` in
the header puts them back).

## Install

Claude Code plugin (official channel):

```
claude plugin marketplace add charleslobo/gocr
/plugin install gocr
```

npx skills (community, cross-tool):

```
npx skills add charleslobo/gocr
```

Or plain git:

```
git clone https://github.com/charleslobo/gocr ~/.claude/skills/gocr-repo
ln -s ~/.claude/skills/gocr-repo/skills/gocr ~/.claude/skills/gocr
```

## Use

In any repo, in Claude Code:

- `gocr <sha|branch|PR>` — claim-based review of a change
- `gocr explore <area>` — map a subsystem or the whole repo
- `gocr` across sibling repos — one campaign.yaml binds per-repo
  reviews into a single deck (cross-repo walk, one record)
- `gocr serve` — open the report: a slide deck with live evidence
  resolution, IDE jump, per-line comments, and act/ignore marks on
  open questions that write straight back into the artifact

The artifact is a single `review.yaml` in the reviewed repo
(`.gocr/<name>/`). Handing the review's outcomes to a coding agent is
one sentence: *"read the gocr review and address my comments and the
questions marked act."*

## The rules that make it trustworthy

1. The review is blind to its author. The triggering session — usually
   the agent that wrote the code — hands only the pinned shas to a
   fresh Conductor agent and never sees inside the pipeline: it cannot
   steer the reading and cannot editorialize the result.
2. The coverage gate must pass — unclaimed changes fail loudly.
3. Evidence is declarative recipes (line ranges and grep pipelines
   over pinned shas) — resolved live, never cached.
4. Judgment belongs to the human — generators never mark a claim
   right or wrong.

The hand-off protocol lives in
[skills/gocr/SKILL.md](skills/gocr/SKILL.md); the pipeline the
Conductor runs in [skills/gocr/CONDUCTOR.md](skills/gocr/CONDUCTOR.md);
the report's visual language in
[skills/gocr/report/DESIGN.md](skills/gocr/report/DESIGN.md).
