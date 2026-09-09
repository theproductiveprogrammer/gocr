---
name: gocr
description: |
  Graph-Oriented Code Review — generates a interactive story-deck report. It runs in two modes: change mode reviews a commit/branch/PR (gate = every changed line claimed) and explore mode maps a codebase territory at one pinned sha (gate = every scope file cited). Test files are skipped in both modes unless the user asks for them. Use when the user says "gocr", "gocr this commit/branch/PR", "gocr explore <area>", "gocr serve", "generate a claim review", "graph review", "map this subsystem with gocr", or wants a change reviewed by claims instead of by reading the raw diff.
---

# GOCR — claim-based review of one change

AI-assisted development produces changes either bigger or quicker than
humans used to so review has become the bottleneck. GOCR's goal is
to turn human review into something that scales: a story they can read
and comment on.

To do this a fresh agent (never the code's author) figures out what the
change claims to do, anchors every claim to live-resolvable evidence,
and a hard **coverage gate** proves no changed line went unexamined.
Test files are left out of the review by default, in both modes; a
user who wants them reviewed says so, and that request travels to the
Conductor as a directive like any other.
Humans walk the claims in an interactive slide deck, check the evidence,
and provide their feedback. The artifact stores recipes, never results —
everything resolves live against pinned git shas, so nothing in it can
quietly go stale.

**The deck is the deliverable.** A run that ends with a served URL and
an untouched codebase is a complete success. Judgment, and any fixing
that follows, belongs to the human.

## The blind hand-off (this is your entire job)

You — the session that triggered this skill — are likely the author of
the code under review. So the review runs where you cannot touch it:
a fresh subagent, the **Conductor**, executes the whole pipeline from
its own instructions, which you never read. You cannot steer what you
never see, and you cannot narrate what you never did. Your doubts and
your context are excluded by construction — if you knew of a real
problem, it belonged in the change, not in the review.

**1. Pin.** For a **change**: `alpha` = before sha, `omega` = after
sha (a SHA → `<sha>^`/`<sha>`; a range/branch → merge-base/head; a
PR → base/head shas; a stacked series is one artifact — alpha =
series base, omega = tip). For an **explore**: `omega` = the sha,
plus the user's own words for the territory to map. For a fetched
`.diff` with no repo: the diff file path. Pick an artifact directory:
`<repo>/.gocr/<short-name>/`, untracked unless the user asks.

**2. Spawn the Conductor.** One fresh subagent (Agent tool,
general-purpose). Its brief is EXACTLY this and nothing more:

- the repo root path
- the pinned shas (or omega + territory words, or the diff path)
- the artifact directory
- the human reviewer's own directives, verbatim and marked
  "from the human reviewer" — only if the user gave any (including
  "gocr verify")
- "Read <skill-base-dir>/CONDUCTOR.md and follow it. Return the
  review.yaml path and your hand-over note."

Nothing else goes in. No summary of the change, no commit context, no
areas of concern, no opinions, no hints. If you wrote the code, that
is exactly why you add nothing.

**3. Wait blind.** Do not read CONDUCTOR.md, the diff, or the yaml
while you wait. In chat, a status line ("conductor running") is
plenty.

**4. Check the stamps, serve, relay.** When the Conductor returns,
look at ONE thing before anything else — not the yaml, not the
claims: the hand-over note's `timings:` line. It must stamp every
numbered step or say `skipped: <why>`. A missing stamp means a step
was silently skipped: send the Conductor back to run it. This is
bookkeeping, not content — blindness holds. Then run
`python3 <skill-base-dir>/gocr.py serve <yaml-path> [port]` from the
repo root, then give the user the URL, the yaml path, and the
Conductor's hand-over note **verbatim**. That is the entire final
message — you add the URL, not commentary.

`gocr serve` on its own (an existing review.yaml) is just step 4.

## Campaigns (one change across several repos)

When the same change spans sibling repos (a contract in one, its
producer and consumers in others), each repo still gets its own
independent review — plus one `campaign.yaml` that binds them into a
single deck. As the triggering session:

1. **Pin per repo** and pick a **lead repo** — the one you're in, or
   the one holding the primary change. Use one short `<name>` for
   every repo's artifact directory (`.gocr/<name>/` in each).
2. **Spawn one Conductor per repo, in parallel** — each brief exactly
   as above, scoped to its own repo. They never see each other.
3. **When all return, spawn the Weaver** — one fresh subagent. Its
   brief: the finished review.yaml paths (nothing else), and "Read
   <skill-base-dir>/CONDUCTOR.md § The Weaver and follow it. Return
   the campaign.yaml path and your hand-over note."
4. **Serve the campaign**: `python3 <skill-base-dir>/gocr.py serve
   .gocr/<name>/campaign.yaml [port]` from the lead repo root.

The campaign file (in the lead repo, `.gocr/<name>/campaign.yaml`):

```yaml
kind: campaign
name: <name>
title: <one line for the cover>
members:
  - repo: .                      # path relative to the lead repo root
    review: <name>               # its .gocr/<review>/ directory
    name: lead                   # short label; claims render as lead:C1
  - repo: ../sibling-repo
    review: <name>
    name: common
story:                           # same shape as a review story;
  walk:                          # legs use member-prefixed ids
    - common:C3: the contract changes first
    - lead:C1: the consumer follows
```

Member reviews stay byte-identical to lone reviews; `serve` and
`coverage` accept either file. The campaign gate passes only when
every member's gate passes.

## Acting on a review (any agent, any later session)

The artifact is the handoff — it lives in the reviewed repo at
`.gocr/<name>/review.yaml`, so "read the gocr review and address it" is
the entire integration. The signals, in priority order:

1. **`comments`** — the reviewer's work items. Each may carry an `at:`
   anchor (source:selection, pinned to the omega sha): resolve it with
   `gocr.py resolve` or `git show` to the exact lines meant. Check
   drift (pinned content vs working tree) before editing — the code may
   have moved since the review.
2. **`campaign:`** — a header line in a member review pointing at
   its campaign.yaml (relative to that repo's root); follow it when
   the work spans repos.
3. **`open_questions`** — doubts recorded during review. The reviewer
   may triage each one in the report: an item rewritten as
   `- status: act` + `text:` is a work item; `status: ignore` means
   drop it; a plain item is untriaged — treat as a backlog candidate.

When work changes the code a claim describes, re-run
`gocr.py coverage`/`resolve` at a new omega to see which claims still
hold — the recipes are re-runnable by design.

## Tool reference

`python3 <skill-base-dir>/gocr.py` — the base directory is shown in
the "Base directory for this skill" line when this skill loads. Run
from the repo root.
- `serve review.yaml|campaign.yaml [port]` — the report: a local
  story-deck UI (a campaign renders all members as one deck)
- `coverage review.yaml|campaign.yaml` — the gate (self-describing)
- `resolve review.yaml <selection | claim-id>` — show what evidence names
- `stats review.yaml` — per-claim mechanical signals
- `files <diff-path-or-url>` — per-file shape of a diff
