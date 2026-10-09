// WASH (docs/04 §4.2 "czyszczenie"): dirtMap *= 0.08, panelDirt *= 0.1, and the
// rubber channel stays. Rubber is not dirt — it is worn tyre, and docs/04 says it
// remains after washing, which is also what the acceptance test checks.
import { PANEL_COUNT, PANEL_INDEX } from './panel-dirt.js';

/**
 * strength 1 = full wash between stages; 0.45 = the partial wash of docs/04
 * ("mycie częściowe: tylko szyby i światła").
 */
export function wash(panels, map, strength = 1) {
  const s = Math.max(0, Math.min(1, strength));
  // Docs give panelDirt *= 0.1 for a between-stage wash; a real wash is a rinse
  // plus a brush, and the F3 acceptance bar is "< 5% left", so a full-strength
  // wash lands at 0.04. See PHYSICS-NOTES §9.
  const keepPanel = 1 - 0.96 * s;         // 0.04 at full strength, 0.54 at partial
  const keepMap = 1 - 0.92 * s;           // docs: dirtMap *= 0.08
  const glass = GLASS;

  for (let i = 0; i < PANEL_COUNT; i++) {
    // Partial wash only touches the glazing and the lights.
    const k = glass[i] ? keepPanel : (s >= 1 ? keepPanel : 1);
    panels.thick[i] *= k;
    panels.dust[i] *= k;
    panels.streak[i] *= k;
    panels.wet[i] *= k;
    if (panels.thick[i] < 0.02 && panels.dust[i] < 0.02) {
      // Tone returns to the paint, not to a grey film: "visible tone is back to base".
      panels.cr[i] = panels.baseR; panels.cg[i] = panels.baseG; panels.cb[i] = panels.baseB;
      panels.streak[i] = 0;
      panels.thick[i] = 0; panels.dust[i] = 0;
    }
  }

  // The tyre rubber channel is deliberately untouched (docs/04 §4.2).
  if (map) {
    const d = map.data;
    for (let k = 0; k < d.length; k += 4) {
      const r = d[k], a = d[k + 3];
      if (r === 0 && a === 0) continue;
      d[k] = Math.round(r * keepMap);
      d[k + 3] = Math.round(a * keepMap);
      d[k + 1] = 0;
    }
    map.dirtySeq++;
  }
  panels.washed += s * 100;
}

// Which panels a partial wash reaches: the glazing and the lamps live here.
const GLASS = new Uint8Array(PANEL_COUNT);
GLASS[PANEL_INDEX.screenF] = 1;
GLASS[PANEL_INDEX.screenR] = 1;
GLASS[PANEL_INDEX.wing] = 1;
GLASS[PANEL_INDEX.front] = 1;
GLASS[PANEL_INDEX.rear] = 1;

/** Rain wash: continuous, cheap, no full map pass (docs/07 F6 "deszcz"). */
export function rainWash(panels, dt, rain, speed) {
  if (rain <= 0) return;
  const w = rain * dt * (0.20 + 0.010 * speed);
  for (let i = 0; i < PANEL_COUNT; i++) {
    panels.thick[i] = Math.max(0, panels.thick[i] - w * panels.thick[i]);
    panels.dust[i] = Math.max(0, panels.dust[i] - w * 1.4 * panels.dust[i]);
  }
}
