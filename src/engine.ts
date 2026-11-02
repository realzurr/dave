import { PCSpeakerAudio } from './audio';
import { VGARenderer } from './renderer';
import { LocalDataRepository, SaveStateRecord } from './repository';
import { GameDataBundle, HighScoreEntry, TileProperty } from './types';

export type GameState =
  | 'TITLE'
  | 'PLAYING'
  | 'SCROLLING'
  | 'INTERMISSION'
  | 'WARP_CUTSCENE'
  | 'VICTORY'
  | 'GAME_OVER'
  | 'HIGH_SCORE_ENTRY'
  | 'HIGH_SCORES';

interface ActiveMonster {
  active: boolean;
  deadTimer: number; // >0 when exploding (sprites 129..132)
  x: number; // world pixel X (0..1599)
  y: number; // screen pixel Y (16..175)
  pathIndex: number;
  fireReload: number;
  fireTimer: number;
  spriteBase: number;
  animFrame: number;
  animTimer: number;
}

interface Projectile {
  active: boolean;
  x: number; // screen-relative pixel X
  y: number; // screen-relative pixel Y
  dir: number; // 1 = right, -1 = left
  isMonster: boolean;
  animFrame: number;
}

export class DaveEngine {
  public data: GameDataBundle;
  public renderer: VGARenderer;
  public audio: PCSpeakerAudio;
  public repo: LocalDataRepository;

  public state: GameState = 'TITLE';
  public paused = false;
  public helpPage = 0; // 0 = closed, 1..3 = F1 help pages
  public godMode = false;

  // Game progress
  public score = 0;
  public nextExtraLifeScore = 20000;
  public lives = 3;
  public currentLevel = 0; // 0..9 (Levels 1..10)
  public activeMapLevel = 0; // Usually === currentLevel, except inside a Warp Zone
  public inWarpZone = false;
  public visitedWarpZones = new Set<number>();

  // Map runtime state (10 rows x 100 cols)
  public map: number[][] = [];
  public scrollX = 0; // 0..80 (in tiles)
  private scrollRemaining = 0; // >0 scrolling right, <0 scrolling left

  // Dave state
  public dave = {
    x: 32, // screen-relative X (0..304)
    y: 144, // screen-relative Y (0..199, playfield starts at 16)
    dir: 1, // 1 = right, -1 = left
    isJumping: false,
    jumpIndex: 0,
    isFalling: false,
    isClimbing: false,
    isJetpacking: false,
    hasTrophy: false,
    hasGun: false,
    jetpackFuel: 0, // 0..255
    walkFrame: 0,
    deadTimer: 0, // >0 when exploding
    respawnInvuln: 0,
    onGround: true,
  };

  public monsters: ActiveMonster[] = [];
  public daveBullet: Projectile = { active: false, x: 0, y: 0, dir: 1, isMonster: false, animFrame: 0 };
  public monsterFireballs: Projectile[] = [];

  // Input state
  public keys = {
    left: false,
    right: false,
    up: false,
    down: false,
    jump: false,
    shoot: false,
  };

  // Animation & transition counters
  public tickCount = 0;
  public animTick = 0;
  private transitionX = 0;
  private transitionY = 0;
  private transitionTimer = 0;

  // High Scores
  public highScores: HighScoreEntry[] = [];
  public playerInitials = '';

  // Fast lookup maps
  private collectibleMap = new Map<number, number>();
  private tileProps: TileProperty[] = [];

  constructor(data: GameDataBundle, renderer: VGARenderer, audio: PCSpeakerAudio, repo = new LocalDataRepository()) {
    this.data = data;
    this.renderer = renderer;
    this.audio = audio;
    this.repo = repo;

    for (const c of data.physics.collectibles) {
      this.collectibleMap.set(c.tileId, c.points);
    }
    this.tileProps = data.physics.tileProperties;

    this.highScores = this.data.highScores.map((h) => ({ ...h }));
    this.loadHighScores();
  }

  private async loadHighScores(): Promise<void> {
    this.highScores = await this.repo.getHighScores(this.data.highScores);
  }

  private saveHighScores(): void {
    this.repo.saveHighScores(this.highScores);
  }

  public async quickSave(slotId = 'quicksave', slotName = 'Quick Save'): Promise<SaveStateRecord[]> {
    const slot: SaveStateRecord = {
      id: slotId,
      name: slotName,
      level: this.currentLevel,
      score: this.score,
      lives: this.lives,
      hasGun: this.dave.hasGun,
      hasTrophy: this.dave.hasTrophy,
      jetpackFuel: this.dave.jetpackFuel,
      inWarpZone: this.inWarpZone,
      daveX: this.dave.x,
      daveY: this.dave.y,
      scrollX: this.scrollX,
      savedAt: new Date().toISOString(),
    };
    return this.repo.saveGameSlot(slot);
  }

  public loadSaveSlot(slot: SaveStateRecord): void {
    this.currentLevel = slot.level;
    this.score = slot.score;
    this.lives = slot.lives;
    this.inWarpZone = slot.inWarpZone;
    this.loadLevel(slot.level);
    this.scrollX = slot.scrollX;
    this.dave.x = slot.daveX;
    this.dave.y = slot.daveY;
    this.dave.hasGun = slot.hasGun;
    this.dave.hasTrophy = slot.hasTrophy;
    this.dave.jetpackFuel = slot.jetpackFuel;
    this.state = 'PLAYING';
  }

  public startNewGame(startLevel = 0): void {
    this.audio.stop();
    this.score = 0;
    this.nextExtraLifeScore = 20000;
    this.lives = 3;
    this.currentLevel = startLevel;
    this.inWarpZone = false;
    this.visitedWarpZones.clear();
    this.dave.hasGun = false;
    this.dave.jetpackFuel = 0;
    this.helpPage = 0;
    this.paused = false;
    this.loadLevel(this.currentLevel);
    this.state = 'PLAYING';
  }

