// Room-decomposed push-optimal Sokoban solver.
// Levels are a one-square hallway (the player's row) with rooms off it; a box can never leave its room, so each room is
// solved on its own by breadth-first search over pushes (exact push optimum), other rooms' boxes held as walls. Rooms
// are then played one after another; every room but the last must leave the player able to reach the hallway again.
// Deterministic: no clock, no randomness, fixed iteration orders. Falls back to a whole-level push BFS if the layout
// does not split cleanly.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const STATE_LIMIT = 3_000_000;

type Level = { w: number; h: number; wall: Uint8Array; goal: Uint8Array; boxes: number[]; player: number };

function parse(text: string): Level {
  const rows = text.split('\n').map((r) => r.replace(/\r$/, '')).filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h);
  const goal = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x] ?? '#';
      const i = y * w + x;
      if (ch === '#') wall[i] = 1;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  }
  // Treat outside-of-level floor (unreachable from the player, no boxes/goals) as wall implicitly via search.
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goal, boxes, player };
}

const LETTERS = ['u', 'd', 'l', 'r'];

function dirs(w: number): number[] {
  return [-w, w, -1, 1];
}

/** Flood fill from p over cells not in `blocked` (walls) and not boxes. Returns visited mark array. */
function reach(n: number, d: number[], blocked: Uint8Array, boxAt: Uint8Array, p: number, out: Uint8Array, stack: Int32Array): number {
  out.fill(0);
  let sp = 0;
  stack[sp++] = p;
  out[p] = 1;
  let min = p;
  while (sp > 0) {
    const c = stack[--sp];
    if (c < min) min = c;
    for (let k = 0; k < 4; k++) {
      const q = c + d[k];
      if (q < 0 || q >= n || out[q] || blocked[q] || boxAt[q]) continue;
      out[q] = 1;
      stack[sp++] = q;
    }
  }
  return min;
}

/** Walk path (letters) from a to b avoiding blocked and boxes; null if none. */
function walk(lv: Level, d: number[], blocked: Uint8Array, boxAt: Uint8Array, a: number, b: number): string | null {
  if (a === b) return '';
  const n = lv.w * lv.h;
  const prev = new Int32Array(n).fill(-1);
  const pk = new Int8Array(n);
  const q = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  q[qt++] = a;
  prev[a] = a;
  while (qh < qt) {
    const c = q[qh++];
    if (c === b) break;
    for (let k = 0; k < 4; k++) {
      const x = c + d[k];
      if (x < 0 || x >= n || prev[x] !== -1 || blocked[x] || boxAt[x]) continue;
      prev[x] = c;
      pk[x] = k;
      q[qt++] = x;
    }
  }
  if (prev[b] === -1) return null;
  let s = '';
  for (let c = b; c !== a; c = prev[c]) s = LETTERS[pk[c]] + s;
  return s;
}

type Push = { box: number; k: number };
type RoomResult = { free: Push[] | null; exit: Push[] | null };

/**
 * Push-optimal BFS for one group of boxes. blocked: walls (+ frozen boxes). goals: target cells for this group.
 * `exitCell`: if >= 0, also find the best solution whose final player region contains exitCell.
 */
