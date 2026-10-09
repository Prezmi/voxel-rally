// Stage balance constants, one place (docs/03 §4 "Checkpointy i timing").
// Kept out of stage.js so tuning does not touch the state machine.
export const PENALTY_GATE = 30;        // docs/03 §4: "Brak bramki = kara +30 s"
export const PENALTY_JUMP_START = 5;   // docs/03 §4: "ruch przed GO = +5 s"
export const LIMIT_MULT = 1.6;         // docs/03 §4: "Limit odcinka = ref_time * 1.6"
export const MAX_MISSED_GATES = 2;     // docs/03 §4: "albo DNF przy 2 brakach"
export const CHECKPOINTS = 6;          // PLAN.md §2: leśny szuter, 6 checkpointów
export const COUNTDOWN = 3.0;          // s of start-gate countdown before GO
export const JUMP_START_SPEED = 0.6;   // m/s of body speed that counts as a jump start
export const GATE_ARM_ARC = 60;        // m before a gate where the plane test arms
export const GATE_MISS_ARC = 70;       // m past a gate with no crossing -> missed
export const GATE_LATERAL = 26;        // m: a crossing this far off the centreline is not the gate
export const STUCK_SPEED = 0.7;        // m/s
export const STUCK_TIME = 25;          // s stuck off-stage counts as DNF
