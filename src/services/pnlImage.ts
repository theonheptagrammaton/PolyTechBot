import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger';
import {
  TemplateLayoutConfig,
  ALL_TIME_LAYOUT,
  PORTFOLIO_LAYOUT,
  POSITION_LAYOUT,
} from '../config/pnlTemplates';

// ─── Constants ──────────────────────────────────────────────────────────────

const TEMPLATE_DIR = path.join(__dirname, '../bot/img/pnl');
const FONT_DIR     = path.join(__dirname, '../bot/img/fonts');

// ─── Font Installation ──────────────────────────────────────────────────────

let _fontInstalled = false;
let _fontFamilyName = 'ChunkFive Ex';

/**
 * Copies project fonts to the system font directory so fontconfig/Pango can find them.
 * macOS: ~/Library/Fonts/   Linux: ~/.local/share/fonts/
 */
function ensureFontInstalled(): void {
  if (_fontInstalled) return;
  _fontInstalled = true;

  if (!fs.existsSync(FONT_DIR)) return;

  const ttfFiles = fs.readdirSync(FONT_DIR).filter(f =>
    f.endsWith('.ttf') || f.endsWith('.otf')
  );
  if (ttfFiles.length === 0) return;

  // Derive family name from first font file
  _fontFamilyName = ttfFiles[0].replace(/\.(ttf|otf)$/i, '');

  const systemFontDir = process.platform === 'darwin'
    ? path.join(process.env.HOME || '', 'Library/Fonts')
    : path.join(process.env.HOME || '', '.local/share/fonts');

  try {
    fs.mkdirSync(systemFontDir, { recursive: true });
  } catch {
    logger.warn(`[pnlImage] Cannot create system font dir: ${systemFontDir}`);
    return;
  }

  for (const fontFile of ttfFiles) {
    const src  = path.join(FONT_DIR, fontFile);
    const dest = path.join(systemFontDir, fontFile);
    if (!fs.existsSync(dest)) {
      try {
        fs.copyFileSync(src, dest);
        logger.info(`[pnlImage] Installed font: ${fontFile} → ${dest}`);
      } catch (err) {
        logger.warn(`[pnlImage] Failed to install font ${fontFile}:`, err);
      }
    }
  }

  logger.info(`[pnlImage] Font family: ${_fontFamilyName}`);
}

// ─── Template Pool ──────────────────────────────────────────────────────────

const greenPool: Buffer[] = [];
const redPool: Buffer[] = [];
let poolLoaded = false;

function loadTemplatePools(): void {
  if (poolLoaded && (greenPool.length > 0 || redPool.length > 0)) return;
  poolLoaded = true;
  greenPool.length = 0;
  redPool.length = 0;

  if (!fs.existsSync(TEMPLATE_DIR)) {
    logger.warn(`[pnlImage] Template directory not found: ${TEMPLATE_DIR}`);
    return;
  }

  const files = fs.readdirSync(TEMPLATE_DIR).filter(f =>
    f.toLowerCase().endsWith('.png') || f.toLowerCase().endsWith('.jpg')
  );

  for (const file of files) {
    const lower = file.toLowerCase();
    const buf = fs.readFileSync(path.join(TEMPLATE_DIR, file));

    if (lower.includes('green')) {
      greenPool.push(buf);
    } else if (lower.includes('red')) {
      redPool.push(buf);
    }
  }

  logger.info(`[pnlImage] Loaded ${greenPool.length} green + ${redPool.length} red templates`);
}

function pickTemplate(pnlValue: number): Buffer | null {
  loadTemplatePools();
  const pool = pnlValue >= 0 ? greenPool : redPool;
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}


// ─── Text Rendering (sharp text API + Pango) ────────────────────────────────

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Renders a single text string as a transparent PNG buffer using sharp's Pango text API.
 * Returns the buffer + its dimensions for precise compositing.
 */
