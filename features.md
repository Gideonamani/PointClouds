# Project Features

This file tracks the features we want to implement for the point cloud tiger animation.

## Core Features

- [ ] **Walking Animation:** Animate the tiger model to walk across the screen. (Currently translating on X only; no gait)
- [ ] **Hover Wobble Effect:** Make the tiger's point cloud wobble when the mouse cursor is over it. (Effect currently subtle; needs more impact)

## Completed / In Place

- [x] Striped dot colors with ripple transitions across the body (CPU implementation).
- [x] Orientation manipulator (GUI controls for X/Y/Z) and axis gizmo (if present in current build).
- [x] Floor height control with optional "Snap To Tiger" (if present in current build).

## Future Ideas

- [ ] Add particle effects to the tiger's footsteps.
- [ ] Allow users to upload their own point cloud models.
- [ ] Background polish (gradient sky, fog, and ground plane).
- [ ] Mobile/touch support (tap-to-wobble, tuned mobile defaults).
- [ ] Performance/UX tweaks (FPS stats, cap point count on slow devices, pause when tab hidden).
- [ ] Wobble upgrade: larger radius/intensity, GPU noise field, more dramatic interaction.
- [ ] Walking gait v1: procedural steps with foot contact, head/torso motion, turn animation.

## Deferred / Backed Out (Reverted for Stability)

- [ ] GPU stripes shader with hover wobble and point-size boost (to revisit with stabilizations).
- [ ] Turn animation smoothing and consistent turn direction across edges (ease-in-out; 1.5s).
- [ ] Persist GUI state and Reset-to-defaults session controls.
- [ ] Start-at-edge before formation to avoid post-formation jump.
- [ ] CPU wobble coherence/noise tuning for stronger effect.

## Next Up (Proposed Sequence)

1) Wobble upgrade (stable GPU or improved CPU fallback)
2) Walking gait v1 (procedural steps + timing)
3) Background polish (gradient sky, fog, simple ground)
4) Footstep particles
5) Model upload (GLB/GLTF)

## Build Info

- 2025-09-14 — Added Build Info section; reorganized features into Completed/In Place, Deferred/Backed Out, and Next Up to reflect post-revert status.
- 2025-09-14 — Reconciled feature statuses after reverting unstable changes; documented deferred items (GPU stripes wobble, turn smoothing, persistence/reset, start-at-edge, wobble tuning).
- 2025-09-14 — Fixed startup teleport by gating gait (pitch/bob/sway) and walking until formation completes; start position now set at load.
- 2025-09-14 — Removed post-formation reposition and set left-edge start position during model load to eliminate the visible jolt.
- 2025-09-14 — Stopped OrbitControls zoom while using GUI (wheel capture + hover disable) and pre-converted geometry to non-indexed before sampling to silence MeshSurfaceSampler warnings.

How to use:
- Log every meaningful change with a new line in Build Info using the format: YYYY-MM-DD — short description (newest first).
- When a feature is implemented and stable, move it to “Completed / In Place” with a one‑line description. Keep wording factual and technology‑level (e.g., “CPU stripes” vs “stripes”).
- If a change is added but then reverted/disabled for stability, move it to “Deferred / Backed Out” and add a short reason in parentheses.
- New ideas go to “Future Ideas”. If you start one but it’s not shippable yet, leave it in “Future Ideas” until it’s stable; otherwise place it in “Deferred / Backed Out”.
- Keep “Core Features” as the minimal must‑have experience. Do not check items here unless they are clearly done and robust.
- Maintain “Next Up (Proposed Sequence)” as the current prioritized order of work. Update it whenever priorities change.
- Be consistent with checkbox meanings:
  - [ ] not started or not yet acceptable
  - [x] implemented, stable, and part of the build
- Keep bullets short (one line). Use clarifiers in parentheses when helpful (e.g., “CPU only”, “revisit with shader fixes”).
- AI/agent note: When committing code or configuration that changes runtime behavior, always add a matching Build Info line and update the relevant section(s) in the same edit.
