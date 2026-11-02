import { GameDataBundle } from './types';

export class VGARenderer {
  private ctx: CanvasRenderingContext2D;
  private spriteImages: HTMLImageElement[] = [];
  private fontImages: HTMLImageElement[] = [];
  private uiIconImages: HTMLImageElement[] = [];

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

  public drawSprite(id: number, x: number, y: number): void {
    if (id <= 0 || id >= this.spriteImages.length) return;
    const img = this.spriteImages[id];
    if (!img) return;
    this.ctx.drawImage(img, Math.floor(x), Math.floor(y));
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

  public drawTile(tileId: number, pixelX: number, pixelY: number, animTick: number, gridX = 0, gridY = 0): void {
    if (tileId <= 0) return;
    const actualId = this.resolveAnimatedTile(tileId, animTick, gridX, gridY);
    this.drawSprite(actualId, pixelX, pixelY);
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
   * Draws a classic Softdisk PC-Arcade window box using glyphs 1..8 of the 8x8 font.
   */
  public drawWindowBox(colX: number, rowY: number, colsW: number, rowsH: number): void {
    const px = colX * 8;
    const py = rowY * 8;
    const pw = colsW * 8;
    const ph = rowsH * 8;

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
}
