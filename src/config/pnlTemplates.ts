/**
 * PNL Image Template Configuration
 *
 * Template boyutu: 2578 x 1656 piksel
 * Template'de "+$", "%", "$", "¢" işaretleri zaten mevcut — sadece sayılar overlay edilir.
 * Koordinatları ayarlamak için: x/y değerlerini değiştirin — service kodu değişmez.
 *
 * Koordinat sistemi:
 *   x → anchor'a göre: start = sol kenar, middle = orta, end = sağ kenar
 *   y → metnin ÜST kenarı (top-left positioning)
 *
 * Rendering: sharp text API (Pango) — font sisteme yükleniyor (ChunkFive Ex)
 *
 * ── Piksel analizi sonuçları (green-1.PNG) ──────────────────────────────────
 *   Pill (beyaz):       y=262→399, x=500→2417  (merkez y≈330)
 *   Yeşil bar (+$):     y=561→825, x=1134→2385 (merkez y≈693)
 *     "+$" sağ kenarı:  x≈1560 (segment x=1470-1547 @ y=693)
 *     "+$" segmentleri: x=1100-1133 (+), x=1273-1434 ($gövde), x=1470-1547 ($alt)
 *   Beyaz bar (%):      y=845→1025, x=571→2387 (merkez y≈935)
 *     Label sol blok:   x≈600→1129 (bar sol yarısı)
 *     "%" sembolü:      x=1901→2031 (bar sağ tarafı)
 *     Sayı boşluğu:     x=1130→1900 (aradaki alan)
 *   $ sembol merkezleri: y≈1175 (INVESTED, y=1120-1230), y≈1320 (POSITION, y=1270-1370)
 *   ¢ sembol merkezi:   y≈1430 (AVG COST, y=1410-1450)
 *   $ sembolleri:       x=2033→2095 (sol kenar x≈2033)
 *   Label alanları:     x≈1170→1700 (INVESTED/POSITION/AVG COST)
 *   @ sembolü:          x=163→243, y=1380→1519 (merkez y≈1450)
 */

export interface TextFieldConfig {
  key: string;
  x: number;
  /** Y coordinate — top edge of rendered text */
  y: number;
  /** Font size in Pango points */
  fontSize: number;
  fontWeight: 'regular' | 'bold';
  /** Text color. 'auto' = positive→positiveColor, negative→negativeColor */
  color: string | 'auto';
  anchor: 'start' | 'middle' | 'end';
  maxWidth?: number;
  prefix?: string;
  suffix?: string;
}

export interface ProfilePicConfig {
  x: number;
  y: number;
  size: number;
  circular: boolean;
}

export interface ImageOverlayConfig {
  x: number;
  y: number;
  size: number;
  circular: boolean;
}

export interface TemplateLayoutConfig {
  width: number;
  height: number;
  positiveColor: string;
  negativeColor: string;
  fields: TextFieldConfig[];
  profilePic?: ProfilePicConfig;
  /** Event/market icon overlay (position PNL only) */
  eventIcon?: ImageOverlayConfig;
}

// ─── All-Time PNL layout ────────────────────────────────────────────────────

