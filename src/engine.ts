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
  deadTimer: number;
  x: number; // world pixel X (0..1599)
  y: number; // screen pixel Y (16..175)
  pathIndex: number;
  pathSubTick: number;
  fireReload: number;
  fireTimer: number;
  spriteBase: number;
  animFrame: number;
  animTimer: number;
}

interface Projectile {
  active: boolean;
  worldX: number; // world pixel X
  y: number; // screen pixel Y
  dir: number; // 1 = right, -1 = left
  isMonster: boolean;
  animFrame: number;
}

interface Particle {
  x: number; // world X
  y: number; // screen Y
  vx: number;
  vy: number;
  color: string;
  size: number;
  life: number;
  maxLife: number;
  gravity: number;
}

interface FloatingText {
  x: number; // world X
  y: number; // screen Y
  text: string;
  color: string;
  life: number;
  maxLife: number;
}

interface Afterimage {
  worldX: number;
  y: number;
  spriteId: number;
  alpha: number;
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

  // Combo system
  public comboCount = 0;
  public comboTimer = 0;

  // Map runtime state (10 rows x 100 cols)
  public map: number[][] = [];
  public scrollX = 0; // 0..80 (in tiles, synced with cameraX)
  public cameraX = 0; // 0..1280 (smooth sub-pixel camera in world pixels)
  private minCameraX = 0;

  // Dave state (60Hz continuous physics + classic compatibility fields)
  public dave = {
    x: 32, // screen-relative X (0..304)
    worldX: 32, // continuous world X (0..1584)
    y: 144, // continuous Y (0..199, playfield starts at 16)
    vx: 0,
    vy: 0,
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
    walkTimer: 0,
    deadTimer: 0, // >0 when exploding
    respawnInvuln: 0,
    onGround: true,
    // Modern agility mechanics
    coyoteTimer: 0,
    jumpBufferTimer: 0,
    dashTimer: 0,
    dashCooldown: 0,
    maxDashCooldown: 40,
    scaleX: 1,
    scaleY: 1,
  };

  public monsters: ActiveMonster[] = [];
  public daveBullet: Projectile = { active: false, worldX: 0, y: 0, dir: 1, isMonster: false, animFrame: 0 };
  public monsterFireballs: Projectile[] = [];

  // Visual effects
  public particles: Particle[] = [];
  public floatingTexts: FloatingText[] = [];
  public afterimages: Afterimage[] = [];
  public shakeTimer = 0;
  public shakeIntensity = 0;

  // Input state
  public keys = {
    left: false,
    right: false,
    up: false,
    down: false,
    jump: false,
    shoot: false,
    dash: false,
  };