  public loadLevel(levelIdx: number, warpOverride?: { mapIdx: number; scrollX: number; daveX: number; daveY: number }): void {
    this.audio.stop();
    const mapIdx = warpOverride ? warpOverride.mapIdx : levelIdx;
    this.activeMapLevel = mapIdx;
    const lvlDef = this.data.levels[mapIdx];

    // Deep-copy 10x100 tiles so pickups mutate only the active run
    this.map = lvlDef.tiles.map((row) => [...row]);

    if (warpOverride) {
      this.scrollX = warpOverride.scrollX;
      this.dave.x = warpOverride.daveX;
      this.dave.y = warpOverride.daveY;
      this.dave.dir = 1;
    } else {
      this.scrollX = 0;
      this.dave.x = lvlDef.daveStart.x;
      this.dave.y = lvlDef.daveStart.y;
      this.dave.dir = 1;
      this.inWarpZone = false;
    }

    this.dave.isJumping = false;
    this.dave.jumpIndex = 0;
    this.dave.isFalling = false;
    this.dave.isClimbing = false;
    this.dave.isJetpacking = false;
    this.dave.hasTrophy = false;
    this.dave.deadTimer = 0;
    this.dave.walkFrame = 0;
    this.dave.onGround = true;

    this.daveBullet.active = false;
    this.monsterFireballs = [];

    // Spawn monsters from level definition (if not in warp zone or if map has monsters)
    this.monsters = lvlDef.monsters.map((m, i) => ({
      active: true,
      deadTimer: 0,
      x: m.x,
      y: m.y,
      pathIndex: m.pathIndex,
      fireReload: m.fireReload,
      fireTimer: m.fireReload + i * 6,
      spriteBase: m.spriteBase,
      animFrame: i % 3,
      animTimer: 2,
    }));
  }

  public jumpToWarpZone(fromLevelIdx: number): void {
    const wz = this.data.levels[fromLevelIdx].warpZone;
    if (!wz.hasWarp) return;
    this.currentLevel = fromLevelIdx;
    this.inWarpZone = true;
    this.visitedWarpZones.add(fromLevelIdx);
    this.transitionY = 0;
    this.state = 'WARP_CUTSCENE';
  }

  public toggleJetpack(): void {
    if (this.state !== 'PLAYING' || this.dave.deadTimer > 0) return;
    if (this.dave.isJetpacking) {
      this.dave.isJetpacking = false;
      this.audio.stopIfPlaying(9);
    } else if (this.dave.jetpackFuel > 0) {
      this.dave.isJetpacking = true;
      this.dave.isJumping = false;
      this.dave.isFalling = false;
      this.dave.isClimbing = false;
      this.audio.play(11); // ToJetpack
    }
  }

  public handleKeyDown(e: KeyboardEvent): void {
    if (e.code === 'F1') {
      e.preventDefault();
      this.helpPage = (this.helpPage + 1) % 4;
      return;
    }
    if (e.code === 'F3') {
      e.preventDefault();
      this.startNewGame(0);
      return;
    }
    if (e.code === 'F9') {
      e.preventDefault();
      if (this.state === 'PLAYING') {
        this.paused = !this.paused;
      }
      return;
    }

    if (this.helpPage > 0) {
      if (e.code === 'Space' || e.code === 'Escape' || e.code === 'Enter') {
        e.preventDefault();
        this.helpPage = (this.helpPage + 1) % 4;
      }
      return;
    }

    if (this.state === 'TITLE') {
      if (
        e.code === 'Space' ||
        e.code === 'Enter' ||
        e.code === 'ArrowLeft' ||
        e.code === 'ArrowRight' ||
        e.code === 'ArrowUp' ||
        e.code === 'ControlLeft' ||
        e.code === 'ControlRight'
      ) {
        e.preventDefault();
        this.startNewGame(0);
      } else if (e.code === 'KeyH') {
        this.state = 'HIGH_SCORES';
      }
      return;
    }

    if (this.state === 'HIGH_SCORES' || this.state === 'VICTORY' || this.state === 'GAME_OVER') {
      if (e.code === 'Space' || e.code === 'Enter' || e.code === 'Escape') {
        e.preventDefault();
        this.state = 'TITLE';
      }
      return;
    }

    if (this.state === 'HIGH_SCORE_ENTRY') {
      if (e.code === 'Backspace') {
        this.playerInitials = this.playerInitials.slice(0, -1);
      } else if (e.code === 'Enter') {
        this.commitHighScore(this.playerInitials || 'DAV');
      } else if (e.key.length === 1 && /[a-zA-Z0-9 ]/.test(e.key) && this.playerInitials.length < 3) {
        this.playerInitials += e.key.toUpperCase();
      }
      return;
    }

    if (
      e.code === 'AltLeft' ||
      e.code === 'AltRight' ||
      e.code === 'KeyX' ||
      e.code === 'ShiftLeft' ||
      e.code === 'ShiftRight'
    ) {
      e.preventDefault();
      if (!e.repeat) {
        this.toggleJetpack();
      }
    }
  }

  private addScore(pts: number): void {
    if (pts <= 0) return;
    this.score += pts;
    if (this.score >= this.nextExtraLifeScore) {
      this.lives = Math.min(9, this.lives + 1);
      this.nextExtraLifeScore += 20000;
    }
  }

