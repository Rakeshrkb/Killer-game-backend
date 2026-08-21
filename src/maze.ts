export const MAZE_GRID: number[][] = [
  [0,0,0,0,0,0,0,0,0,0,0,0,0], // row 1
  [0,1,1,1,1,1,1,1,0,1,1,1,0], // row 2
  [0,1,0,1,0,0,0,1,1,0,1,1,0], // row 3
  [0,1,1,1,1,1,1,1,1,1,1,1,0], // row 4
  [0,1,0,0,1,0,1,0,1,0,0,1,0], // row 5
  [0,1,1,1,1,1,1,0,1,1,1,1,0], // row 6
  [0,1,0,1,0,1,0,0,1,0,0,1,0], // row 7
  [0,1,1,1,1,1,1,1,1,1,1,1,0], // row 8
  [0,0,0,0,0,0,0,0,0,0,0,0,0], // row 9
];

export type GridPos = { row: number; col: number };

// Returns every walkable (value === 1) tile in the maze
export function getWalkableTiles(): GridPos[] {
  const tiles: GridPos[] = [];
  for (let row = 0; row < MAZE_GRID.length; row++) {
    for (let col = 0; col < MAZE_GRID[row].length; col++) {
      if (MAZE_GRID[row][col] === 1) {
        tiles.push({ row, col });
      }
    }
  }
  return tiles;
}

// Picks `count` random distinct walkable tiles — used for spawning players
export function pickRandomSpawnTiles(count: number): GridPos[] {
  const walkable = getWalkableTiles();
  const shuffled = [...walkable].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}