export const ALL_TIME_LAYOUT: TemplateLayoutConfig = {
  width: 2578,
  height: 1656,
  positiveColor: '#2ECC71',
  negativeColor: '#FF4444',
  fields: [

    // PNL dollar amount — "+$" sağ kenarı x≈1560, yeşil bar y=561-825
    // Sayı "+$" sonrası başlar, bar merkez y≈693, font 100→74px yükseklik → top = 693-37 = 656
    { key: 'pnlAmount', x: 1600, y: 620, fontSize: 230, fontWeight: 'bold', color: '#000000', anchor: 'start' },

    // PNL percentage — beyaz bar y=845-1025, merkez y≈935
    // Sayı alanı x=1130→1900 arası, "%" x=1901'de. Font 80→~60px → top = 935-30 = 905
    { key: 'pnlPercent', x: 1850, y: 885, fontSize: 160, fontWeight: 'bold', color: '#000000', anchor: 'end' },

    // INVESTED value — $ sembol merkez y≈1175 (y=1120-1230), x=2033-2095
    // Sayı sağdan hizalı, $ soluna yapışık → anchor=end, x≈2025. Font 48→36px → top = 1175-18 = 1157
    { key: 'invested', x: 2120, y: 1140, fontSize: 110, fontWeight: 'bold', color: '#FFFFFF', anchor: 'start' },

    // POSITION value — $ sembol merkez y≈1320 (y=1270-1370) → top = 1320-18 = 1302
    { key: 'positionValue', x: 2120, y: 1280, fontSize: 110, fontWeight: 'bold', color: '#FFFFFF', anchor: 'start' },

    // AVG COST value — ¢ sembol merkez y≈1430 (y=1410-1450) → top = 1430-18 = 1412
    { key: 'avgCost', x: 2120, y: 1420, fontSize: 110, fontWeight: 'bold', color: '#FFFFFF', anchor: 'start' },

    // Username — "@" sağ kenarı x≈243, sembol y merkezi≈1450
    { key: 'username', x: 480, y: 1400, fontSize: 80, fontWeight: 'bold', color: '#FFFFFF', anchor: 'start' },

  ],
  profilePic: {
    x: 72,
    y: 1320,
    size: 250,
    circular: false,
  },
};

// ─── Portfolio PNL layout (same template, different data) ───────────────────

export const PORTFOLIO_LAYOUT: TemplateLayoutConfig = {
  ...ALL_TIME_LAYOUT,
};

// ─── Position PNL layout (event title eklendi) ──────────────────────────────

export const POSITION_LAYOUT: TemplateLayoutConfig = {
  ...ALL_TIME_LAYOUT,
  fields: [
    // Event/market title — pill içi
    { key: 'title', x: 1780, y: 270, fontSize: 70, fontWeight: 'bold', color: '#000000', anchor: 'middle', maxWidth: 1200 },
    // Outcome (YES/NO) — pill ile yeşil bar arası karanlık alan (y≈480-560)
    { key: 'outcome', x: 1085, y: 430, fontSize: 70, fontWeight: 'bold', color: '#FFFFFF', anchor: 'middle', maxWidth: 800 },
    ...ALL_TIME_LAYOUT.fields,
  ],
  // Event logo — pill sol tarafındaki shield alanı (x=480-900, y=262-399)
  eventIcon: {
    x: 980,
    y: 220,
    size: 200,
    circular: true,
  },
};

// ─── All-Time card layout (POSITION_LAYOUT but larger title for "Max Realized") ─

export const ALLTIME_CARD_LAYOUT: TemplateLayoutConfig = {
  ...ALL_TIME_LAYOUT,
  fields: [
    // All-time PNL dollar amount (same position as pnlAmount)
    { key: 'pnlAmount', x: 1600, y: 620, fontSize: 230, fontWeight: 'bold', color: '#000000', anchor: 'start' },

    // Total trade count (same position as invested)
    { key: 'tradeCount', x: 2120, y: 1140, fontSize: 110, fontWeight: 'bold', color: '#FFFFFF', anchor: 'start' },

    // Best trade profit (same position as positionValue)
    { key: 'bestTrade', x: 2120, y: 1280, fontSize: 110, fontWeight: 'bold', color: '#FFFFFF', anchor: 'start' },

    // Worst trade loss (same position as avgCost)
    { key: 'worstTrade', x: 2120, y: 1420, fontSize: 110, fontWeight: 'bold', color: '#FFFFFF', anchor: 'start' },

    // Username
    { key: 'username', x: 480, y: 1400, fontSize: 80, fontWeight: 'bold', color: '#FFFFFF', anchor: 'start' },
  ],
};