  /**
   * Exact implementation of DAVE.EXE check_dave_tile(dx, dy) at 0x2a70:
   * Returns 0 (passable), 1 (solid wall/floor), or 2 (deadly fire/water/weeds).
   */
  private checkDaveTile(dx: number, dy: number): number {
    const py = this.dave.y + dy;
    if (py < 16) return 0;
    const col = Math.floor((this.dave.x + dx) / 16) + this.scrollX;
    const row = Math.floor((py - 16) / 16);
    if (row < 0 || row > 9 || col < 0 || col >= 100) return 0;
    const tileId = this.map[row][col];
    const prop = this.tileProps[tileId];
    if (!prop) return 0;
    if (prop.solid) return 1;
    if (prop.deadly) return 2;
    return 0;
  }

  private isWorldPixelSolid(worldX: number, screenY: number): boolean {
    if (screenY < 16 || screenY >= 176) return true;
    const col = Math.floor(worldX / 16);
    const row = Math.floor((screenY - 16) / 16);
    if (row < 0 || row > 9 || col < 0 || col >= 100) return true;
    const tileId = this.map[row][col];
    return !!this.tileProps[tileId]?.solid;
  }

  private checkDaveClimbable(): boolean {
    const probes: [number, number][] = [
      [2, 2],
      [11, 2],
      [2, 14],
      [11, 14],
    ];
    for (const [dx, dy] of probes) {
      const py = this.dave.y + dy;
      if (py < 16) continue;
      const col = Math.floor((this.dave.x + dx) / 16) + this.scrollX;
      const row = Math.floor((py - 16) / 16);
      if (row >= 0 && row <= 9 && col >= 0 && col < 100) {
        const tileId = this.map[row][col];
        if (this.tileProps[tileId]?.climbable) return true;
      }
    }
    return false;
  }

  /**
   * Checks overlapping tiles for collectibles & exit door (matching 0x3df0 in DAVE.EXE).
   */
  private checkCollectibles(): void {
    const probes: [number, number][] = [
      [3, 3],
      [11, 3],
      [3, 13],
      [11, 13],
    ];

    for (const [dx, dy] of probes) {
      const py = this.dave.y + dy;
      if (py < 16 || py >= 176) continue;
      const col = Math.floor((this.dave.x + dx) / 16) + this.scrollX;
      const row = Math.floor((py - 16) / 16);
      if (row < 0 || row > 9 || col < 0 || col >= 100) continue;

      const tileId = this.map[row][col];
      if (!this.collectibleMap.has(tileId)) continue;

      const pts = this.collectibleMap.get(tileId)!;

      // Door (Tile 2)
      if (tileId === 2) {
        if (this.dave.hasTrophy) {
          this.addScore(pts); // +2000 pts
          this.audio.play(10, true); // NextLevel
          this.onLevelCompleted();
          return;
        }
        continue;
      }

      // Consume tile
      this.map[row][col] = 0;
      this.addScore(pts);

      if (tileId === 10) {
        // Trophy
        this.dave.hasTrophy = true;
        this.audio.play(7, true); // GotTrophy
      } else if (tileId === 4) {
        // Jetpack
        this.dave.jetpackFuel = 255;
        this.audio.play(12, true); // GotSomethng
      } else if (tileId === 20) {
        // Gun
        this.dave.hasGun = true;
        this.audio.play(12, true); // GotSomethng
      } else {
        // Treasures (47..52)
        this.audio.play(6); // Treasure
      }
    }
  }

  private onLevelCompleted(): void {
    if (this.inWarpZone) {
      // Exiting a Warp Zone advances from the level that triggered the warp
      this.inWarpZone = false;
      if (this.currentLevel >= 9) {
        this.state = 'VICTORY';
        return;
      }
      this.transitionX = 0;
      this.state = 'INTERMISSION';
      return;
    }

    if (this.currentLevel >= 9) {
      this.state = 'VICTORY';
      return;
    }

    this.transitionX = 0;
    this.state = 'INTERMISSION';
  }

  private killDave(): void {
    if (this.godMode) return;
    if (this.dave.deadTimer > 0 || this.dave.respawnInvuln > 0) return;
    this.dave.deadTimer = 30;
    this.dave.isJetpacking = false;
    this.dave.isJumping = false;
    this.dave.isClimbing = false;
    this.audio.play(8, true); // explosion
  }

  public step(): void {
    this.tickCount++;
    if (this.tickCount % 3 === 0) {
      this.animTick++;
    }

    if (this.paused || this.helpPage > 0) return;

    if (this.state === 'SCROLLING') {
      this.stepScrolling();
      return;
    }

    if (this.state === 'INTERMISSION') {
      this.stepIntermission();
      return;
    }

    if (this.state === 'WARP_CUTSCENE') {
      this.stepWarpCutscene();
      return;
    }

    if (this.state === 'GAME_OVER') {
      this.transitionTimer--;
      if (this.transitionTimer <= 0) {
        this.checkHighScoreQualification();
      }
      return;
    }

    if (this.state !== 'PLAYING') return;

    this.stepPlaying();
  }

  private stepScrolling(): void {
    // Scroll 2 columns per tick for crisp DOS scrolling
    const step = this.scrollRemaining > 0 ? Math.min(2, this.scrollRemaining) : Math.max(-2, this.scrollRemaining);
    this.scrollX += step;
    this.dave.x -= step * 16;
    if (this.daveBullet.active) {
      this.daveBullet.x -= step * 16;
    }
    for (const fb of this.monsterFireballs) {
      fb.x -= step * 16;
    }
    this.scrollRemaining -= step;
    if (this.scrollRemaining === 0) {
      this.state = 'PLAYING';
    }
  }

  private stepIntermission(): void {
    this.transitionX += 2;
    if (this.tickCount % 2 === 0) {
      this.dave.walkFrame = (this.dave.walkFrame + 1) & 3;
    }
    if (this.transitionX >= 310) {
      this.currentLevel++;
      this.loadLevel(this.currentLevel);
      this.state = 'PLAYING';
    }
  }

