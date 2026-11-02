import { GameDataBundle } from './types';

export type VisualStyle = 'MODERN' | 'CLASSIC';

export class VGARenderer {
  public ctx: CanvasRenderingContext2D;
  private spriteImages: HTMLImageElement[] = [];
  private fontImages: HTMLImageElement[] = [];
  private uiIconImages: HTMLImageElement[] = [];
  public style: VisualStyle = 'MODERN';

  constructor(canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D Canvas context not available');
    this.ctx = context;
    this.ctx.imageSmoothingEnabled = false;
  }

  public async loadAssets(data: GameDataBundle): Promise<void> {
    const loadImg = (url: string): Promise<HTMLImageElement> =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
      });

    this.spriteImages = await Promise.all(data.sprites.map((s) => loadImg(s.dataUrl)));
    this.fontImages = await Promise.all(data.fontGlyphs.map((f) => loadImg(f.dataUrl)));
    this.uiIconImages = await Promise.all(data.uiIcons.map((u) => loadImg(u.dataUrl)));
  }

  public clear(color = '#000000'): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, 320, 200);
  }

  public fillRect(x: number, y: number, w: number, h: number, color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(Math.floor(x), Math.floor(y), Math.floor(w), Math.floor(h));
  }

  /**
   * Renders a multi-layer animated parallax background in MODERN visual mode.
   */
  public drawParallaxBackground(cameraX: number, tick: number, levelIdx: number): void {
    if (this.style === 'CLASSIC') {
      this.clear('#000000');
      return;
    }

    const ctx = this.ctx;
    // Palette themes per level group
    const themes = [
      ['#090b16', '#141830', '#231934'], // Levels 1-3: Deep Cyber Cavern
      ['#08121a', '#0f2537', '#1a3848'], // Levels 4-6: Subterranean Bio-Lab
      ['#160912', '#2b1126', '#421828'], // Levels 7-9: Crimson Magma Core
      ['#120824', '#261247', '#3b1c66'], // Level 10: Clyde's Sanctum
    ];
    const theme = themes[Math.min(themes.length - 1, Math.floor(levelIdx / 3))];

    const grad = ctx.createLinearGradient(0, 16, 0, 176);
    grad.addColorStop(0, theme[0]);
    grad.addColorStop(0.55, theme[1]);
    grad.addColorStop(1, theme[2]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 320, 200);

    // Layer 1: Distant twinkling stars / embers (0.1x parallax)
    for (let i = 0; i < 28; i++) {
      const seedX = (i * 73 + 19) % 360;
      const seedY = 20 + ((i * 41 + 7) % 145);
      const sx = ((seedX - cameraX * 0.12) % 320 + 320) % 320;
      const pulse = 0.35 + 0.65 * Math.abs(Math.sin(tick * 0.04 + i));
      ctx.fillStyle = i % 3 === 0 ? `rgba(120, 220, 255, ${pulse * 0.6})` : `rgba(255, 255, 255, ${pulse * 0.45})`;
      ctx.fillRect(Math.floor(sx), seedY, 1, 1);
    }

    // Layer 2: Far cavern pillars / silhouettes (0.25x parallax)
    ctx.fillStyle = 'rgba(8, 10, 20, 0.45)';
    const farOffset = -(cameraX * 0.25) % 64;
    for (let x = farOffset - 64; x < 340; x += 64) {
      const colIdx = Math.floor((x - farOffset + cameraX * 0.25) / 64);
      const h = 38 + (Math.abs(colIdx * 29 + 11) % 55);
      // Stalagmite from bottom
      ctx.beginPath();
      ctx.moveTo(x, 176);
      ctx.lineTo(x + 20, 176 - h);
      ctx.lineTo(x + 44, 176 - h * 0.7);
      ctx.lineTo(x + 64, 176);
      ctx.fill();

      // Stalactite from ceiling
      const ch = 22 + (Math.abs(colIdx * 17 + 5) % 34);
      ctx.beginPath();
      ctx.moveTo(x + 8, 16);
      ctx.lineTo(x + 32, 16 + ch);
      ctx.lineTo(x + 56, 16);
      ctx.fill();
    }

    // Layer 3: Midground geometric grid & pillars (0.5x parallax)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
    ctx.lineWidth = 1;
    const midOffset = -(cameraX * 0.5) % 32;
    for (let x = midOffset; x < 320; x += 32) {
      ctx.beginPath();
      ctx.moveTo(Math.floor(x) + 0.5, 16);
      ctx.lineTo(Math.floor(x) + 0.5, 176);
      ctx.stroke();
    }
    for (let y = 32; y < 176; y += 32) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(320, y + 0.5);
      ctx.stroke();
    }
  }

  public drawSprite(id: number, x: number, y: number): void {
    if (id <= 0 || id >= this.spriteImages.length) return;
    const img = this.spriteImages[id];
    if (!img) return;
    this.ctx.drawImage(img, Math.floor(x), Math.floor(y));
  }

  /**
   * Draws a sprite with optional glow, squash/stretch, and alpha for MODERN mode.
   */
  public drawSpriteModern(
    id: number,
    x: number,
    y: number,
    opts?: {
      scaleX?: number;
      scaleY?: number;
      glowColor?: string;
      glowBlur?: number;
      alpha?: number;
    }
  ): void {
    if (id <= 0 || id >= this.spriteImages.length) return;
    const img = this.spriteImages[id];
    if (!img) return;

    if (this.style === 'CLASSIC' || !opts) {
      this.ctx.drawImage(img, Math.floor(x), Math.floor(y));
      return;
    }

    const ctx = this.ctx;
    ctx.save();
    if (opts.alpha !== undefined) {
      ctx.globalAlpha = opts.alpha;
    }
    if (opts.glowColor) {
      ctx.shadowColor = opts.glowColor;
      ctx.shadowBlur = opts.glowBlur ?? 8;
    }

    const sx = opts.scaleX ?? 1;
    const sy = opts.scaleY ?? 1;
    if (sx !== 1 || sy !== 1) {
      const cx = x + img.width / 2;
      const by = y + img.height; // Anchor at bottom-center for ground squash/stretch
      ctx.translate(cx, by);
      ctx.scale(sx, sy);
      ctx.drawImage(img, -img.width / 2, -img.height);
    } else {
      ctx.drawImage(img, Math.floor(x), Math.floor(y));
    }
    ctx.restore();
  }

  /**
   * Draws a cyan/neon dash afterimage silhouette.
   */
  public drawAfterimage(id: number, x: number, y: number, alpha: number): void {
    if (this.style === 'CLASSIC') return;
    if (id <= 0 || id >= this.spriteImages.length) return;
    const img = this.spriteImages[id];
    if (!img) return;

    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha * 0.55;
    ctx.shadowColor = '#00f0ff';
    ctx.shadowBlur = 8;
    ctx.filter = 'hue-rotate(150deg) saturate(300%) brightness(1.5)';
    ctx.drawImage(img, Math.floor(x), Math.floor(y));
    ctx.restore();
  }

  public drawUiIcon(id: number, x: number, y: number): void {
    const img = this.uiIconImages[id];
    if (!img) return;
    this.ctx.drawImage(img, Math.floor(x), Math.floor(y));
  }

  /**
   * Resolves animated tile IDs matching DAVE.EXE (DS:0x034e):
   * - 6..9: Fire (4 frames)
   * - 10..14: Trophy (5 frames)
   * - 25..28: Water (4 frames)
   * - 36..39: Weirdweeds (4 frames)
   */
  public resolveAnimatedTile(tileId: number, animTick: number, gridX = 0, gridY = 0): number {
    if (tileId === 6) {
      return 6 + ((animTick + gridX + gridY) & 3);
    }
    if (tileId === 10) {
      return 10 + (animTick % 5);
    }
    if (tileId === 25) {
      return 25 + ((animTick + gridX) & 3);
    }
    if (tileId === 36) {
      return 36 + ((animTick + gridX + gridY) & 3);
    }
    return tileId;
  }

  public drawTile(
    tileId: number,
    pixelX: number,
    pixelY: number,
    animTick: number,
    gridX = 0,
    gridY = 0,
    fineTick = 0,
    hasTrophy = false
  ): void {
    if (tileId <= 0) return;
    const actualId = this.resolveAnimatedTile(tileId, animTick, gridX, gridY);
    const px = Math.floor(pixelX);
    const py = Math.floor(pixelY);

    if (this.style === 'CLASSIC') {
      this.drawSprite(actualId, px, py);
      return;
    }

    const ctx = this.ctx;

    // 1. Collectibles (Trophy 10, Gun 20, Jetpack 4, Treasures 47..52): Floating bob + Neon Glow
    const isCollectible =
      tileId === 10 || tileId === 20 || tileId === 4 || (tileId >= 47 && tileId <= 52);
    if (isCollectible) {
      const bob = Math.sin(fineTick * 0.1 + gridX * 0.9 + gridY * 0.5) * 2.2;
      let glow = '#00e5ff';
      if (tileId === 10) glow = '#ffd700'; // Trophy Gold
      else if (tileId === 4 || tileId === 20) glow = '#ff44cc'; // Powerup Magenta
      else if (tileId >= 50) glow = '#a855f7'; // High value treasures

      ctx.save();
      // Subtle radial aura behind item
      const rad = ctx.createRadialGradient(px + 8, py + 8 + bob, 1, px + 8, py + 8 + bob, 11);
      rad.addColorStop(0, glow + '66');
      rad.addColorStop(1, glow + '00');
      ctx.fillStyle = rad;
      ctx.fillRect(px - 4, py - 4 + bob, 24, 24);

      this.drawSpriteModern(actualId, px, py + bob, { glowColor: glow, glowBlur: 6 });
      ctx.restore();
      return;
    }

    // 2. Exit Door (tileId === 2)
    if (tileId === 2) {
      this.drawSprite(actualId, px, py);
      if (hasTrophy) {
        const pulse = 0.35 + 0.35 * Math.sin(fineTick * 0.15);
        ctx.save();
        ctx.strokeStyle = `rgba(255, 215, 0, ${pulse + 0.25})`;
        ctx.lineWidth = 1.5;
        ctx.shadowColor = '#ffd700';
        ctx.shadowBlur = 10;
        ctx.strokeRect(px + 1, py + 1, 14, 14);
        ctx.restore();
      }
      return;
    }

    // 3. Fire Hazard (tileId === 6..9)
    if (tileId >= 6 && tileId <= 9) {
      ctx.save();
      const grad = ctx.createRadialGradient(px + 8, py + 12, 2, px + 8, py + 10, 14);
      grad.addColorStop(0, 'rgba(255, 120, 20, 0.45)');
      grad.addColorStop(1, 'rgba(255, 40, 0, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(px - 4, py - 4, 24, 24);
      this.drawSprite(actualId, px, py);
      ctx.restore();
      return;
    }

    // 4. Water Hazard (tileId === 25..28)
    if (tileId >= 25 && tileId <= 28) {
      this.drawSprite(actualId, px, py);
      ctx.save();
      const waveY = py + 2 + Math.sin(fineTick * 0.12 + gridX) * 1.2;
      ctx.fillStyle = 'rgba(0, 210, 255, 0.22)';
      ctx.fillRect(px, py + 2, 16, 14);
      ctx.fillStyle = 'rgba(160, 245, 255, 0.65)';
      ctx.fillRect(px, Math.floor(waveY), 16, 1);
      ctx.restore();
      return;
    }

    // 5. Weirdweeds (tileId === 36..39)
    if (tileId >= 36 && tileId <= 39) {
      this.drawSpriteModern(actualId, px, py, { glowColor: '#39ff14', glowBlur: 4 });
      return;
    }

    // 6. Standard Solid / Structural Tiles: Draw original + modern 3D bevel highlight & shadow
    this.drawSprite(actualId, px, py);
    const isSolidBlock =
      tileId === 1 ||
      tileId === 3 ||
      tileId === 5 ||
      (tileId >= 15 && tileId <= 19) ||
      (tileId >= 21 && tileId <= 24) ||
      tileId === 29 ||
      tileId === 30;
    if (isSolidBlock) {
      // Top-left specular highlight
      ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
      ctx.fillRect(px, py, 16, 1);
      ctx.fillRect(px, py, 1, 16);
      // Bottom-right subtle depth bevel
      ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
      ctx.fillRect(px, py + 15, 16, 1);
      ctx.fillRect(px + 15, py, 1, 16);
    }
  }

  /**
   * Draws text using the extracted 8x8 VGA font from DAVE.EXE (0x20dc0).
   */
  public drawText(text: string, x: number, y: number): void {
    let curX = Math.floor(x);
    const curY = Math.floor(y);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0 && code < this.fontImages.length) {
        this.ctx.drawImage(this.fontImages[code], curX, curY);
      }
      curX += 8;
    }
  }

  public drawTextCentered(text: string, y: number): void {
    const x = Math.floor((320 - text.length * 8) / 2);
    this.drawText(text, x, y);
  }

  /**
   * Draws a classic Softdisk PC-Arcade window box using glyphs 1..8 of the 8x8 font,
   * or a sleek glassmorphism modal in MODERN mode.
   */
  public drawWindowBox(colX: number, rowY: number, colsW: number, rowsH: number): void {
    const px = colX * 8;
    const py = rowY * 8;
    const pw = colsW * 8;
    const ph = rowsH * 8;

    if (this.style === 'MODERN') {
      const ctx = this.ctx;
      ctx.save();
      ctx.fillStyle = 'rgba(10, 14, 26, 0.92)';
      ctx.fillRect(px + 2, py + 2, pw - 4, ph - 4);
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 1.5;
      ctx.shadowColor = '#00e5ff';
      ctx.shadowBlur = 8;
      ctx.strokeRect(px + 3, py + 3, pw - 6, ph - 6);
      ctx.restore();
      return;
    }

    // Black interior
    this.fillRect(px + 4, py + 4, pw - 8, ph - 8, '#000000');

    // Corners & edges using glyphs 1..8
    for (let r = 0; r < rowsH; r++) {
      for (let c = 0; c < colsW; c++) {
        let glyph = 0;
        if (r === 0 && c === 0) glyph = 1;
        else if (r === 0 && c === colsW - 1) glyph = 3;
        else if (r === rowsH - 1 && c === 0) glyph = 6;
        else if (r === rowsH - 1 && c === colsW - 1) glyph = 8;
        else if (r === 0) glyph = 2;
        else if (r === rowsH - 1) glyph = 7;
        else if (c === 0) glyph = 4;
        else if (c === colsW - 1) glyph = 5;

        if (glyph > 0 && this.fontImages[glyph]) {
          this.ctx.drawImage(this.fontImages[glyph], (colX + c) * 8, (rowY + r) * 8);
        }
      }
    }
  }

  /**
   * Draws HUD digits (sprites 148..157 are '0'..'9', 8x11 pixels each).
   */
  public drawHudDigits(value: number, digits: number, x: number, y: number): void {
    const str = Math.max(0, Math.floor(value)).toString().padStart(digits, '0').slice(-digits);
    for (let i = 0; i < str.length; i++) {
      const d = str.charCodeAt(i) - 48;
      if (d >= 0 && d <= 9) {
        this.drawSprite(148 + d, x + i * 8, y);
      }
    }
  }

  /**
   * Draws modern HUD bars (top & bottom) with neon accents, Dash indicator, and Combo multiplier.
   */
  public drawModernHud(params: {
    score: number;
    level: number;
    lives: number;
    jetpackFuel: number;
    hasGun: boolean;
    hasTrophy: boolean;
    dashCooldown: number;
    maxDashCooldown: number;
    comboCount: number;
    comboTimer: number;
    fineTick: number;
  }): void {
    const ctx = this.ctx;

    // Top bar dark glass background
    ctx.fillStyle = 'rgba(8, 11, 20, 0.92)';
    ctx.fillRect(0, 0, 320, 15);
    const topGrad = ctx.createLinearGradient(0, 14, 320, 14);
    topGrad.addColorStop(0, '#00e5ff');
    topGrad.addColorStop(0.5, '#ff44cc');
    topGrad.addColorStop(1, '#ffd700');
    ctx.fillStyle = topGrad;
    ctx.fillRect(0, 14, 320, 1.5);

    // Classic score/level/daves sprites with crisp layout
    this.drawSprite(133, 2, 2);
    this.drawHudDigits(params.score, 5, 62, 2);

    this.drawSprite(134, 114, 2);
    this.drawHudDigits(params.level, 2, 168, 2);

    // Combo badge if active
    if (params.comboCount > 1 && params.comboTimer > 0) {
      ctx.save();
      ctx.fillStyle = '#ffd700';
      ctx.font = 'bold 8px monospace';
      ctx.fillText(`x${params.comboCount}`, 189, 10);
      ctx.restore();
    }

    this.drawSprite(135, 208, 2);
    const displayLives = Math.min(4, params.lives);
    for (let i = 0; i < displayLives; i++) {
      this.drawSprite(143, 262 + i * 14, 1);
    }

    // Bottom HUD Bar (y = 176..199)
    ctx.fillStyle = 'rgba(8, 11, 20, 0.92)';
    ctx.fillRect(0, 176, 320, 24);
    ctx.fillStyle = topGrad;
    ctx.fillRect(0, 176, 320, 1.5);

    // Jetpack smooth neon bar
    if (params.jetpackFuel > 0) {
      this.drawSprite(139, 2, 182);
      const ratio = Math.max(0, Math.min(1, params.jetpackFuel / 255));
      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.fillRect(72, 186, 62, 6);
      const fuelGrad = ctx.createLinearGradient(72, 0, 134, 0);
      fuelGrad.addColorStop(0, '#00e5ff');
      fuelGrad.addColorStop(1, '#ff3366');
      ctx.fillStyle = fuelGrad;
      ctx.fillRect(72, 186, Math.ceil(62 * ratio), 6);
    }

    // Dash Cooldown Indicator (Modern exclusive mechanic)
    ctx.save();
    ctx.font = 'bold 7px monospace';
    const dashReady = params.dashCooldown <= 0;
    ctx.fillStyle = dashReady ? '#00f0ff' : '#6e7681';
    ctx.fillText('DASH [C/SHIFT]', 2, 181);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.fillRect(62, 178, 30, 3);
    const dashRatio = dashReady ? 1 : 1 - params.dashCooldown / Math.max(1, params.maxDashCooldown);
    ctx.fillStyle = dashReady ? '#00f0ff' : '#007799';
    ctx.fillRect(62, 178, Math.floor(30 * dashRatio), 3);
    ctx.restore();

    // Trophy Banner ("GO THRU THE DOOR!")
    if (params.hasTrophy) {
      const pulse = 0.8 + 0.2 * Math.sin(params.fineTick * 0.15);
      this.drawSpriteModern(138, 100, 183, {
        glowColor: '#ffd700',
        glowBlur: 6,
        alpha: pulse,
      });
    }

    // Gun icon
    if (params.hasGun) {
      this.drawSpriteModern(140, 252, 183, {
        glowColor: '#ff44cc',
        glowBlur: 5,
      });
    }
  }
}