function solveGroup(lv: Level, blocked: Uint8Array, groupBoxes: number[], goalCells: number[], player: number, exitCell: number): RoomResult {
  const n = lv.w * lv.h;
  const d = dirs(lv.w);
  const isGoal = new Uint8Array(n);
  for (const g of goalCells) isGoal[g] = 1;
  // Live squares: cells from which a box can be pulled-backward from some goal (reverse reachability).
  const live = new Uint8Array(n);
  const st: number[] = [];
  for (const g of goalCells) if (!live[g]) { live[g] = 1; st.push(g); }
  while (st.length) {
    const c = st.pop()!;
    for (let k = 0; k < 4; k++) {
      const b = c - d[k]; // box came from b, pushed in direction k to c; player stood at b - d[k]
      const p = b - d[k];
      if (b < 0 || b >= n || p < 0 || p >= n) continue;
      if (blocked[b] || blocked[p] || live[b]) continue;
      live[b] = 1;
      st.push(b);
    }
  }
  const m = groupBoxes.length;
  const boxAt = new Uint8Array(n);
  const reachMark = new Uint8Array(n);
  const stack = new Int32Array(n);

  const keyOf = (bs: number[], pn: number): string => String.fromCharCode(pn, ...bs);
  const seen = new Map<string, number>();
  // arrays of state info
  const stBoxes: number[][] = [];
  const stPlayer: number[] = []; // a representative player cell (actual player position after the push)
  const stParent: number[] = [];
  const stPush: Push[] = [];

  const start = groupBoxes.slice().sort((a, b) => a - b);
  for (const b of start) boxAt[b] = 1;
  const pn0 = reach(n, d, blocked, boxAt, player, reachMark, stack);
  for (const b of start) boxAt[b] = 0;
  seen.set(keyOf(start, pn0), 0);
  stBoxes.push(start);
  stPlayer.push(player);
  stParent.push(-1);
  stPush.push({ box: -1, k: -1 });

  const solvedAt = (bs: number[]): boolean => bs.every((b) => isGoal[b]);
  let free = -1;
  let exit = -1;
  const checkGoal = (idx: number): void => {
    const bs = stBoxes[idx];
    if (!solvedAt(bs)) return;
    if (free < 0) free = idx;
    if (exit < 0) {
      if (exitCell < 0) { exit = idx; return; }
      for (const b of bs) boxAt[b] = 1;
      reach(n, d, blocked, boxAt, stPlayer[idx], reachMark, stack);
      for (const b of bs) boxAt[b] = 0;
      if (reachMark[exitCell]) exit = idx;
    }
  };
  checkGoal(0);
  let head = 0;
  while (head < stBoxes.length && (free < 0 || exit < 0)) {
    if (stBoxes.length > STATE_LIMIT) break;
    const idx = head++;
    const bs = stBoxes[idx];
    for (const b of bs) boxAt[b] = 1;
    reach(n, d, blocked, boxAt, stPlayer[idx], reachMark, stack);
    const region = reachMark.slice();
    for (let i = 0; i < m; i++) {
      const b = bs[i];
      for (let k = 0; k < 4; k++) {
        const p = b - d[k];
        const t = b + d[k];
        if (p < 0 || p >= n || t < 0 || t >= n) continue;
        if (!region[p] || blocked[t] || boxAt[t] || !live[t]) continue;
        const nb = bs.slice();
        nb[i] = t;
        nb.sort((a, c) => a - c);
        // freeze-ish simple deadlock: 2x2 block of boxes/walls with a non-goal box
        boxAt[b] = 0;
        boxAt[t] = 1;
        let dead = false;
        for (const [dx, dy] of [[-1, -1], [-1, 0], [0, -1], [0, 0]]) {
          const tl = t + dy * lv.w + dx;
          const cells = [tl, tl + 1, tl + lv.w, tl + lv.w + 1];
          if (cells.some((c) => c < 0 || c >= n)) continue;
          if (cells.every((c) => blocked[c] || boxAt[c]) && cells.some((c) => boxAt[c] && !isGoal[c])) { dead = true; break; }
        }
        let pn = 0;
        if (!dead) pn = reach(n, d, blocked, boxAt, b, reachMark, stack);
        boxAt[t] = 0;
        boxAt[b] = 1;
        if (dead) continue;
        const key = keyOf(nb, pn);
        if (seen.has(key)) continue;
        const ni = stBoxes.length;
        seen.set(key, ni);
        stBoxes.push(nb);
        stPlayer.push(b);
        stParent.push(idx);
        stPush.push({ box: b, k });
        checkGoal(ni);
      }
    }
    for (const b of bs) boxAt[b] = 0;
  }
  const path = (idx: number): Push[] | null => {
    if (idx < 0) return null;
    const out: Push[] = [];
    for (let c = idx; stParent[c] >= 0; c = stParent[c]) out.push(stPush[c]);
    return out.reverse();
  };
  return { free: path(free), exit: path(exit) };
}

/** Apply pushes from the given state, producing move letters; mutates boxAt and returns new player. */
function play(lv: Level, d: number[], boxAt: Uint8Array, player: number, pushes: Push[]): { moves: string; player: number } | null {
  let moves = '';
  let p = player;
  for (const { box, k } of pushes) {
    const from = box - d[k];
    const wk = walk(lv, d, lv.wall, boxAt, p, from);
    if (wk === null) return null;
    moves += wk + LETTERS[k].toUpperCase();
    boxAt[box] = 0;
    boxAt[box + d[k]] = 1;
    p = box;
  }
  return { moves, player: p };
}