  private stepWarpCutscene(): void {
    this.transitionY += 3;
    if (this.transitionY >= 176) {
      const wz = this.data.levels[this.currentLevel].warpZone;
      this.loadLevel(this.currentLevel, {
        mapIdx: wz.targetMapIndex,
        scrollX: wz.scrollX,
        daveX: wz.daveX,
        daveY: wz.daveY,
      });
      this.inWarpZone = true;
      this.state = 'PLAYING';
    }
  }

  private stepPlaying(): void {
    if (this.dave.respawnInvuln > 0) {
      this.dave.respawnInvuln--;
    }

    // Handle Dave death & respawn
    if (this.dave.deadTimer > 0) {
      this.dave.deadTimer--;
      if (this.dave.deadTimer === 0) {
        this.lives--;
        if (this.lives < 0) {
          this.transitionTimer = 45;
          this.state = 'GAME_OVER';
          return;
        }
        // Respawn Dave at a safe nearby position or level start
        const lvlDef = this.data.levels[this.activeMapLevel];
        if (this.inWarpZone) {
          const wz = this.data.levels[this.currentLevel].warpZone;
          this.scrollX = wz.scrollX;
          this.dave.x = wz.daveX;
          this.dave.y = wz.daveY;
        } else {
          this.scrollX = 0;
          this.dave.x = lvlDef.daveStart.x;
          this.dave.y = lvlDef.daveStart.y;
        }
        this.dave.isJumping = false;
        this.dave.isFalling = false;
        this.dave.isClimbing = false;
        this.dave.isJetpacking = false;
        this.dave.respawnInvuln = 25;
      }
      this.stepMonstersAndProjectiles();
      return;
    }

    // Check if Dave is touching climbable trees/stars
    const onClimbable = this.checkDaveClimbable();
    if (onClimbable && (this.keys.up || this.keys.down) && !this.dave.isJetpacking) {
      this.dave.isClimbing = true;
      this.dave.isJumping = false;
      this.dave.isFalling = false;
      this.audio.stopIfPlaying(5);
      this.audio.stopIfPlaying(2);
    } else if (!onClimbable && this.dave.isClimbing) {
      this.dave.isClimbing = false;
    }

    // 1. Jetpack movement
    if (this.dave.isJetpacking) {
      if (!this.godMode) {
        this.dave.jetpackFuel = Math.max(0, this.dave.jetpackFuel - 1);
      }
      if (this.dave.jetpackFuel <= 0) {
        this.dave.isJetpacking = false;
        this.audio.stopIfPlaying(9);
      } else {
        if (this.tickCount % 4 === 0) {
          this.audio.play(9); // Flying!
        }
        if (this.keys.left) {
          this.dave.dir = -1;
          if (this.checkDaveTile(-2, 4) !== 1 && this.checkDaveTile(-2, 12) !== 1) {
            this.dave.x = Math.max(0, this.dave.x - 2);
          }
        } else if (this.keys.right) {
          this.dave.dir = 1;
          if (this.checkDaveTile(13, 4) !== 1 && this.checkDaveTile(13, 12) !== 1) {
            this.dave.x = Math.min(304, this.dave.x + 2);
          }
        }
        if (this.keys.up) {
          if (this.checkDaveTile(2, -2) !== 1 && this.checkDaveTile(11, -2) !== 1) {
            this.dave.y = Math.max(0, this.dave.y - 2);
          }
        } else if (this.keys.down) {
          if (this.checkDaveTile(2, 16) !== 1 && this.checkDaveTile(11, 16) !== 1) {
            this.dave.y = Math.min(168, this.dave.y + 2);
          }
        }
      }
    }
    // 2. Climbing movement (Trees / Stars)
    else if (this.dave.isClimbing) {
      let moved = false;
      if (this.keys.left) {
        this.dave.dir = -1;
        if (this.checkDaveTile(-2, 4) !== 1 && this.checkDaveTile(-2, 12) !== 1) {
          this.dave.x = Math.max(0, this.dave.x - 2);
          moved = true;
        }
      } else if (this.keys.right) {
        this.dave.dir = 1;
        if (this.checkDaveTile(13, 4) !== 1 && this.checkDaveTile(13, 12) !== 1) {
          this.dave.x = Math.min(304, this.dave.x + 2);
          moved = true;
        }
      }
      if (this.keys.up) {
        if (this.checkDaveTile(2, -2) !== 1 && this.checkDaveTile(11, -2) !== 1) {
          this.dave.y = Math.max(0, this.dave.y - 2);
          moved = true;
        }
      } else if (this.keys.down) {
        if (this.checkDaveTile(2, 16) !== 1 && this.checkDaveTile(11, 16) !== 1) {
          this.dave.y = Math.min(168, this.dave.y + 2);
          moved = true;
        }
      }
      if (this.keys.jump && !this.keys.up) {
        this.dave.isClimbing = false;
        this.dave.isJumping = true;
        this.dave.jumpIndex = 0;
        this.audio.play(5);
      }
      if (moved) {
        this.dave.walkFrame = (this.dave.walkFrame + 1) & 3;
        this.audio.play(4); // Walking
      }
    }
    // 3. Normal Walking / Jumping / Falling
    else {
      // Check ground support at feet (dx=3 and dx=10, dy=16)
      const groundL = this.checkDaveTile(3, 16);
      const groundR = this.checkDaveTile(10, 16);
      this.dave.onGround = (groundL === 1 || groundR === 1) && !this.dave.isJumping;

      // Initiate jump
      if (this.dave.onGround && (this.keys.up || this.keys.jump)) {
        if (this.checkDaveTile(4, -1) !== 1 && this.checkDaveTile(9, -1) !== 1) {
          this.dave.isJumping = true;
          this.dave.jumpIndex = 0;
          this.dave.onGround = false;
          this.audio.play(5); // Jumping
        }
      }

      // Horizontal movement
      if (this.keys.left) {
        this.dave.dir = -1;
        if (this.checkDaveTile(-2, 2) !== 1 && this.checkDaveTile(-2, 13) !== 1) {
          this.dave.x = Math.max(0, this.dave.x - 2);
          if (this.dave.onGround) {
            this.dave.walkFrame = (this.dave.walkFrame + 1) & 3;
            this.audio.play(4); // Walking
          }
        }
      } else if (this.keys.right) {
        this.dave.dir = 1;
        if (this.checkDaveTile(13, 2) !== 1 && this.checkDaveTile(13, 13) !== 1) {
          this.dave.x = Math.min(304, this.dave.x + 2);
          if (this.dave.onGround) {
            this.dave.walkFrame = (this.dave.walkFrame + 1) & 3;
            this.audio.play(4); // Walking
          }
        }
      }

      // Vertical jump / gravity using DAVE.EXE jumpTable (DS:0x00bc)
      if (this.dave.isJumping) {
        const jt = this.data.physics.jumpTable;
        if (this.dave.jumpIndex < jt.length) {
          const vy = jt[this.dave.jumpIndex++];
          if (vy < 0) {
            // Moving up: check ceiling at (4, vy) and (9, vy)
            if (this.checkDaveTile(4, vy) === 1 || this.checkDaveTile(9, vy) === 1) {
              this.dave.isJumping = false;
              this.dave.isFalling = true;
              this.audio.play(1, true); // HitWall
            } else {
              this.dave.y += vy;
            }
          } else if (vy > 0) {
            // Moving down during second half of jump arc
            if (this.checkDaveTile(3, 15 + vy) === 1 || this.checkDaveTile(10, 15 + vy) === 1) {
              this.dave.y = (this.dave.y + vy) & ~15;
              this.dave.isJumping = false;
              this.dave.isFalling = false;
              this.dave.onGround = true;
              this.audio.stopIfPlaying(5);
            } else {
              this.dave.y += vy;
            }
          }
        } else {
          this.dave.isJumping = false;
          this.dave.isFalling = true;
        }
      } else if (!this.dave.onGround) {
        // Free-falling at 2px per tick
        if (!this.dave.isFalling) {
          this.dave.isFalling = true;
          this.audio.play(2); // Falling
        }
        const vy = 2;
        if (this.checkDaveTile(3, 15 + vy) === 1 || this.checkDaveTile(10, 15 + vy) === 1) {
          this.dave.y = (this.dave.y + vy) & ~15;
          this.dave.isFalling = false;
          this.dave.onGround = true;
          this.audio.stopIfPlaying(2);
        } else {
          this.dave.y += vy;
        }
      }
    }

    // 4. Check Warp Zone trigger when jumping above top of playfield (Dave_y < 16 at 0x32de)
    if (this.dave.y < 16 && !this.inWarpZone && !this.visitedWarpZones.has(this.currentLevel)) {
      const wz = this.data.levels[this.currentLevel].warpZone;
      if (wz.hasWarp) {
        const atLeftEdge = this.scrollX === 0 && this.dave.x <= 6;
        const atRightEdge = this.scrollX >= 80 && this.dave.x >= 292;
        if (atLeftEdge || atRightEdge) {
          this.jumpToWarpZone(this.currentLevel);
          return;
        }
      }
    }

    // 5. Check deadly hazard tiles (Fire 6..9, Water 25..28, Weirdweeds 36..40)
    if (
      this.checkDaveTile(3, 3) === 2 ||
      this.checkDaveTile(10, 3) === 2 ||
      this.checkDaveTile(3, 13) === 2 ||
      this.checkDaveTile(10, 13) === 2 ||
      this.dave.y > 176
    ) {
      this.killDave();
      return;
    }

    // 6. Check Collectibles & Door
    this.checkCollectibles();
    if (this.state !== 'PLAYING') return;

    // 7. Dave Shooting
    if (this.keys.shoot && this.dave.hasGun && !this.daveBullet.active) {
      this.daveBullet.active = true;
      this.daveBullet.dir = this.dave.dir;
      this.daveBullet.x = this.dave.dir > 0 ? this.dave.x + 16 : this.dave.x - 10;
      this.daveBullet.y = this.dave.y + 7;
    }

    // 8. Step Monsters and Projectiles
    this.stepMonstersAndProjectiles();

    // 9. Trigger Horizontal Screen Scroll (matching 0x44b2..0x4560 in DAVE.EXE)
    if (this.dave.x > 276 && this.scrollX < 80) {
      this.scrollRemaining = Math.min(15, 80 - this.scrollX);
      this.state = 'SCROLLING';
    } else if (this.dave.x < 24 && this.scrollX > 0) {
      this.scrollRemaining = -Math.min(15, this.scrollX);
      this.state = 'SCROLLING';
    }
  }

