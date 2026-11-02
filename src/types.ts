export interface SpriteMeta {
  id: number;
  width: number;
  height: number;
  isMask: boolean;
  maskId: number | null;
  dataUrl: string;
}

export interface FontGlyphMeta {
  charCode: number;
  dataUrl: string;
}

export interface UiIconMeta {
  id: number;
  name: string;
  width: number;
  height: number;
  dataUrl: string;
}

export interface CollectibleRule {
  tileId: number;
  points: number;
}

export interface TileProperty {
  tileId: number;
  climbable: boolean;
  solid: boolean;
  deadly: boolean;
}

export interface DaveStartPos {
  level: number;
  x: number;
  y: number;
  dirFlags: number;
}

export interface WarpZoneDef {
  fromLevel: number;
  hasWarp: boolean;
  targetMapIndex: number;
  chuteWallTile: number;
  scrollX: number;
  daveX: number;
  daveY: number;
}

export interface MonsterSpawnDef {
  id: number;
  x: number;
  y: number;
  pathIndex: number;
  fireReload: number;
  spriteBase: number;
}

export interface LevelData {
  level: number;
  daveStart: DaveStartPos;
  warpZone: WarpZoneDef;
  monsters: MonsterSpawnDef[];
  monsterPath: [number, number][];
  tiles: number[][]; // 10 rows x 100 cols
}

export interface SoundEffectDef {
  id: number;
  name: string;
  priority: number;
  timerRate: number;
  sampleRateHz: number;
  divisors: number[];
}

export interface HighScoreEntry {
  rank: number;
  score: number;
  level: number;
  name: string;
}

export interface GameDataBundle {
  meta: {
    game: string;
    author: string;
    unpackedExeSize: number;
    extractedAt: string;
  };
  palette: [number, number, number][];
  sprites: SpriteMeta[];
  fontGlyphs: FontGlyphMeta[];
  uiIcons: UiIconMeta[];
  physics: {
    jumpTable: number[];
    collectibles: CollectibleRule[];
    tileProperties: TileProperty[];
  };
  titleMap: number[][];
  levels: LevelData[];
  sounds: SoundEffectDef[];
  highScores: HighScoreEntry[];
}
