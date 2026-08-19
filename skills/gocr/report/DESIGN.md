# GOCR report — design direction

GOCR's own identity. Not throughglass's ink-wash, not the AI-default
looks (cream + display serif; near-black + one neon accent; broadsheet
hairlines). Any future restyle starts from this brief.

## Concept

An **examination instrument**: claims under a light, evidence resolved
live, a human stamping verdicts. Chrome recedes; the claim is a
document; code is the specimen; judgment is the only loud thing.

## The two voices (the structural type rule)

- **Machine voice = mono** (`ui-monospace`): kickers, anchors, recipes,
  chips, badges, coverage, stamps, buttons. Everything the system
  asserts.
- **Human voice = Charter** (system serif; falls back Iowan/Georgia):
  claim titles + bodies, notes, open questions, comments. Everything a
  person wrote. Reading measure 68ch, 1.65 line height.

Never mix: if a machine artifact is set in serif or a human sentence in
mono, it's a bug.

## Color (dark-first; cool-white daylight mode via prefers-color-scheme)

Graphite housing, four elevations: `--bg` → `--surface` (chrome bars) →
`--paper` (reading surface) → `--raise` (code, chips). Cold cast.

Saturation is **reserved for judgment**:
- `--ok` green = verified, `--bad` red = refuted, `--trust` bronze =
  trusted. **Unverified is neutral** — pending is not a warning.
- `--steel` (desaturated blue) = live human action: focus, hover, the
  coverage bar, and the reviewer's **comments** (rule + text — the
  conversation layer wears steel; Charles picked the color). Used
  sparingly everywhere else.

Banned: cream/terracotta, purple, neon accents, gradients, heavy
shadows, big rounded containers.

## The signature: verdict stamps

- Pending: dashed pill, dim — an outline waiting for ink.
- Stamped: 1.5px solid currentColor, mono caps, 700, rotated −1.5°.
  The tilt appears ONLY where a human acted. Same treatment on the
  active verdict button.

## Deck shape (every slide has one job)

- **Cover** — what the change IS: title, the story `summary` (2–4
  sentences), the coverage bar. Never the why: an itinerary before the
  reader knows the destination is the wall-of-text failure.
- **Story slide** — the route: the walk as a clickable itinerary, each
  leg carrying its one-or-two-sentence why. The walk points; the claims
  argue — a why essay that re-makes the claims' cases is the failure
  this slide's shape exists to prevent.
- **Claim slides** — one assertion under the light, its evidence
  resolved inline beneath it. The code is visible on the slide itself,
  never hidden behind a click; a recipe click opens a focus slide, it
  doesn't reveal.

## Density philosophy

High information density, low visual intensity. Hierarchy from spacing,
type, and elevation; color only where meaning requires it. Comments are
a quiet left-rule conversation, never loud cards.
