// Draws build/icon.png (the app icon used by the installer) in code.
const fs = require('fs');
const path = require('path');
const { render, hexToRgb } = require('../png');

const DARK = [...hexToRgb('#16181e'), 1];
const EDGE = [...hexToRgb('#4da3ff'), 1];
const WHITE = [...hexToRgb('#f2f4f8'), 1];

// Signed distance to a rounded square centred at (0.5, 0.5).
function roundedSquare(u, v, half, radius) {
  const qx = Math.abs(u - 0.5) - (half - radius);
  const qy = Math.abs(v - 0.5) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function inEllipse(u, v, cx, cy, rx, ry) {
  return ((u - cx) / rx) ** 2 + ((v - cy) / ry) ** 2 < 1;
}

function shade(u, v) {
  const d = roundedSquare(u, v, 0.46, 0.2);
  if (d > 0) return null;
  if (d > -0.035) return EDGE;
  if (inEllipse(u, v, 0.34, 0.44, 0.065, 0.085)) return WHITE;
  if (inEllipse(u, v, 0.66, 0.44, 0.065, 0.085)) return WHITE;
  const smile = Math.hypot(u - 0.5, v - 0.55);
  if (v > 0.63 && Math.abs(smile - 0.17) < 0.024) return WHITE;
  return DARK;
}

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, render(512, shade));