  private stepMonstersAndProjectiles(): void {
    const lvlDef = this.data.levels[this.activeMapLevel];
    const path = lvlDef.monsterPath;

    // Update Dave's bullet
    if (this.daveBullet.active) {
      this.daveBullet.x += this.daveBullet.dir * 6;
      const worldX = this.daveBullet.x + this.scrollX * 16;
      if (
        this.daveBullet.x < 0 ||
        this.daveBullet.x > 316 ||
        this.isWorldPixelSolid(worldX + (this.daveBullet.dir > 0 ? 10 : 0), this.daveBullet.y)
      ) {
        this.daveBullet.active = false;
      }
    }

    // Update Monster Fireballs
    for (const fb of this.monsterFireballs) {
      if (!fb.active) continue;
      fb.x += fb.dir * 4;
      fb.animFrame = (fb.animFrame + 1) & 3;
      const worldX = fb.x + this.scrollX * 16;
      if (fb.x < 0 || fb.x > 316 || this.isWorldPixelSolid(worldX + (fb.dir > 0 ? 16 : 0), fb.y)) {
        fb.active = false;
        continue;
      }
      // Check hit Dave
      if (
        this.dave.deadTimer === 0 &&
        fb.x + 16 > this.dave.x + 2 &&
        fb.x < this.dave.x + 13 &&
        fb.y + 3 > this.dave.y + 2 &&
        fb.y < this.dave.y + 15
      ) {
        fb.active = false;
        this.killDave();
      }
    }
    this.monsterFireballs = this.monsterFireballs.filter((f) => f.active);

    // Update Monsters
    for (const m of this.monsters) {
      if (!m.active) continue;
      if (m.deadTimer > 0) {
        m.deadTimer--;
        if (m.deadTimer === 0) {
          m.active = false;
        }
        continue;
      }

      // Move along level's monsterPath (stored in first 256 bytes of level record)
      if (path.length > 0) {
        const [dx, dy] = path[m.pathIndex % path.length];
        m.x += dx;
        m.y += dy;
        m.pathIndex = (m.pathIndex + 1) % path.length;
      }

      m.animTimer--;
      if (m.animTimer <= 0) {
        m.animTimer = 3;
        m.animFrame = (m.animFrame + 1) & 3;
      }

      const screenX = m.x - this.scrollX * 16;
      const spMeta = this.data.sprites[m.spriteBase] || { width: 24, height: 20 };

      // Check if on-screen for shooting & collision
      if (screenX > -32 && screenX < 336) {
        // Monster shooting
        m.fireTimer--;
        if (m.fireTimer <= 0 && this.monsterFireballs.length < 2) {
          m.fireTimer = Math.max(18, m.fireReload * 2 + 15);
          const dir = this.dave.x < screenX ? -1 : 1;
          this.monsterFireballs.push({
            active: true,
            x: dir > 0 ? screenX + spMeta.width : screenX - 18,
            y: m.y + Math.floor(spMeta.height / 2),
            dir,
            isMonster: true,
            animFrame: 0,
          });
        }

        // Check collision with Dave's bullet
        if (
          this.daveBullet.active &&
          this.daveBullet.x + 12 > screenX &&
          this.daveBullet.x < screenX + spMeta.width &&
          this.daveBullet.y + 3 > m.y &&
          this.daveBullet.y < m.y + spMeta.height
        ) {
          this.daveBullet.active = false;
          m.deadTimer = 20;
          this.addScore(300);
          this.audio.play(8, true); // explosion
          continue;
        }

        // Check collision with Dave
        if (
          this.dave.deadTimer === 0 &&
          this.dave.x + 13 > screenX + 2 &&
          this.dave.x + 2 < screenX + spMeta.width - 2 &&
          this.dave.y + 15 > m.y + 2 &&
          this.dave.y + 2 < m.y + spMeta.height - 2
        ) {
          m.deadTimer = 20;
          this.killDave();
        }
      }
    }
  }

