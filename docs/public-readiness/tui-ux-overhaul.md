# TUI UX Overhaul (Tracking)

## Current UX problems

- The task list and detail panes truncate long prompts and final responses to fixed line budgets, so operators cannot inspect full content in place.
- Selection and focus are ambiguous when data grows: selected rows are dimly indicated, and there is no explicit pane focus state.
- The dashboard has a single-row visual hierarchy; it does not reinforce the mental model of task groups, selected task context, and focused reading mode.
- Color usage is muted and repetitive, making state changes and attention queues harder to parse during incident-style bursts.
- Interaction is task-list dominant; there is no dedicated workflow for scrolling the prompt/result content that is currently most valuable for triage.

## Target information architecture

- Keep the dashboard as a two-column operator view on wide terminals:
  - Left column: live session/task stream with explicit grouping (`live`, `stale`, `attention`, `recent terminal`) and selectable rows.
  - Right column: selected-task detail surface with mode-specific content (overview/prompt/result/stderr).
  - Bottom: event timeline for selected task.
- On narrow terminals, stack columns but preserve section identity and mode controls.
- Persist keyboard-first focus across three planes:
  - Task list selection
  - Detail content reading
  - Event timeline reading
- Maintain operational truth only; do not add command actions beyond read-only and existing wipe-clean trigger.

## Color / taste principles

- Adopt a restrained “operator console” palette with clear meaning bands:
  - Brand accents for identity and section headers
  - Strong green/amber for active/attention states
  - Cool cyan/blue for metadata and timestamps
  - Warm red for failure/bad states
- Increase visual contrast between focus planes using border and background-like intensity in ANSI-compatible terminals.
- Preserve monochrome safety: degrade gracefully when `--no-color` or non-color mode is selected.
- Keep boxes/borders and labels explicit so state is readable even without color memory.

## Scroll behavior

- Introduce deterministic, per-selected-task vertical scrolling for detail content and event lines.
- Add explicit focus mode:
  - `TASKS` and `DETAIL` and `EVENTS`.
- While `DETAIL` is focused, `↑/↓`, `PageUp/PageDown`, `Home/End` scroll through prompt/result/stderr content.
- While `EVENTS` is focused, same keys scroll the event timeline.
- While `TASKS` is focused, `↑/↓`, `g/G` navigate selection as before.
- Keep a scroll indicator in each pane (`offset/total`) so operators know there is more to inspect.
- In prompt/result/stderr modes, allocate more vertical detail rows and prioritize wrapped prompt/result/stderr content over events.
- Add hard caps in rendering path only for viewport height, not content, ensuring full source text remains inspectable.

## Prompt/result reading workflow

- Default detail mode remains `overview` for context, with short prompt/result preview plus status.
- Operators switch to:
  - `p` prompt mode
  - `r` result mode
  - `s` stderr mode
  - `o` back to overview
- In prompt/result/stderr mode, content is rendered as wrapped text at full length and read via scroll viewport in detail pane.
- Compact context rows in content modes keep the detail task row, target, session, and state visible while giving prompt/result/stderr room first.
- Scroll markers (`^ older lines above`, `v newer lines below`) confirm clipped states.
- Selection stays stable while reviewing; switching tasks resets detail/events offsets intentionally to avoid stale offsets across task contexts.
- `TAB` cycles view mode for fast keyboard flow between overview/prompt/result/stderr.

## Validation plan

- Static validation:
  - `mise exec -- bun run check`.
  - Dedicated rendering smoke checks in demo mode:
    - overview
    - prompt
    - result
    - stderr
    - no-color mode
- TUI runtime validation:
  - Run once with `--once --demo` in color and non-color mode at fixed terminal dimensions.
  - Run interactive mode with demo data and verify scroll and focus keys update visible lines without reloading data source.
  - Verify wipe-clean action path remains available and guarded by existing notice behavior.
- Visual artifact checks:
  - capture render frames for both wide and narrow widths, plus top and scrolled states for prompt/result/stderr.

## Captured validation evidence

- Updated prompt/detail top and scrolled states:
  - `docs/public-readiness/tui-artifacts/prompt-top.txt`
  - `docs/public-readiness/tui-artifacts/prompt-scrolled.txt`
- Updated result/detail top and scrolled states:
  - `docs/public-readiness/tui-artifacts/result-top.txt`
  - `docs/public-readiness/tui-artifacts/result-scrolled.txt`
- Updated stderr/detail top and scrolled states:
  - `docs/public-readiness/tui-artifacts/stderr-top.txt`
  - `docs/public-readiness/tui-artifacts/stderr-scrolled.txt`

## Screenshots / artifacts checklist

- `docs/public-readiness/tui-artifacts/overview-color.txt`
- `docs/public-readiness/tui-artifacts/overview-no-color.txt`
- `docs/public-readiness/tui-artifacts/narrow.txt`
- `docs/public-readiness/tui-artifacts/prompt-top.txt`
- `docs/public-readiness/tui-artifacts/prompt-scrolled.txt`
- `docs/public-readiness/tui-artifacts/result-top.txt`
- `docs/public-readiness/tui-artifacts/result-scrolled.txt`
- `docs/public-readiness/tui-artifacts/stderr-top.txt`
- `docs/public-readiness/tui-artifacts/stderr-scrolled.txt`

## Remaining follow-ups

- Add regression test for scroll bounds and focus-key behavior in a renderer-agnostic unit test.
- Add an automated artifact capture command (script) so expected-frame snapshots can be compared in CI for key modes.
- Evaluate whether long event timelines should become a two-axis timeline with grouped summary rows once history volume grows.
