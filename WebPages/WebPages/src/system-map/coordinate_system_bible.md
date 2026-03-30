# 🌌 Coordinate System Design Bible: KSP ⇄ Telemachus 3D Map

This document defines the "Source of Truth" for the coordinate system and visual alignment logic used to achieve perfect parity with Kerbal Space Program's native world space.

## 1. Global Coordinate System (The "World")
The map is built on a **Native Unity Coordinate System** ($Y$-up).

| Axis | Description | KSP Unity Sense | Map Sense |
| :--- | :--- | :--- | :--- |
| **X** | Right / East | Positive | Positive |
| **Y** | North / Vertical | Positive (North) | **Negative** (Visually UP) |
| **Z** | Forward / North-ish | Positive | Positive |

> [!IMPORTANT]
> To match the user's preferred "Top-Down" perspective while maintaining KSP's vertical logic, we use an **Inverted Camera** (`camera.up = (0, -1, 0)`). This means that for a celestial body to appear "Higher" (Northern) on the screen, its mathematical $Y$ coordinate must be **Negative**.

---

## 2. Core Transformations

### Centralized Vertical Inversion
All Raw KSP Global vectors passing through the formatter are converted to "Map Space" via this formula:
```javascript
Result_Y = -(Raw_Body_Y - Raw_Kerbin_Y)
```
This ensures that the "10 to -20" logic is applied uniformly to Planets, Moons, Vessels, and Maneuver Nodes.

### Orbital Element Parity
To resolve the "Left-Handed" (Unity) vs "Right-Handed" (Three.js) conflict, we apply the following corrections to the Keplerian elements:

| Element | Correction | Reason |
| :--- | :--- | :--- |
| **$\Omega$ (LAN)** | `-(lan) + 90°` | Inverts rotation + corrects for Unity's Z-forward zero-point. |
| **$\omega$ (ArgPe)** | `-(argPe)` | Inverts the periapsis phase rotation. |
| **$i$ (Inclination)** | `-(inc)` | Resolves mirrored orbital "peaks" and "valleys." |

---

## 3. The "Ultimate Intersection" (Visual Snapping)
To solve the "1-pixel gap" problem caused by floating-point noise and propagation offsets, we use a **Visual Snap** algorithm.

1. **Path as Truth**: The mathematical 720-point orbital path is generated first.
2. **Sphere Alignment**: The Map finds the point on that 720-point ring closest to the body's telemetry position and moves the sphere marker (the "ball") exactly to that point. 
3. **Result**: Guaranteed pixel-perfect contact between the body and its orbit at any zoom level.

---

## 4. Summary Checklist for Future Development
- [x] Use `Math.min` for scaleFactor calculations to prevent elliptical distortion.
- [x] Always subtract `rootOrigin` (Kerbin) before applying the $Y$-inversion.
- [x] Maintain the `up = (0, -1, 0)` camera vector to keep the coordinate sense consistent with the UI.

***

**"Ad Astra per Aspera"** - To the stars through difficulties. 🚀✨