async function renderTextField(
  text: string,
  fontSize: number,
  color: string,
  wrapWidth?: number,
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const markup = `<span font_desc="${_fontFamilyName} ${fontSize}" foreground="${color}">${escapeXml(text)}</span>`;

  const textOpts: any = {
    text: markup,
    dpi: 72,
    rgba: true,
  };
  if (wrapWidth) {
    textOpts.width = wrapWidth;
    textOpts.wrap = 'word';
    textOpts.align = 'centre';
  }

  const buffer = await sharp({ text: textOpts } as any).png().toBuffer();

  const meta = await sharp(buffer).metadata();
  return { buffer, width: meta.width || 0, height: meta.height || 0 };
}

// ─── Profile Picture ────────────────────────────────────────────────────────

async function makeCircular(imageBuffer: Buffer, size: number): Promise<Buffer> {
  const circle = Buffer.from(
    `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/></svg>`
  );

  return sharp(imageBuffer)
    .resize(size, size, { fit: 'cover' })
    .composite([{ input: circle, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface AllTimePnlData {
  totalPnl: number;
  percentPnl: number;
  totalInvested: number;
  balance: string;
  positionCount: number;
  username?: string;
  displayName?: string;
  profilePhotoBuffer?: Buffer;
}

export interface PortfolioPnlData {
  unrealizedPnl: number;
  percentPnl: number;
  totalInvested: number;
  balance: string;
  positionCount: number;
  username?: string;
  displayName?: string;
  profilePhotoBuffer?: Buffer;
}

export interface PositionPnlData {
  title: string;
  outcome: string;
  cashPnl: number;
  percentPnl: number;
  avgPrice: number;
  curPrice: number;
  /** Actual dollar amount invested (initialValue from API) */
  invested: number;
  /** Current market value of position (size * curPrice) */
  currentValue: number;
  username?: string;
  displayName?: string;
  profilePhotoBuffer?: Buffer;
  /** Event/market icon image buffer (fetched from icon URL) */
  eventIconBuffer?: Buffer;
}

export async function generateAllTimePnlImage(data: AllTimePnlData): Promise<Buffer | null> {
  ensureFontInstalled();
  const template = pickTemplate(data.totalPnl);
  if (!template) return null;

  const totalInvested = data.totalInvested;
  const posValue = totalInvested + data.totalPnl;
  const avgCostCents = data.positionCount > 0
    ? ((totalInvested / data.positionCount) * 100).toFixed(1)
    : '0.0';

  const fieldData: Record<string, string | number> = {
    title: 'Max Realized',
    outcome: '',
    displayName: data.displayName || data.username || '',
    pnlAmount: Math.abs(data.totalPnl).toFixed(2),
    pnlPercent: Math.abs(data.percentPnl).toFixed(1),
    invested: totalInvested.toFixed(2),
    positionValue: posValue.toFixed(2),
    avgCost: avgCostCents,
    username: data.username || '',
  };

  // eventIconBuffer intentionally omitted — icon slot left empty for all-time card
  return renderImage(template, POSITION_LAYOUT, fieldData, data.profilePhotoBuffer);
}

export async function generatePortfolioPnlImage(data: PortfolioPnlData): Promise<Buffer | null> {
  ensureFontInstalled();
  const template = pickTemplate(data.unrealizedPnl);
  if (!template) return null;

  const totalInvested = data.totalInvested;
  const posValue = totalInvested + data.unrealizedPnl;
  const avgCostCents = data.positionCount > 0
    ? ((totalInvested / data.positionCount) * 100).toFixed(1)
    : '0.0';

  const fieldData: Record<string, string | number> = {
    displayName: data.displayName || data.username || '',
    pnlAmount: Math.abs(data.unrealizedPnl).toFixed(2),
    pnlPercent: Math.abs(data.percentPnl).toFixed(1),
    invested: totalInvested.toFixed(2),
    positionValue: posValue.toFixed(2),
    avgCost: avgCostCents,
    username: data.username || '',
  };

  return renderImage(template, PORTFOLIO_LAYOUT, fieldData, data.profilePhotoBuffer);
}

export async function generatePositionPnlImage(data: PositionPnlData): Promise<Buffer | null> {
  ensureFontInstalled();
  const template = pickTemplate(data.cashPnl);
  if (!template) return null;

  const fieldData: Record<string, string | number> = {
    title: data.title,
    outcome: data.outcome,
    displayName: data.displayName || data.username || '',
    pnlAmount: Math.abs(data.cashPnl).toFixed(2),
    pnlPercent: Math.abs(data.percentPnl).toFixed(1),
    invested: data.invested.toFixed(2),
    positionValue: data.currentValue.toFixed(2),
    avgCost: (data.avgPrice * 100).toFixed(1),
    username: data.username || '',
  };

  return renderImage(template, POSITION_LAYOUT, fieldData, data.profilePhotoBuffer, data.eventIconBuffer);
}

// ─── Internal Renderer ──────────────────────────────────────────────────────

async function renderImage(
  templateBuffer: Buffer,
  layout: TemplateLayoutConfig,
  data: Record<string, string | number>,
  profilePhotoBuffer?: Buffer,
  eventIconBuffer?: Buffer,
): Promise<Buffer> {
  const composites: sharp.OverlayOptions[] = [];

  // Render each text field individually via sharp text API
  for (const field of layout.fields) {
    const rawValue = data[field.key];
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;

    const numericValue = typeof rawValue === 'number' ? rawValue : parseFloat(String(rawValue));
    const isNegative = !isNaN(numericValue) && numericValue < 0;

    let displayText = String(rawValue);
    if (typeof rawValue === 'number') {
      displayText = rawValue.toFixed(2);
    }
    if (field.prefix) displayText = field.prefix + displayText;
    if (field.suffix) displayText = displayText + field.suffix;

    let fillColor = field.color;
    if (fillColor === 'auto') {
      fillColor = isNegative ? layout.negativeColor : layout.positiveColor;
    }

    try {
      const { buffer, width } = await renderTextField(
        displayText, field.fontSize, fillColor, field.maxWidth,
      );

      // Position based on anchor
      let left = field.x;
      if (field.anchor === 'middle') {
        left = field.x - Math.floor(width / 2);
      } else if (field.anchor === 'end') {
        left = field.x - width;
      }

      composites.push({
        input: buffer,
        top: Math.max(0, field.y),
        left: Math.max(0, left),
      });
    } catch (err) {
      logger.warn(`[pnlImage] Failed to render field "${field.key}":`, err);
    }
  }

  // Profile picture
  if (profilePhotoBuffer && layout.profilePic) {
    try {
      const { x, y, size, circular } = layout.profilePic;
      let photoBuffer: Buffer;

      if (circular) {
        photoBuffer = await makeCircular(profilePhotoBuffer, size);
      } else {
        photoBuffer = await sharp(profilePhotoBuffer)
          .resize(size, size, { fit: 'cover' })
          .png()
          .toBuffer();
      }

      composites.push({ input: photoBuffer, top: y, left: x });
    } catch (err) {
      logger.warn('[pnlImage] Failed to composite profile photo:', err);
    }
  }

  // Event icon (position PNL)
  if (eventIconBuffer && layout.eventIcon) {
    try {
      const { x, y, size, circular } = layout.eventIcon;
      let iconBuffer: Buffer;

      if (circular) {
        iconBuffer = await makeCircular(eventIconBuffer, size);
      } else {
        iconBuffer = await sharp(eventIconBuffer)
          .resize(size, size, { fit: 'cover' })
          .png()
          .toBuffer();
      }

      composites.push({ input: iconBuffer, top: y, left: x });
    } catch (err) {
      logger.warn('[pnlImage] Failed to composite event icon:', err);
    }
  }

  return sharp(templateBuffer)
    .composite(composites)
    .png()
    .toBuffer();
}