  // Animation & transition counters (60Hz fineTick + ~15Hz classic animTick)
  public fineTick = 0;
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
      jetpackFuel: Math.floor(this.dave.jetpackFuel),
      inWarpZone: this.inWarpZone,
      daveX: Math.floor(this.dave.x),
      daveY: Math.floor(this.dave.y),
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
    this.cameraX = slot.scrollX * 16;
    this.dave.x = slot.daveX;
    this.dave.worldX = this.cameraX + slot.daveX;
    this.dave.y = slot.daveY;
    this.dave.hasGun = slot.hasGun;
    this.dave.hasTrophy = slot.hasTrophy;
    this.dave.jetpackFuel = slot.jetpackFuel;
    this.state = 'PLAYING';
  }

  public startNewGame(startLevel = 0): void {
    this.audio.stop();
    this.audio.startBgm();
    this.score = 0;
    this.nextExtraLifeScore = 20000;
    this.lives = 3;
    this.currentLevel = startLevel;
    this.inWarpZone = false;
    this.visitedWarpZones.clear();
    this.comboCount = 0;
    this.comboTimer = 0;
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
      this.minCameraX = warpOverride.scrollX * 16;
      this.cameraX = this.minCameraX;
      this.dave.x = warpOverride.daveX;
      this.dave.worldX = this.cameraX + warpOverride.daveX;
      this.dave.y = warpOverride.daveY;
      this.dave.dir = 1;
    } else {
      this.scrollX = 0;
      this.minCameraX = 0;
      this.cameraX = 0;
      this.dave.x = lvlDef.daveStart.x;
      this.dave.worldX = lvlDef.daveStart.x;
      this.dave.y = lvlDef.daveStart.y;
      this.dave.dir = 1;
      this.inWarpZone = false;
    }

    this.dave.vx = 0;
    this.dave.vy = 0;
    this.dave.isJumping = false;
    this.dave.jumpIndex = 0;
    this.dave.isFalling = false;
    this.dave.isClimbing = false;
    this.dave.isJetpacking = false;
    this.dave.hasTrophy = false;
    this.dave.deadTimer = 0;
    this.dave.walkFrame = 0;
    this.dave.walkTimer = 0;
    this.dave.onGround = true;
    this.dave.coyoteTimer = 0;
    this.dave.jumpBufferTimer = 0;
    this.dave.dashTimer = 0;
    this.dave.dashCooldown = 0;
    this.dave.scaleX = 1;
    this.dave.scaleY = 1;

    this.daveBullet.active = false;
    this.monsterFireballs = [];
    this.particles = [];
    this.floatingTexts = [];
    this.afterimages = [];

    // Spawn monsters from level definition
    this.monsters = lvlDef.monsters.map((m, i) => ({
      active: true,
      deadTimer: 0,
      x: m.x,
      y: m.y,
      pathIndex: m.pathIndex,
      pathSubTick: 0,
      fireReload: m.fireReload,
      fireTimer: (m.fireReload + i * 6) * 4,
      spriteBase: m.spriteBase,
      animFrame: i % 3,
      animTimer: 8,
    }));
  }

  public jumpToWarpZone(fromLevelIdx: number): void {
    const wz = this.data.levels[fromLevelIdx].warpZone;
    if (!wz.hasWarp) return;
    this.currentLevel = fromLevelIdx;
    this.inWarpZone = true;
    this.visitedWarpZones.add(fromLevelIdx);
    this.transitionY = 0;
    this.audio.play(10, true);
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
      this.dave.vy = 0;
      this.audio.play(11); // ToJetpack
    }
  }

  public triggerDash(): void {
    if (this.state !== 'PLAYING' || this.dave.deadTimer > 0) return;
    if (this.dave.dashCooldown > 0 || this.dave.dashTimer > 0) return;

    this.dave.dashTimer = 11;
    this.dave.dashCooldown = this.dave.maxDashCooldown;
    this.dave.vy = 0;
    this.dave.isJumping = false;
    this.dave.scaleX = 1.28;
    this.dave.scaleY = 0.78;
    this.audio.playDash();

    // Burst of cyan dash particles
    this.spawnParticles(this.dave.worldX + 8, this.dave.y + 8, 12, '#00f0ff', 2.4, 0);
  }

  public handleKeyDown(e: KeyboardEvent): void {
    this.audio.startBgm();

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

    // Jump Buffer on key press
    if ((e.code === 'ArrowUp' || e.code === 'KeyW' || e.code === 'Space') && !e.repeat) {
      this.dave.jumpBufferTimer = 7;
    }

    // Dash on KeyC or Shift
    if ((e.code === 'KeyC' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') && !e.repeat) {
      e.preventDefault();
      this.triggerDash();
      return;
    }

    // Jetpack toggle on Alt or KeyX
    if ((e.code === 'AltLeft' || e.code === 'AltRight' || e.code === 'KeyX') && !e.repeat) {
      e.preventDefault();
      this.toggleJetpack();
    }
  }

  private addScore(pts: number, worldX?: number, screenY?: number, labelOverride?: string): void {
    if (pts <= 0) return;
    this.score += pts;
    if (this.score >= this.nextExtraLifeScore) {
      this.lives = Math.min(9, this.lives + 1);
      this.nextExtraLifeScore += 20000;
      if (worldX !== undefined && screenY !== undefined) {
        this.spawnFloatingText(worldX, screenY - 10, '1UP!', '#39ff14');
      }
    }
    if (worldX !== undefined && screenY !== undefined) {
      const text = labelOverride ?? `+${pts}`;
      const color = pts >= 1000 ? '#ffd700' : pts >= 300 ? '#ff44cc' : '#00f0ff';
      this.spawnFloatingText(worldX, screenY, text, color);
    }
  }

  public spawnParticles(
    worldX: number,
    y: number,
    count: number,
    color: string,
    speed = 1.8,
    gravity = 0.06
  ): void {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = (0.3 + Math.random() * 0.7) * speed;
      this.particles.push({
        x: worldX,
        y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd - (gravity > 0 ? 0.5 : 0),
        color,
        size: Math.random() > 0.4 ? 2 : 1,
        life: 18 + Math.floor(Math.random() * 18),
        maxLife: 36,
        gravity,
      });
    }
  }

  public spawnFloatingText(worldX: number, y: number, text: string, color = '#ffd700'): void {
    this.floatingTexts.push({
      x: worldX,
      y,
      text,
      color,
      life: 42,
      maxLife: 42,
    });
  }

  public triggerShake(frames = 14, intensity = 3.5): void {
    this.shakeTimer = frames;
    this.shakeIntensity = intensity;
  }

  /**
   * Checks tile collision at offset (dx, dy) from Dave's top-left corner (worldX, y).
   * Returns 0 (passable), 1 (solid wall/floor), or 2 (deadly fire/water/weeds).
   */
  private checkDaveTileWorld(worldX: number, y: number, dx: number, dy: number): number {
    const py = y + dy;
    if (py < 16) return 0;
    const col = Math.floor((worldX + dx) / 16);
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
      const col = Math.floor((this.dave.worldX + dx) / 16);
      const row = Math.floor((py - 16) / 16);
      if (row >= 0 && row <= 9 && col >= 0 && col < 100) {
        const tileId = this.map[row][col];
        if (this.tileProps[tileId]?.climbable) return true;
      }
    }
    return false;
  }

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
      const col = Math.floor((this.dave.worldX + dx) / 16);
      const row = Math.floor((py - 16) / 16);
      if (row < 0 || row > 9 || col < 0 || col >= 100) continue;

      const tileId = this.map[row][col];
      if (!this.collectibleMap.has(tileId)) continue;

      const basePts = this.collectibleMap.get(tileId)!;
      const tileWorldX = col * 16 + 8;
      const tileScreenY = 16 + row * 16 + 8;

      // Door (Tile 2)
      if (tileId === 2) {
        if (this.dave.hasTrophy) {
          this.addScore(basePts, tileWorldX, tileScreenY, 'STAGE CLEAR!');
          this.audio.play(10, true); // NextLevel
          this.onLevelCompleted();
          return;
        }
        continue;
      }

      // Consume tile
      this.map[row][col] = 0;

      // Combo multiplier for consecutive pickups
      if (this.comboTimer > 0) {
        this.comboCount = Math.min(8, this.comboCount + 1);
      } else {
        this.comboCount = 1;
      }
      this.comboTimer = 150; // 2.5 seconds at 60Hz

      const bonusMult = this.comboCount > 1 ? 1 + (this.comboCount - 1) * 0.25 : 1;
      const finalPts = Math.round(basePts * bonusMult);

      if (tileId === 10) {
        // Trophy
        this.dave.hasTrophy = true;
        this.addScore(finalPts, tileWorldX, tileScreenY, 'TROPHY! GO TO DOOR!');
        this.spawnParticles(tileWorldX, tileScreenY, 24, '#ffd700', 2.8, 0.04);
        this.triggerShake(8, 2.0);
        this.audio.play(7, true); // GotTrophy
      } else if (tileId === 4) {
        // Jetpack
        this.dave.jetpackFuel = 255;
        this.addScore(finalPts, tileWorldX, tileScreenY, 'JETPACK FULL!');
        this.spawnParticles(tileWorldX, tileScreenY, 18, '#00e5ff', 2.4, 0.04);
        this.audio.play(12, true); // GotSomethng
      } else if (tileId === 20) {
        // Gun
        this.dave.hasGun = true;
        this.addScore(finalPts, tileWorldX, tileScreenY, 'LASER BLASTER!');
        this.spawnParticles(tileWorldX, tileScreenY, 18, '#ff44cc', 2.4, 0.04);
        this.audio.play(12, true); // GotSomethng
      } else {
        // Treasures (47..52)
        const label = this.comboCount > 1 ? `+${finalPts} (x${this.comboCount})` : `+${finalPts}`;
        this.addScore(finalPts, tileWorldX, tileScreenY, label);
        this.spawnParticles(tileWorldX, tileScreenY, 14, '#00f0ff', 2.1, 0.05);
        this.audio.play(6, false, this.comboCount); // Treasure with combo pitch
      }
    }
  }

  private onLevelCompleted(): void {
    if (this.inWarpZone) {
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
    this.dave.deadTimer = 65; // ~1.1 sec at 60Hz
    this.dave.isJetpacking = false;
    this.dave.isJumping = false;
    this.dave.isClimbing = false;
    this.dave.dashTimer = 0;
    this.spawnParticles(this.dave.worldX + 8, this.dave.y + 8, 28, '#ff5522', 3.2, 0.07);
    this.spawnParticles(this.dave.worldX + 8, this.dave.y + 8, 14, '#ffd700', 2.4, 0.04);
    this.triggerShake(18, 4.5);
    this.audio.play(8, true); // explosion
  }

  /**
   * 60Hz Main Logic Step.
   */
  public step(): void {
    this.fineTick++;
    if (this.fineTick % 4 === 0) {
      this.tickCount++;
      if (this.tickCount % 3 === 0) {
        this.animTick++;
      }
    }

    if (this.shakeTimer > 0) {
      this.shakeTimer--;
    }

    if (this.paused || this.helpPage > 0) return;

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

    this.stepPlaying60Hz();
  }

  private stepIntermission(): void {
    this.transitionX += 1.4;
    if (this.fineTick % 6 === 0) {
      this.dave.walkFrame = (this.dave.walkFrame + 1) & 3;
    }
    if (this.transitionX >= 310) {
      this.currentLevel++;
      this.loadLevel(this.currentLevel);
      this.state = 'PLAYING';
    }
  }

  private stepWarpCutscene(): void {
    this.transitionY += 1.6;
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

  private stepPlaying60Hz(): void {
    // Update timers
    if (this.dave.respawnInvuln > 0) this.dave.respawnInvuln--;
    if (this.dave.coyoteTimer > 0) this.dave.coyoteTimer--;
    if (this.dave.jumpBufferTimer > 0) this.dave.jumpBufferTimer--;
    if (this.dave.dashCooldown > 0) this.dave.dashCooldown--;
    if (this.comboTimer > 0) {
      this.comboTimer--;
      if (this.comboTimer === 0) this.comboCount = 0;
    }

    // Relax squash & stretch back to (1, 1)
    this.dave.scaleX += (1 - this.dave.scaleX) * 0.22;
    this.dave.scaleY += (1 - this.dave.scaleY) * 0.22;

    // Update visual effects
    this.stepEffects();

    // Handle Dave death & respawn
    if (this.dave.deadTimer > 0) {
      this.dave.deadTimer--;
      if (this.dave.deadTimer === 0) {
        this.lives--;
        if (this.lives < 0) {
          this.transitionTimer = 110;
          this.state = 'GAME_OVER';
          return;
        }
        const lvlDef = this.data.levels[this.activeMapLevel];
        if (this.inWarpZone) {
          const wz = this.data.levels[this.currentLevel].warpZone;
          this.scrollX = wz.scrollX;
          this.cameraX = wz.scrollX * 16;
          this.dave.x = wz.daveX;
          this.dave.worldX = this.cameraX + wz.daveX;
          this.dave.y = wz.daveY;
        } else {
          this.scrollX = 0;
          this.cameraX = 0;
          this.dave.x = lvlDef.daveStart.x;
          this.dave.worldX = lvlDef.daveStart.x;
          this.dave.y = lvlDef.daveStart.y;
        }
        this.dave.vx = 0;
        this.dave.vy = 0;
        this.dave.isJumping = false;
        this.dave.isFalling = false;
        this.dave.isClimbing = false;
        this.dave.isJetpacking = false;
        this.dave.respawnInvuln = 75;
      }
      this.stepMonstersAndProjectiles60Hz();
      return;
    }

    // Check climbable trees/stars
    const onClimbable = this.checkDaveClimbable();
    if (onClimbable && (this.keys.up || this.keys.down) && !this.dave.isJetpacking && this.dave.dashTimer === 0) {
      this.dave.isClimbing = true;
      this.dave.isJumping = false;
      this.dave.isFalling = false;
      this.dave.vy = 0;
    } else if (!onClimbable && this.dave.isClimbing) {
      this.dave.isClimbing = false;
    }

    // 0. Dash Movement Override (High-speed horizontal burst with afterimages)
    if (this.dave.dashTimer > 0) {
      this.dave.dashTimer--;
      const dashSpeed = 4.2 * this.dave.dir;
      this.moveDaveHorizontal(dashSpeed);

      if (this.fineTick % 2 === 0) {
        this.afterimages.push({
          worldX: this.dave.worldX,
          y: this.dave.y,
          spriteId: this.getDaveSpriteId(),
          alpha: 0.9,
        });
      }
    }
    // 1. Jetpack movement (Smooth 60Hz flight + thruster flames)
    else if (this.dave.isJetpacking) {
      if (!this.godMode) {
        this.dave.jetpackFuel = Math.max(0, this.dave.jetpackFuel - 0.25);
      }
      if (this.dave.jetpackFuel <= 0) {
        this.dave.isJetpacking = false;
        this.audio.stopIfPlaying(9);
      } else {
        if (this.fineTick % 10 === 0) {
          this.audio.play(9); // Thruster sound
        }
        // Spawn jetpack flame particles
        if (this.fineTick % 2 === 0) {
          const tailX = this.dave.dir > 0 ? this.dave.worldX + 2 : this.dave.worldX + 12;
          this.particles.push({
            x: tailX + (Math.random() * 2 - 1),
            y: this.dave.y + 14,
            vx: -this.dave.dir * 0.4 + (Math.random() * 0.4 - 0.2),
            vy: 1.2 + Math.random() * 0.8,
            color: Math.random() > 0.4 ? '#ff8800' : '#00e5ff',
            size: 2,
            life: 12,
            maxLife: 12,
            gravity: 0.02,
          });
        }

        const flySpeed = 1.65;
        if (this.keys.left) {
          this.dave.dir = -1;
          this.moveDaveHorizontal(-flySpeed);
        } else if (this.keys.right) {
          this.dave.dir = 1;
          this.moveDaveHorizontal(flySpeed);
        }
        if (this.keys.up) {
          this.moveDaveVertical(-1.55);
        } else if (this.keys.down) {
          this.moveDaveVertical(1.55);
        }
      }
    }
    // 2. Climbing movement
    else if (this.dave.isClimbing) {
      let moved = false;
      const climbSpeed = 1.35;
      if (this.keys.left) {
        this.dave.dir = -1;
        moved = this.moveDaveHorizontal(-climbSpeed) || moved;
      } else if (this.keys.right) {
        this.dave.dir = 1;
        moved = this.moveDaveHorizontal(climbSpeed) || moved;
      }
      if (this.keys.up) {
        moved = this.moveDaveVertical(-climbSpeed) || moved;
      } else if (this.keys.down) {
        moved = this.moveDaveVertical(climbSpeed) || moved;
      }
      if (this.dave.jumpBufferTimer > 0 && !this.keys.up) {
        this.dave.isClimbing = false;
        this.initiateJump();
      }
      if (moved) {
        this.dave.walkTimer++;
        if (this.dave.walkTimer >= 5) {
          this.dave.walkTimer = 0;
          this.dave.walkFrame = (this.dave.walkFrame + 1) & 3;
          this.audio.play(4);
        }
      }
    }
    // 3. Agile 60Hz Walking / Jumping / Falling with Coyote Time & Jump Buffering
    else {
      const groundL = this.checkDaveTileWorld(this.dave.worldX, this.dave.y, 3, 16);
      const groundR = this.checkDaveTileWorld(this.dave.worldX, this.dave.y, 10, 16);
      const isSupported = (groundL === 1 || groundR === 1) && this.dave.vy >= 0;

      if (isSupported) {
        if (!this.dave.onGround && this.dave.vy > 1.2) {
          // Landed! Squash & dust puff
          this.dave.scaleX = 1.22;
          this.dave.scaleY = 0.8;
          this.spawnParticles(this.dave.worldX + 7, this.dave.y + 15, 5, '#cbd5e1', 1.1, 0.03);
        }
        this.dave.onGround = true;
        this.dave.isJumping = false;
        this.dave.isFalling = false;
        this.dave.vy = 0;
        this.dave.coyoteTimer = 7; // 7 frames Coyote Time
      } else {
        this.dave.onGround = false;
      }

      // Check Jump initiation (onGround OR Coyote Time) + (Jump Buffer OR holding Up/Jump)
      const wantsJump = this.dave.jumpBufferTimer > 0 || this.keys.up || this.keys.jump;
      if ((this.dave.onGround || this.dave.coyoteTimer > 0) && wantsJump) {
        if (
          this.checkDaveTileWorld(this.dave.worldX, this.dave.y, 4, -2) !== 1 &&
          this.checkDaveTileWorld(this.dave.worldX, this.dave.y, 9, -2) !== 1
        ) {
          this.initiateJump();
        }
      }

      // Smooth Horizontal Acceleration & Deceleration
      const maxRunSpeed = 1.85;
      const accel = this.dave.onGround ? 0.45 : 0.32;
      const friction = this.dave.onGround ? 0.55 : 0.82;

      if (this.keys.left) {
        this.dave.dir = -1;
        this.dave.vx = Math.max(-maxRunSpeed, this.dave.vx - accel);
      } else if (this.keys.right) {
        this.dave.dir = 1;
        this.dave.vx = Math.min(maxRunSpeed, this.dave.vx + accel);
      } else {
        this.dave.vx *= friction;
        if (Math.abs(this.dave.vx) < 0.08) this.dave.vx = 0;
      }

      if (Math.abs(this.dave.vx) > 0) {
        const movedX = this.moveDaveHorizontal(this.dave.vx);
        if (movedX && this.dave.onGround) {
          this.dave.walkTimer++;
          if (this.dave.walkTimer >= 5) {
            this.dave.walkTimer = 0;
            this.dave.walkFrame = (this.dave.walkFrame + 1) & 3;
            this.audio.play(4); // Footstep
          }
        }
      }

      // Continuous Vertical Physics (calibrated to match 50px 3-tile jump apex of DAVE.EXE)
      if (!this.dave.onGround) {
        const holdingJump = this.keys.up || this.keys.jump;
        // Variable jump height: higher gravity if jump released early while moving up
        const gravity = this.dave.vy < 0 && !holdingJump ? 0.24 : 0.108;
        this.dave.vy = Math.min(2.6, this.dave.vy + gravity);

        if (this.dave.vy < 0) {
          // Moving up: check ceiling
          if (
            this.checkDaveTileWorld(this.dave.worldX, this.dave.y, 4, this.dave.vy) === 1 ||
            this.checkDaveTileWorld(this.dave.worldX, this.dave.y, 9, this.dave.vy) === 1
          ) {
            this.dave.vy = 0;
            this.dave.isJumping = false;
            this.dave.isFalling = true;
            this.audio.play(1, true); // HitWall
          } else {
            this.dave.y += this.dave.vy;
          }
        } else if (this.dave.vy > 0) {
          // Moving down: check floor
          this.dave.isFalling = true;
          if (
            this.checkDaveTileWorld(this.dave.worldX, this.dave.y, 3, 15 + this.dave.vy) === 1 ||
            this.checkDaveTileWorld(this.dave.worldX, this.dave.y, 10, 15 + this.dave.vy) === 1
          ) {
            this.dave.y = Math.floor((this.dave.y + this.dave.vy) / 16) * 16;
            this.dave.scaleX = 1.2;
            this.dave.scaleY = 0.82;
            this.spawnParticles(this.dave.worldX + 7, this.dave.y + 15, 5, '#cbd5e1', 1.1, 0.03);
            this.dave.vy = 0;
            this.dave.isJumping = false;
            this.dave.isFalling = false;
            this.dave.onGround = true;
          } else {
            this.dave.y += this.dave.vy;
          }
        }
      }
    }

    // 4. Smooth Camera Follow (lerps toward Dave without pausing gameplay)
    const targetCamX = Math.max(this.minCameraX, Math.min(1280, this.dave.worldX - 144));
    this.cameraX += (targetCamX - this.cameraX) * 0.16;
    if (Math.abs(targetCamX - this.cameraX) < 0.2) this.cameraX = targetCamX;
    this.scrollX = Math.floor(this.cameraX / 16);
    this.dave.x = this.dave.worldX - this.cameraX;

    // 5. Check Warp Zone trigger when jumping above top of playfield (Dave_y < 16)
    if (this.dave.y < 16 && !this.inWarpZone && !this.visitedWarpZones.has(this.currentLevel)) {
      const wz = this.data.levels[this.currentLevel].warpZone;
      if (wz.hasWarp) {
        const atLeftEdge = this.dave.worldX <= 24;
        const atRightEdge = this.dave.worldX >= 1556;
        if (atLeftEdge || atRightEdge) {
          this.jumpToWarpZone(this.currentLevel);
          return;
        }
      }
    }

    // 6. Check deadly hazard tiles (Fire 6..9, Water 25..28, Weirdweeds 36..40)
    if (
      this.checkDaveTileWorld(this.dave.worldX, this.dave.y, 3, 3) === 2 ||
      this.checkDaveTileWorld(this.dave.worldX, this.dave.y, 10, 3) === 2 ||
      this.checkDaveTileWorld(this.dave.worldX, this.dave.y, 3, 13) === 2 ||
      this.checkDaveTileWorld(this.dave.worldX, this.dave.y, 10, 13) === 2 ||
      this.dave.y > 176
    ) {
      this.killDave();
      return;
    }

    // 7. Check Collectibles & Door
    this.checkCollectibles();
    if (this.state !== 'PLAYING') return;

    // 8. Dave Shooting (Modern Laser Blaster)
    if (this.keys.shoot && this.dave.hasGun && !this.daveBullet.active) {
      this.daveBullet.active = true;
      this.daveBullet.dir = this.dave.dir;
      this.daveBullet.worldX = this.dave.dir > 0 ? this.dave.worldX + 14 : this.dave.worldX - 8;
      this.daveBullet.y = this.dave.y + 6;
      this.audio.playShoot();
      this.spawnParticles(this.daveBullet.worldX, this.daveBullet.y + 2, 6, '#00f0ff', 1.6, 0);
    }

    // 9. Step Monsters and Projectiles
    this.stepMonstersAndProjectiles60Hz();
  }

  private initiateJump(): void {
    this.dave.isJumping = true;
    this.dave.onGround = false;
    this.dave.coyoteTimer = 0;
    this.dave.jumpBufferTimer = 0;
    this.dave.vy = -3.32; // Reaches ~51px height (3.2 tiles), matching DAVE.EXE jumpTable
    this.dave.scaleX = 0.82;
    this.dave.scaleY = 1.2;
    this.spawnParticles(this.dave.worldX + 7, this.dave.y + 15, 6, '#e2e8f0', 1.2, 0.02);
    this.audio.play(5); // Jump sound
  }

  private moveDaveHorizontal(dx: number): boolean {
    if (dx < 0) {
      if (
        this.checkDaveTileWorld(this.dave.worldX + dx, this.dave.y, 1, 2) !== 1 &&
        this.checkDaveTileWorld(this.dave.worldX + dx, this.dave.y, 1, 13) !== 1
      ) {
        this.dave.worldX = Math.max(this.minCameraX, this.dave.worldX + dx);
        return true;
      }
      this.dave.vx = 0;
      return false;
    } else if (dx > 0) {
      if (
        this.checkDaveTileWorld(this.dave.worldX + dx, this.dave.y, 12, 2) !== 1 &&
        this.checkDaveTileWorld(this.dave.worldX + dx, this.dave.y, 12, 13) !== 1
      ) {
        this.dave.worldX = Math.min(1584, this.dave.worldX + dx);
        return true;
      }
      this.dave.vx = 0;
      return false;
    }
    return false;
  }

  private moveDaveVertical(dy: number): boolean {
    if (dy < 0) {
      if (
        this.checkDaveTileWorld(this.dave.worldX, this.dave.y + dy, 2, 0) !== 1 &&
        this.checkDaveTileWorld(this.dave.worldX, this.dave.y + dy, 11, 0) !== 1
      ) {
        this.dave.y = Math.max(0, this.dave.y + dy);
        return true;
      }
      return false;
    } else if (dy > 0) {
      if (
        this.checkDaveTileWorld(this.dave.worldX, this.dave.y + dy, 2, 15) !== 1 &&
        this.checkDaveTileWorld(this.dave.worldX, this.dave.y + dy, 11, 15) !== 1
      ) {
        this.dave.y = Math.min(168, this.dave.y + dy);
        return true;
      }
      return false;
    }
    return false;
  }

  private stepMonstersAndProjectiles60Hz(): void {
    const lvlDef = this.data.levels[this.activeMapLevel];
    const path = lvlDef.monsterPath;

    // Update Dave's bullet
    if (this.daveBullet.active) {
      this.daveBullet.worldX += this.daveBullet.dir * 3.8;
      if (this.fineTick % 2 === 0) {
        this.particles.push({
          x: this.daveBullet.worldX + 4,
          y: this.daveBullet.y + 2,
          vx: -this.daveBullet.dir * 0.5,
          vy: (Math.random() - 0.5) * 0.4,
          color: '#00f0ff',
          size: 1.5,
          life: 10,
          maxLife: 10,
          gravity: 0,
        });
      }
      const screenX = this.daveBullet.worldX - this.cameraX;
      if (
        screenX < -16 ||
        screenX > 336 ||
        this.isWorldPixelSolid(this.daveBullet.worldX + (this.daveBullet.dir > 0 ? 10 : 0), this.daveBullet.y)
      ) {
        this.spawnParticles(this.daveBullet.worldX, this.daveBullet.y + 2, 8, '#00f0ff', 1.8, 0.04);
        this.daveBullet.active = false;
      }
    }

    // Update Monster Fireballs
    for (const fb of this.monsterFireballs) {
      if (!fb.active) continue;
      fb.worldX += fb.dir * 2.1;
      if (this.fineTick % 3 === 0) {
        fb.animFrame = (fb.animFrame + 1) & 3;
      }
      const screenX = fb.worldX - this.cameraX;
      if (screenX < -24 || screenX > 344 || this.isWorldPixelSolid(fb.worldX + (fb.dir > 0 ? 14 : 0), fb.y)) {
        fb.active = false;
        this.spawnParticles(fb.worldX, fb.y + 2, 6, '#ff6600', 1.4, 0.03);
        continue;
      }
      // Hit Dave (unless Dashing!)
      if (
        this.dave.deadTimer === 0 &&
        this.dave.dashTimer === 0 &&
        fb.worldX + 14 > this.dave.worldX + 2 &&
        fb.worldX < this.dave.worldX + 12 &&
        fb.y + 4 > this.dave.y + 2 &&
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

      // Move smoothly along level's monsterPath (quarter-step per 60Hz frame = exact DOS speed)
      if (path.length > 0) {
        const [dx, dy] = path[m.pathIndex % path.length];
        m.x += dx * 0.26;
        m.y += dy * 0.26;
        m.pathSubTick++;
        if (m.pathSubTick >= 4) {
          m.pathSubTick = 0;
          m.pathIndex = (m.pathIndex + 1) % path.length;
        }
      }

      m.animTimer--;
      if (m.animTimer <= 0) {
        m.animTimer = 10;
        m.animFrame = (m.animFrame + 1) & 3;
      }

      const screenX = m.x - this.cameraX;
      const spMeta = this.data.sprites[m.spriteBase] || { width: 24, height: 20 };

      // Check if on-screen for shooting & collision
      if (screenX > -32 && screenX < 336) {
        m.fireTimer--;
        if (m.fireTimer <= 0 && this.monsterFireballs.length < 2) {
          m.fireTimer = Math.max(70, (m.fireReload * 2 + 15) * 4);
          const dir = this.dave.worldX < m.x ? -1 : 1;
          this.monsterFireballs.push({
            active: true,
            worldX: dir > 0 ? m.x + spMeta.width : m.x - 16,
            y: m.y + Math.floor(spMeta.height / 2),
            dir,
            isMonster: true,
            animFrame: 0,
          });
        }

        // Check collision with Dave's bullet
        if (
          this.daveBullet.active &&
          this.daveBullet.worldX + 12 > m.x &&
          this.daveBullet.worldX < m.x + spMeta.width &&
          this.daveBullet.y + 4 > m.y &&
          this.daveBullet.y < m.y + spMeta.height
        ) {
          this.daveBullet.active = false;
          m.deadTimer = 45;
          this.addScore(300, m.x + 10, m.y, '+300 KILL!');
          this.spawnParticles(m.x + spMeta.width / 2, m.y + spMeta.height / 2, 24, '#ff4422', 2.8, 0.06);
          this.triggerShake(12, 3.0);
          this.audio.play(8, true); // explosion
          continue;
        }

        // Check collision with Dave
        if (
          this.dave.deadTimer === 0 &&
          this.dave.x + 12 > screenX + 2 &&
          this.dave.x + 2 < screenX + spMeta.width - 2 &&
          this.dave.y + 15 > m.y + 2 &&
          this.dave.y + 2 < m.y + spMeta.height - 2
        ) {
          m.deadTimer = 45;
          this.spawnParticles(m.x + spMeta.width / 2, m.y + spMeta.height / 2, 20, '#ff4422', 2.5, 0.06);
          this.killDave();
        }
      }
    }
  }

  private stepEffects(): void {
    // Ambient fire & trophy sparkles on visible screen
    if (this.fineTick % 5 === 0 && this.renderer.style === 'MODERN') {
      const startCol = Math.max(0, Math.floor(this.cameraX / 16));
      const endCol = Math.min(99, startCol + 21);
      for (let r = 0; r < 10; r++) {
        for (let c = startCol; c <= endCol; c++) {
          const t = this.map[r]?.[c];
          if (t === 6 && Math.random() < 0.22) {
            this.particles.push({
              x: c * 16 + 3 + Math.random() * 10,
              y: 16 + r * 16 + 6,
              vx: (Math.random() - 0.5) * 0.3,
              vy: -0.4 - Math.random() * 0.6,
              color: Math.random() > 0.5 ? '#ff7700' : '#ffcc00',
              size: 1.5,
              life: 22,
              maxLife: 22,
              gravity: -0.01,
            });
          } else if (t === 10 && Math.random() < 0.25) {
            this.particles.push({
              x: c * 16 + 2 + Math.random() * 12,
              y: 16 + r * 16 + 2 + Math.random() * 12,
              vx: (Math.random() - 0.5) * 0.2,
              vy: -0.3 - Math.random() * 0.3,
              color: '#fffbeb',
              size: 1,
              life: 18,
              maxLife: 18,
              gravity: 0,
            });
          }
        }
      }
    }

    for (const p of this.particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.life--;
    }
    this.particles = this.particles.filter((p) => p.life > 0);

    for (const ft of this.floatingTexts) {
      ft.y -= 0.45;
      ft.life--;
    }
    this.floatingTexts = this.floatingTexts.filter((ft) => ft.life > 0);

    for (const ai of this.afterimages) {
      ai.alpha -= 0.09;
    }
    this.afterimages = this.afterimages.filter((ai) => ai.alpha > 0);
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
  // Rendering (320x200 Framebuffer with Modern HD & Classic Modes)
  // ============================================================================
  public render(): void {
    const ctx = this.renderer.ctx;
    ctx.save();

    // Screen Shake offset
    if (this.shakeTimer > 0 && this.renderer.style === 'MODERN') {
      const mag = (this.shakeTimer / 16) * this.shakeIntensity;
      const ox = (Math.random() - 0.5) * 2 * mag;
      const oy = (Math.random() - 0.5) * 2 * mag;
      ctx.translate(ox, oy);
    }

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

    ctx.restore();
  }

  private renderTitleScreen(): void {
    this.renderer.drawParallaxBackground(this.fineTick * 0.8, this.fineTick, 0);

    // 4-frame animated "DANGEROUS DAVE" flaming logo (sprites 144..147, 112x47)
    const logoSprite = 144 + (this.animTick & 3);
    this.renderer.drawSpriteModern(logoSprite, 104, 2, {
      glowColor: '#ff6600',
      glowBlur: 10,
    });

    this.renderer.drawTextCentered('BY JOHN ROMERO', 51);
    this.renderer.drawTextCentered('REMASTER BY REALZURR', 60);

    // Draw the 10x7 title mini-map (0x25ca6) centered at x = 80, y = 72
    const tmap = this.data.titleMap;
    for (let r = 0; r < tmap.length; r++) {
      for (let c = 0; c < tmap[r].length; c++) {
        const tileId = tmap[r][c];
        if (tileId > 0) {
          this.renderer.drawTile(tileId, 80 + c * 16, 72 + r * 16, this.animTick, c, r, this.fineTick, true);
        }
      }
    }

    this.renderer.drawTextCentered('PRESS THE F1 KEY FOR HELP', 188);
    if ((this.animTick & 2) === 0) {
      this.renderer.drawTextCentered('PRESS SPACE TO START', 178);
    }
  }

  private renderPlayfieldAndHud(): void {
    // 0. Parallax Background
    this.renderer.drawParallaxBackground(this.cameraX, this.fineTick, this.activeMapLevel);

    // 1. Playfield Tiles (10 rows x visible columns, smooth cameraX sub-pixel scroll)
    const startCol = Math.max(0, Math.floor(this.cameraX / 16));
    const endCol = Math.min(99, startCol + 21);

    for (let r = 0; r < 10; r++) {
      for (let mapCol = startCol; mapCol <= endCol; mapCol++) {
        const tileId = this.map[r][mapCol];
        if (tileId > 0) {
          const screenX = mapCol * 16 - this.cameraX;
          this.renderer.drawTile(
            tileId,
            screenX,
            16 + r * 16,
            this.animTick,
            mapCol,
            r,
            this.fineTick,
            this.dave.hasTrophy
          );
        }
      }
    }

    // 2. Dash Afterimages
    for (const ai of this.afterimages) {
      this.renderer.drawAfterimage(ai.spriteId, ai.worldX - this.cameraX, ai.y, ai.alpha);
    }

    // 3. Draw Dave
    const daveScreenX = this.dave.worldX - this.cameraX;
    if (this.dave.deadTimer > 0) {
      const expSprite = 129 + (this.animTick & 3);
      this.renderer.drawSpriteModern(expSprite, daveScreenX, this.dave.y, {
        glowColor: '#ff5500',
        glowBlur: 12,
      });
    } else if (Math.floor(this.dave.respawnInvuln / 3) % 2 === 0) {
      const daveSprite = this.getDaveSpriteId();
      const glow =
        this.dave.dashTimer > 0
          ? '#00f0ff'
          : this.dave.isJetpacking
          ? '#ff8800'
          : this.dave.hasTrophy
          ? '#ffd700'
          : undefined;
      this.renderer.drawSpriteModern(daveSprite, daveScreenX, this.dave.y, {
        scaleX: this.dave.scaleX,
        scaleY: this.dave.scaleY,
        glowColor: glow,
        glowBlur: glow ? 6 : 0,
      });
    }

    // 4. Draw Monsters
    for (const m of this.monsters) {
      if (!m.active) continue;
      const screenX = m.x - this.cameraX;
      if (screenX < -32 || screenX > 320) continue;
      if (m.deadTimer > 0) {
        const expSprite = 129 + (this.animTick & 3);
        this.renderer.drawSpriteModern(expSprite, screenX, m.y, {
          glowColor: '#ff4400',
          glowBlur: 10,
        });
      } else {
        const frameOffset = [0, 1, 2, 1][m.animFrame & 3];
        this.renderer.drawSpriteModern(m.spriteBase + frameOffset, screenX, m.y, {
          glowColor: '#ff2266',
          glowBlur: 4,
        });
      }
    }

    // 5. Draw Projectiles
    if (this.daveBullet.active) {
      const bulletSprite = this.daveBullet.dir > 0 ? 127 : 128;
      this.renderer.drawSpriteModern(bulletSprite, this.daveBullet.worldX - this.cameraX, this.daveBullet.y, {
        glowColor: '#00f0ff',
        glowBlur: 8,
      });
    }
    for (const fb of this.monsterFireballs) {
      const base = fb.dir > 0 ? 121 : 124;
      const off = [0, 1, 2, 1][fb.animFrame & 3];
      this.renderer.drawSpriteModern(base + off, fb.worldX - this.cameraX, fb.y, {
        glowColor: '#ff6600',
        glowBlur: 8,
      });
    }

    // 6. Draw Particles & Floating Score Popups
    if (this.renderer.style === 'MODERN') {
      const ctx = this.renderer.ctx;
      for (const p of this.particles) {
        const sx = p.x - this.cameraX;
        if (sx < -8 || sx > 328) continue;
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
        ctx.fillStyle = p.color;
        ctx.fillRect(Math.floor(sx), Math.floor(p.y), p.size, p.size);
        ctx.restore();
      }

      for (const ft of this.floatingTexts) {
        const sx = ft.x - this.cameraX;
        ctx.save();
        ctx.globalAlpha = Math.min(1, (ft.life / ft.maxLife) * 1.4);
        ctx.font = 'bold 7px monospace';
        ctx.fillStyle = '#000000';
        ctx.fillText(ft.text, Math.floor(sx) - 9, Math.floor(ft.y) + 1);
        ctx.fillStyle = ft.color;
        ctx.fillText(ft.text, Math.floor(sx) - 10, Math.floor(ft.y));
        ctx.restore();
      }
    }

    // 7. HUD Bars (Modern vs Classic)
    if (this.renderer.style === 'MODERN') {
      this.renderer.drawModernHud({
        score: this.score,
        level: this.currentLevel + 1,
        lives: this.lives,
        jetpackFuel: this.dave.jetpackFuel,
        hasGun: this.dave.hasGun,
        hasTrophy: this.dave.hasTrophy,
        dashCooldown: this.dave.dashCooldown,
        maxDashCooldown: this.dave.maxDashCooldown,
        comboCount: this.comboCount,
        comboTimer: this.comboTimer,
        fineTick: this.fineTick,
      });
    } else {
      // Classic 1990 HUD
      this.renderer.fillRect(0, 0, 320, 16, '#000000');
      this.renderer.drawSprite(133, 0, 2);
      this.renderer.drawHudDigits(this.score, 5, 64, 2);
      this.renderer.drawSprite(134, 118, 2);
      this.renderer.drawHudDigits(this.currentLevel + 1, 2, 174, 2);
      this.renderer.drawSprite(135, 200, 2);
      const displayLives = Math.min(4, this.lives);
      for (let i = 0; i < displayLives; i++) {
        this.renderer.drawSprite(143, 260 + i * 15, 1);
      }
      this.renderer.fillRect(0, 14, 320, 2, '#aaaaaa');

      this.renderer.fillRect(0, 176, 320, 24, '#000000');
      this.renderer.fillRect(0, 176, 320, 2, '#aaaaaa');
      if (this.dave.jetpackFuel > 0) {
        this.renderer.drawSprite(139, 0, 183);
        const bars = Math.ceil((this.dave.jetpackFuel / 255) * 10);
        for (let b = 0; b < bars; b++) {
          this.renderer.drawSprite(142, 72 + b * 6, 188);
        }
      }
      if (this.dave.hasGun) {
        this.renderer.drawSprite(140, 248, 183);
      }
      if (this.dave.hasTrophy) {
        this.renderer.drawSprite(138, 72, 184);
      }
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
    if (!this.keys.left && !this.keys.right && this.dave.dashTimer === 0) {
      return this.dave.dir > 0 ? 54 : 56;
    }
    const walkSeq = this.dave.dir > 0 ? [53, 54, 55, 54] : [57, 58, 59, 58];
    return walkSeq[this.dave.walkFrame & 3];
  }

  private renderIntermission(): void {
    this.renderer.drawParallaxBackground(this.transitionX * 2, this.fineTick, this.currentLevel);
    this.renderTopHudOnly();
    for (let c = 0; c < 20; c++) {
      this.renderer.drawTile(5, c * 16, 64, this.animTick, c, 3, this.fineTick);
      this.renderer.drawTile(5, c * 16, 112, this.animTick, c, 6, this.fineTick);
    }
    const remaining = 9 - this.currentLevel;
    if (remaining === 1) {
      this.renderer.drawTextCentered('THIS IS THE LAST LEVEL!!!', 40);
    } else {
      this.renderer.drawTextCentered(`GOOD WORK! ONLY ${remaining} MORE TO GO!`, 40);
    }
    const walkSeq = [53, 54, 55, 54];
    this.renderer.drawSpriteModern(walkSeq[this.dave.walkFrame & 3], this.transitionX, 96, {
      glowColor: '#00f0ff',
      glowBlur: 6,
    });
  }

  private renderWarpCutscene(): void {
    this.renderer.drawParallaxBackground(0, this.fineTick, this.currentLevel);
    this.renderTopHudOnly();
    const wz = this.data.levels[this.currentLevel].warpZone;
    const wallTile = wz.chuteWallTile || 5;
    for (let r = 0; r < 10; r++) {
      this.renderer.drawTile(wallTile, 8 * 16, 16 + r * 16, this.animTick, 8, r, this.fineTick);
      this.renderer.drawTile(wallTile, 10 * 16, 16 + r * 16, this.animTick, 10, r, this.fineTick);
    }
    this.renderer.drawSpriteModern(141, 16, 90, { glowColor: '#00f0ff', glowBlur: 8 });
    this.renderer.drawSpriteModern(141, 180, 90, { glowColor: '#00f0ff', glowBlur: 8 });
    this.renderer.drawSpriteModern(67, 9 * 16, 16 + this.transitionY, {
      glowColor: '#ffd700',
      glowBlur: 8,
    });
  }

  private renderTopHudOnly(): void {
    this.renderer.fillRect(0, 0, 320, 15, 'rgba(8, 11, 20, 0.92)');
    this.renderer.drawSprite(133, 0, 2);
    this.renderer.drawHudDigits(this.score, 5, 64, 2);
    this.renderer.drawSprite(134, 118, 2);
    this.renderer.drawHudDigits(this.currentLevel + 1, 2, 174, 2);
    this.renderer.drawSprite(135, 200, 2);
    for (let i = 0; i < Math.min(4, this.lives); i++) {
      this.renderer.drawSprite(143, 260 + i * 15, 1);
    }
    this.renderer.fillRect(0, 14, 320, 2, '#00e5ff');
  }

  private renderVictoryScreen(): void {
    this.renderer.drawParallaxBackground(this.fineTick, this.fineTick, 9);
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
    this.renderer.drawParallaxBackground(this.fineTick * 0.5, this.fineTick, 0);
    this.renderer.drawWindowBox(6, 7, 28, 9);
    this.renderer.drawText('You got a high score!', 9 * 8, 9 * 8);
    this.renderer.drawText(`SCORE: ${this.score}`, 9 * 8, 11 * 8);
    this.renderer.drawText(`ENTER INITIALS: ${this.playerInitials}_`, 9 * 8, 13 * 8);
  }

  private renderHighScoresScreen(): void {
    this.renderer.drawParallaxBackground(this.fineTick * 0.5, this.fineTick, 0);
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
        '   DANGEROUS DAVE REMASTER',
        '',
        'MODERN 60FPS EDITION WITH',
        'PARALLAX GRAPHICS, SYNTHWAVE',
        'AUDIO, AND AGILE DASH!',
        '',
        'FUNCTION KEYS:',
        'F1 = HELP',
        'F3 = RESTART GAME',
        'F5 = QUICK SAVE',
        'F7 = QUICK LOAD',
        'F9 = PAUSE GAME',
        '',
        '   PRESS SPACE OR ESC',
      ],
      [
        '   DANGEROUS DAVE REMASTER',
        '',
        'GUIDE DAVE THROUGH 10',
        "AREAS IN CLYDE'S HIDEOUT.",
        '',
        'ARROWS/WASD = MOVE & CLIMB',
        'UP / SPACE  = AGILE JUMP',
        'SHIFT / C   = CYBER DASH',
        'CTRL / Z    = LASER BLASTER',
        'ALT / X     = JETPACK ON/OFF',
        '',
        '',
        '   PRESS SPACE OR ESC',
      ],
      [
        '   DANGEROUS DAVE REMASTER',
        '',
        'WATCH OUT FOR FIRE, WATER',
        'AND WEIRDWEEDS! CHAIN ITEMS',
        'QUICKLY FOR COMBO SCORE',
        'MULTIPLIERS (UP TO X8)!',
        'GRAB THE TROPHY AND WALK',
        'THROUGH THE GLOWING DOOR.',
        'PLUS 4 SECRET WARP ZONES',
        'ON LEVELS 5, 8, 9 AND 10!',
        '',
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