function verify(lv: Level, moves: string): number {
  const n = lv.w * lv.h;
  const d = dirs(lv.w);
  const boxAt = new Uint8Array(n);
  for (const b of lv.boxes) boxAt[b] = 1;
  let p = lv.player;
  let pushes = 0;
  for (const ch of moves.toLowerCase()) {
    const k = LETTERS.indexOf(ch);
    const q = p + d[k];
    if (lv.wall[q]) return -1;
    if (boxAt[q]) {
      const t = q + d[k];
      if (lv.wall[t] || boxAt[t]) return -1;
      boxAt[q] = 0;
      boxAt[t] = 1;
      pushes++;
    }
    p = q;
  }
  for (let i = 0; i < n; i++) if (boxAt[i] && !lv.goal[i]) return -1;
  return pushes;
}

function solveRooms(lv: Level): string | null {
  const { w, h } = lv;
  const n = w * h;
  const d = dirs(w);
  const hallRow = Math.floor(lv.player / w);
  // Components of non-wall cells excluding the hallway row.
  const comp = new Int32Array(n).fill(-1);
  let nc = 0;
  for (let i = 0; i < n; i++) {
    if (lv.wall[i] || comp[i] >= 0 || Math.floor(i / w) === hallRow) continue;
    const st = [i];
    comp[i] = nc;
    while (st.length) {
      const c = st.pop()!;
      for (let k = 0; k < 4; k++) {
        const q = c + d[k];
        if (q < 0 || q >= n || lv.wall[q] || comp[q] >= 0 || Math.floor(q / w) === hallRow) continue;
        if (k >= 2 && Math.floor(q / w) !== Math.floor(c / w)) continue;
        comp[q] = nc;
        st.push(q);
      }
    }
    nc++;
  }
  const goals = [...Array(n).keys()].filter((i) => lv.goal[i]);
  // Every box and goal must be in a room component.
  if (lv.boxes.some((b) => comp[b] < 0) || goals.some((g) => comp[g] < 0)) return null;
  const rooms: { boxes: number[]; goals: number[] }[] = [];
  for (let c = 0; c < nc; c++) {
    const bs = lv.boxes.filter((b) => comp[b] === c);
    const gs = goals.filter((g) => comp[g] === c);
    if (bs.length !== gs.length) return null;
    if (bs.length > 0) rooms.push({ boxes: bs, goals: gs });
  }
  const results: RoomResult[] = [];
  for (const r of rooms) {
    const blocked = lv.wall.slice();
    for (const b of lv.boxes) if (comp[b] !== comp[r.boxes[0]]) blocked[b] = 1;
    const res = solveGroup(lv, blocked, r.boxes, r.goals, lv.player, lv.player);
    if (!res.free) return null;
    results.push(res);
  }
  // Choose last room: the one where requiring an exit costs the most (or has no exit solution).
  let last = -1;
  let bestDelta = -1;
  for (let i = 0; i < rooms.length; i++) {
    const ex = results[i].exit;
    const delta = ex ? ex.length - results[i].free!.length : 1e9;
    if (delta > bestDelta) { bestDelta = delta; last = i; }
  }
  for (let i = 0; i < rooms.length; i++) if (i !== last && !results[i].exit) return null;
  const order = [...rooms.keys()].filter((i) => i !== last);
  if (last >= 0) order.push(last);
  const boxAt = new Uint8Array(n);
  for (const b of lv.boxes) boxAt[b] = 1;
  let p = lv.player;
  let moves = '';
  for (const i of order) {
    const pushes = i === last ? results[i].free! : results[i].exit!;
    const r = play(lv, d, boxAt, p, pushes);
    if (!r) return null;
    moves += r.moves;
    p = r.player;
    if (i !== last) {
      const back = walk(lv, d, lv.wall, boxAt, p, lv.player);
      if (back === null) return null;
      moves += back;
      p = lv.player;
    }
  }
  return moves;
}

function solveWhole(lv: Level): string {
  const n = lv.w * lv.h;
  const d = dirs(lv.w);
  const goals = [...Array(n).keys()].filter((i) => lv.goal[i]);
  const res = solveGroup(lv, lv.wall, lv.boxes, goals, lv.player, -1);
  if (!res.free) return '';
  const boxAt = new Uint8Array(n);
  for (const b of lv.boxes) boxAt[b] = 1;
  const r = play(lv, d, boxAt, lv.player, res.free);
  return r ? r.moves : '';
}

function solve(text: string): string {
  const lv = parse(text);
  if (lv.player < 0) return '';
  let moves: string | null = null;
  try {
    moves = solveRooms(lv);
  } catch {
    moves = null;
  }
  if (moves !== null && verify(lv, moves) >= 0) return moves;
  try {
    const m2 = solveWhole(lv);
    if (verify(lv, m2) >= 0) return m2;
  } catch {
    /* fall through */
  }
  return '';
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