  private checkHighScoreQualification(): void {
    const lowest = this.highScores[this.highScores.length - 1]?.score ?? 0;
    if (this.score > lowest) {
      this.playerInitials = '';
      this.state = 'HIGH_SCORE_ENTRY';
    } else {
      this.state = 'HIGH_SCORES';
    }
  }

  private commitHighScore(name: string): void {
    this.highScores.push({
      rank: 0,
      score: this.score,
      level: this.currentLevel + 1,
      name: name.padEnd(3, ' ').slice(0, 3),
    });
    this.highScores.sort((a, b) => b.score - a.score);
    this.highScores = this.highScores.slice(0, 5);
    this.highScores.forEach((h, idx) => (h.rank = idx + 1));
    this.saveHighScores();
    this.state = 'HIGH_SCORES';
  }

  // ============================================================================
  // Rendering (320x200 VGA Framebuffer)
  // ============================================================================
  public render(): void {
    this.renderer.clear('#000000');

    if (this.state === 'TITLE') {
      this.renderTitleScreen();
    } else if (this.state === 'INTERMISSION') {
      this.renderIntermission();
    } else if (this.state === 'WARP_CUTSCENE') {
      this.renderWarpCutscene();
    } else if (this.state === 'VICTORY') {
      this.renderVictoryScreen();
    } else if (this.state === 'HIGH_SCORE_ENTRY') {
      this.renderHighScoreEntry();
    } else if (this.state === 'HIGH_SCORES') {
      this.renderHighScoresScreen();
    } else {
      this.renderPlayfieldAndHud();
      if (this.state === 'GAME_OVER') {
        this.renderer.drawWindowBox(13, 10, 13, 3);
        this.renderer.drawText('Game Over', 14 * 8 + 4, 11 * 8);
      }
    }

    if (this.paused && this.state === 'PLAYING') {
      this.renderer.drawWindowBox(8, 10, 24, 3);
      this.renderer.drawText('Press F9 to end pause:', 9 * 8, 11 * 8);
    }

    if (this.helpPage > 0) {
      this.renderHelpOverlay();
    }
  }

  private renderTitleScreen(): void {
    // 4-frame animated "DANGEROUS DAVE" flaming logo (sprites 144..147, 112x47)
    const logoSprite = 144 + (this.animTick & 3);
    this.renderer.drawSprite(logoSprite, 104, 2);

    this.renderer.drawTextCentered('BY JOHN ROMERO', 51);
    this.renderer.drawTextCentered('(C) 1990 SOFTDISK, INC.', 60);

    // Draw the 10x7 title mini-map (0x25ca6) centered at x = 80, y = 72
    const tmap = this.data.titleMap;
    for (let r = 0; r < tmap.length; r++) {
      for (let c = 0; c < tmap[r].length; c++) {
        const tileId = tmap[r][c];
        if (tileId > 0) {
          this.renderer.drawTile(tileId, 80 + c * 16, 72 + r * 16, this.animTick, c, r);
        }
      }
    }

    this.renderer.drawTextCentered('PRESS THE F1 KEY FOR HELP', 188);
    if ((this.animTick & 2) === 0) {
      this.renderer.drawTextCentered('PRESS SPACE TO START', 178);
    }
  }

