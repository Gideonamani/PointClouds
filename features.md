# Project Features

This file tracks the features we want to implement for the point cloud tiger animation.

## Core Features

- [ ] **Walking Animation:** Animate the tiger model to walk across the screen. (Currently translating on X only; no gait)
- [ ] **Hover Wobble Effect:** Make the tiger's point cloud wobble when the mouse cursor is over it. (Effect currently subtle; needs more impact)

## Completed / In Place

- [x] Striped dot colors with ripple transitions across the body (CPU + GPU shader modes).
- [x] Floor height control with "Snap To Tiger".
- [x] Orientation manipulator + rotation gizmo (drag rings on axes).
- [x] Formation-first start + fixed flip on turnarounds.
- [x] Basic gait overlay (bob/sway/pitch) layered on walking.

## Future Ideas

- [ ] Add particle effects to the tiger's footsteps.
- [ ] Allow users to upload their own point cloud models.
- [ ] Background polish (gradient sky, fog, and ground plane).
- [ ] Mobile/touch support (tap-to-wobble, tuned mobile defaults).
- [x] Persist GUI state (save to localStorage, add Reset).
- [ ] Performance/UX tweaks (FPS stats, cap point count on slow devices, pause when tab hidden).
- [ ] Wobble upgrade: larger radius/intensity, GPU noise field, more dramatic interaction.
- [ ] Walking gait v1: procedural steps with foot contact, head/torso motion, turn animation.
