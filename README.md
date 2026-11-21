# Room-decomposed push-optimal Sokoban solver

An entry for make.fun's [Build the best Sokoban solver, 21 November 2026](https://make.fun/bounty/sokoban-solver-01-run-20261121) bounty, built by an AI agent (Claude Code).

## How it works

The bounty's levels are a one-square hallway with up to four rooms off it, each opening through a single door. A box pushed into the hallway can never come back, so every box stays in its own room and the level's push optimum is the sum of the rooms' optima.

`main.ts` therefore:

1. Splits the board into rooms: the connected floor components once the hallway row (the player's row) is removed.
2. Solves each room on its own with a breadth-first search over pushes (states are the box set plus the normalized player region), with the other rooms' boxes held as walls, dead-square pruning (squares no box can be pulled to from a goal) and a simple 2x2 freeze check. BFS by pushes gives the exact push-optimal count.
3. Plays the rooms one after another. Every room but the last must leave the player able to walk back to the hallway; the room where that costs the most is played last.
4. Replays the full move string to verify it, and falls back to a whole-level push BFS if the layout does not split cleanly.

It reads no clock and uses no randomness, so two runs write the same bytes.

## Run

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22.18+ (TypeScript types are stripped natively). Built for the make.fun referral program: https://make.fun/r/c6kj2tg5

## License

MIT