  private renderPlayfieldAndHud(): void {
    // 1. Top HUD Bar (y = 0..15)
    // SCORE (sprite 133), LEVEL (sprite 134), DAVES (sprite 135)
    this.renderer.drawSprite(133, 0, 2);
    this.renderer.drawHudDigits(this.score, 5, 64, 2);

    this.renderer.drawSprite(134, 118, 2);
    this.renderer.drawHudDigits(this.currentLevel + 1, 2, 174, 2);

    this.renderer.drawSprite(135, 200, 2);
    const displayLives = Math.min(4, this.lives);
    for (let i = 0; i < displayLives; i++) {
      this.renderer.drawSprite(143, 260 + i * 15, 1);
    }

    // Top HUD divider line (light gray #aaaaaa)
    this.renderer.fillRect(0, 14, 320, 2, '#aaaaaa');

    // 2. Playfield Tiles (10 rows x 20 visible columns, y = 16..175)
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 20; c++) {
        const mapCol = this.scrollX + c;
        if (mapCol >= 0 && mapCol < 100) {
          const tileId = this.map[r][mapCol];
          if (tileId > 0) {
            this.renderer.drawTile(tileId, c * 16, 16 + r * 16, this.animTick, mapCol, r);
          }
        }
      }
    }

    // 3. Draw Dave
    if (this.dave.deadTimer > 0) {
      const expSprite = 129 + (this.animTick & 3);
      this.renderer.drawSprite(expSprite, this.dave.x, this.dave.y);
    } else if (this.dave.respawnInvuln % 2 === 0) {
      const daveSprite = this.getDaveSpriteId();
      this.renderer.drawSprite(daveSprite, this.dave.x, this.dave.y);
    }

    // 4. Draw Monsters
    for (const m of this.monsters) {
      if (!m.active) continue;
      const screenX = m.x - this.scrollX * 16;
      if (screenX < -32 || screenX > 320) continue;
      if (m.deadTimer > 0) {
        const expSprite = 129 + (this.animTick & 3);
        this.renderer.drawSprite(expSprite, screenX, m.y);
      } else {
        const frameOffset = [0, 1, 2, 1][m.animFrame & 3];
        this.renderer.drawSprite(m.spriteBase + frameOffset, screenX, m.y);
      }
    }

    // 5. Draw Projectiles
    if (this.daveBullet.active) {
      const bulletSprite = this.daveBullet.dir > 0 ? 127 : 128;
      this.renderer.drawSprite(bulletSprite, this.daveBullet.x, this.daveBullet.y);
    }
    for (const fb of this.monsterFireballs) {
      const base = fb.dir > 0 ? 121 : 124;
      const off = [0, 1, 2, 1][fb.animFrame & 3];
      this.renderer.drawSprite(base + off, fb.x, fb.y);
    }

    // 6. Bottom HUD Bar (y = 176..199)
    this.renderer.fillRect(0, 176, 320, 2, '#aaaaaa');

    if (this.dave.jetpackFuel > 0) {
      // JETPACK label & frame (sprite 139 at x=0, y=183)
      this.renderer.drawSprite(139, 0, 183);
      // Draw fuel ticks (sprite 142, 6x4 px, up to 60 units inside bar)
      const bars = Math.ceil((this.dave.jetpackFuel / 255) * 10);
      for (let b = 0; b < bars; b++) {
        this.renderer.drawSprite(142, 72 + b * 6, 188);
      }
    }

    if (this.dave.hasGun) {
      // GUN icon (sprite 140 at x=248, y=183)
      this.renderer.drawSprite(140, 248, 183);
    }

    if (this.dave.hasTrophy) {
      // "GO THRU THE DOOR!" banner (sprite 138 at x=72, y=184)
      this.renderer.drawSprite(138, 72, 184);
    }
  }

  private getDaveSpriteId(): number {
    if (this.dave.isJetpacking) {
      const seq = this.dave.dir > 0 ? [77, 78, 79, 78] : [80, 81, 82, 81];
      return seq[this.animTick & 3];
    }
    if (this.dave.isClimbing) {
      const seq = [71, 72, 73, 72];
      return seq[this.dave.walkFrame & 3];
    }
    if (this.dave.isJumping || this.dave.isFalling) {
      return this.dave.dir > 0 ? 67 : 68;
    }
    if (!this.keys.left && !this.keys.right) {
      return this.dave.dir > 0 ? 54 : 56;
    }
    const walkSeq = this.dave.dir > 0 ? [53, 54, 55, 54] : [57, 58, 59, 58];
    return walkSeq[this.dave.walkFrame & 3];
  }

  private renderIntermission(): void {
    this.renderTopHudOnly();
    // Draw intermission brick corridor at rows 3 and 5 (y = 64 and y = 96)
    for (let c = 0; c < 20; c++) {
      this.renderer.drawSprite(5, c * 16, 64);
      this.renderer.drawSprite(5, c * 16, 112);
    }
    const remaining = 9 - this.currentLevel;
    if (remaining === 1) {
      this.renderer.drawTextCentered('THIS IS THE LAST LEVEL!!!', 40);
    } else {
      this.renderer.drawTextCentered(`GOOD WORK! ONLY ${remaining} MORE TO GO!`, 40);
    }
    const walkSeq = [53, 54, 55, 54];
    this.renderer.drawSprite(walkSeq[this.dave.walkFrame & 3], this.transitionX, 96);
  }

  private renderWarpCutscene(): void {
    this.renderTopHudOnly();
    const wz = this.data.levels[this.currentLevel].warpZone;
    const wallTile = wz.chuteWallTile || 5;
    for (let r = 0; r < 10; r++) {
      this.renderer.drawSprite(wallTile, 8 * 16, 16 + r * 16);
      this.renderer.drawSprite(wallTile, 10 * 16, 16 + r * 16);
    }
    // Draw "WARP ZONE" sprite (141) on left and right of the chute
    this.renderer.drawSprite(141, 16, 90);
    this.renderer.drawSprite(141, 180, 90);
    // Draw falling Dave (sprite 67)
    this.renderer.drawSprite(67, 9 * 16, 16 + this.transitionY);
  }

  private renderTopHudOnly(): void {
    this.renderer.drawSprite(133, 0, 2);
    this.renderer.drawHudDigits(this.score, 5, 64, 2);
    this.renderer.drawSprite(134, 118, 2);
    this.renderer.drawHudDigits(this.currentLevel + 1, 2, 174, 2);
    this.renderer.drawSprite(135, 200, 2);
    for (let i = 0; i < Math.min(4, this.lives); i++) {
      this.renderer.drawSprite(143, 260 + i * 15, 1);
    }
    this.renderer.fillRect(0, 14, 320, 2, '#aaaaaa');
  }

  private renderVictoryScreen(): void {
    this.renderer.drawWindowBox(2, 2, 36, 20);
    const lines = [
      '         CONGRATULATIONS!',
      '',
      'YOU MADE IT THROUGH ALL THE PERIL-',
      "OUS AREAS IN CLYDE'S HIDEOUT!",
      '',
      'VERY GOOD WORK! DID YOU FIND',
      'THE 4 WARP ZONES? THEY ARE LOCATED',
      'ON LEVELS 5,8,9 AND 10. JUST JUMP',
      'OFF THE TOP OF THE SCREEN AT THE',
      'EXTREME LEFT OR RIGHT EDGE OF THE',
      "WORLD AND VOILA! YOU'RE THERE!",
      '',
      `FINAL SCORE: ${this.score}`,
      '',
      '           PRESS SPACE',
    ];
    lines.forEach((line, i) => {
      this.renderer.drawText(line, 3 * 8, (4 + i) * 8);
    });
  }

  private renderHighScoreEntry(): void {
    this.renderer.drawWindowBox(6, 7, 28, 9);
    this.renderer.drawText('You got a high score!', 9 * 8, 9 * 8);
    this.renderer.drawText(`SCORE: ${this.score}`, 9 * 8, 11 * 8);
    this.renderer.drawText(`ENTER INITIALS: ${this.playerInitials}_`, 9 * 8, 13 * 8);
  }

  private renderHighScoresScreen(): void {
    this.renderer.drawWindowBox(7, 4, 26, 15);
    this.renderer.drawTextCentered('High Scores', 6 * 8);
    this.renderer.drawText('Score  Name  Level', 11 * 8, 8 * 8);
    this.renderer.drawText('-----  ----  -----', 11 * 8, 9 * 8);
    this.highScores.forEach((h, i) => {
      const s = h.score.toString().padStart(5, '0');
      const n = h.name.padEnd(4, ' ');
      const l = h.level.toString().padStart(3, ' ');
      this.renderer.drawText(`${s}   ${n}  ${l}`, 11 * 8, (11 + i) * 8);
    });
    this.renderer.drawTextCentered('PRESS SPACE', 17 * 8);
  }

  private renderHelpOverlay(): void {
    this.renderer.drawWindowBox(5, 3, 30, 19);
    const pages: string[][] = [
      [
        '     DANGEROUS DAVE',
        '',
        'YOU USE THE KEYBOARD,',
        'JOYSTICK OR A MOUSE TO',
        'CONTROL DAVE.',
        '',
        'THESE ARE THE FUNCTION',
        'KEYS THAT ARE AVAILABLE',
        'AT ANY TIME:',
        'F1 = HELP',
        'F3 = RESTART GAME',
        'F9 = PAUSE GAME',
        '',
        '   PRESS SPACE OR ESC',
      ],
      [
        '       DANGEROUS DAVE',
        '',
        'THE OBJECT OF THE GAME IS',
        'TO GUIDE DAVE THROUGH 10',
        "PERILOUS AREAS IN CLYDE'S",
        'HIDEOUT. THERE ARE GUNS &',
        'JETPACKS TO AID YOU.',
        '',
        'CTRL / Z = SHOOT GUN',
        'ALT / X  = JETPACK ON/OFF',
        'ARROWS   = MOVE / JUMP',
        '',
        '   PRESS SPACE OR ESC',
      ],
      [
        '       DANGEROUS DAVE',
        '',
        'WATCH OUT FOR FIRE, WATER',
        'AND WEIRDWEEDS! THESE WILL',
        'TOAST DAVE VERY BLACKLY!',
        'MERELY GRAB THE TROPHY AND',
        "WALK THROUGH THE DOOR. IT'S",
        'THAT SIMPLE! OF COURSE, YOU',
        'MIGHT RUN INTO A FEW (?)',
        'MONSTERS...',
        'ALSO ... THERE ARE A FEW',
        'SECRET WARP ZONES!',
        '',
        '        PRESS SPACE',
      ],
    ];
    const lines = pages[(this.helpPage - 1) % pages.length];
    lines.forEach((line, idx) => {
      this.renderer.drawText(line, 7 * 8, (5 + idx) * 8);
    });
  }
}
