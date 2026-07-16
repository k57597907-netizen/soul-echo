import { getSoulById } from "./shared/souls.mjs";
import type { SoulCardStyle } from "./shared/souls.mjs";

// 回声卡数据面。App 的 EchoCard 是它的超集；会话内实时导出只需凑齐这几项。
// intent / emotionShape 用于推导三旋钮 mood（WO-001 已落库；老卡缺字段取默认）。
export interface EchoCardData {
  soulId: string;
  soulName: string;
  echo: string;
  userInput?: string;
  createdAt?: string;
  intent?: string;
  emotionShape?: string;
}

export interface Mood {
  light: -1 | 0 | 1;
  motion: 0 | 1 | 2;
  warm: 0 | 1;
}

export interface RenderOptions {
  includeUserInput?: boolean;
  moodOverride?: Mood;
}

// 逻辑坐标 750x1000，导出 1080x1440（等比 1.44）。所有绘制在逻辑坐标进行。
const LOGICAL_W = 750;
const LOGICAL_H = 1000;
export const EXPORT_SCALE = 1.44;
export const CARD_WIDTH = LOGICAL_W * EXPORT_SCALE; // 1080
export const CARD_HEIGHT = LOGICAL_H * EXPORT_SCALE; // 1440

const SERIF = '"Songti SC", "Noto Serif SC", "STSong", serif';
const SEAL_COLOR = "#A03B28"; // 朱印，五卡唯一不变色，品牌签名

// 竖排参数（R1 §1）
const COL_START_X = 596;
const COL_GAP = 94;
const COL_TOP_Y = 200;
const COL_FONT = 46;
const COL_ADVANCE = 56; // 字号46 + 字距10
const SINGLE_COL_X = 512;
const MAX_COLS = 4;
const SINGLE_MAX = 12;
const MIN_PER_COL = 3;
const USER_INPUT_MAX = 30;

const PUNCT = new Set([..."，。！？；：、）」』”"]);
const isPunct = (c: string) => PUNCT.has(c);

function codePoints(t: string): string[] {
  return [...t];
}

function safeDate(iso?: string): Date {
  const d = iso ? new Date(iso) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function formatDate(iso?: string): string {
  const d = safeDate(iso);
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
}

function compactDate(iso?: string): string {
  const d = safeDate(iso);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}${mm}${dd}`;
}

function truncate(text: string, max: number): string {
  const chars = codePoints(text);
  return chars.length <= max ? text : chars.slice(0, max).join("") + "…";
}

function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// 按 light 档整体提亮/压暗一档
function adjustColor(hex: string, factor: number): string {
  const h = hex.replace("#", "");
  const ch = (i: number) => {
    const v = Math.round(parseInt(h.slice(i, i + 2), 16) * factor);
    return Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
  };
  return `#${ch(0)}${ch(2)}${ch(4)}`;
}

// ---- 三旋钮推导（R1 §3）----
export function deriveMood(card: EchoCardData): Mood {
  const shape = card.emotionShape ?? "";
  const intent = card.intent ?? "";
  let light: Mood["light"] = 0;
  if (intent === "witness" || shape === "苦尽甘来") light = 1;
  else if (shape === "失意" || shape === "执念" || shape === "虚无") light = -1;

  let motion: Mood["motion"] = 0;
  if (shape === "焦虑" || shape === "执念" || shape === "虚无") motion = 2;
  else if (shape === "失意" || shape === "内耗") motion = 1;

  const warm: Mood["warm"] = light === 1 ? 1 : 0;
  return { light, motion, warm };
}

// ---- 竖排折行（R1 §4）----
export function layoutColumns(text: string): { single: boolean; columns: string[] } {
  const chars = codePoints(text.trim());
  const len = chars.length;
  if (len <= SINGLE_MAX) return { single: true, columns: [chars.join("")] };

  let k = Math.min(MAX_COLS, Math.max(2, Math.round(len / 8)));
  while (k > 2 && Math.ceil(len / k) < MIN_PER_COL) k -= 1;

  const base = Math.floor(len / k);
  const rem = len % k;
  const sizes = Array.from({ length: k }, (_, i) => base + (i < rem ? 1 : 0));
  let bounds: number[] = [];
  let acc = 0;
  for (const s of sizes) {
    acc += s;
    bounds.push(acc);
  }

  const cut = (): string[][] => {
    const cols: string[][] = [];
    let start = 0;
    for (const b of bounds) {
      cols.push(chars.slice(start, b));
      start = b;
    }
    return cols;
  };
  const ok = (cols: string[][]) =>
    cols.length <= MAX_COLS &&
    cols.every((c) => c.length >= MIN_PER_COL) &&
    Math.max(...cols.map((c) => c.length)) - Math.min(...cols.map((c) => c.length)) <= 4 &&
    cols.every((c) => !isPunct(c[0]));

  // 优先在标点后断列：把每个内部边界微调到最近标点之后（窗口 ±2）
  for (let i = 0; i < bounds.length - 1; i += 1) {
    for (const d of [0, 1, -1, 2, -2]) {
      const idx = bounds[i] + d;
      if (idx <= 0 || idx >= len) continue;
      if (isPunct(chars[idx - 1])) {
        const saved = bounds;
        bounds = [...bounds];
        bounds[i] = idx;
        if (ok(cut())) break;
        bounds = saved;
      }
    }
  }

  // 兜底：把落到列首的标点拉回上一列列尾
  const cols = cut();
  for (let i = 1; i < cols.length; i += 1) {
    while (cols[i].length && isPunct(cols[i][0]) && cols[i - 1].length < 12) {
      cols[i - 1].push(cols[i].shift() as string);
    }
  }
  return { single: false, columns: cols.filter((c) => c.length).map((c) => c.join("")) };
}

// ---- 场景绘制（Path2D 转写自 comps）----
function strokePath(ctx: CanvasRenderingContext2D, d: string, color: string, width: number, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke(new Path2D(d));
  ctx.restore();
}
function fillPath(ctx: CanvasRenderingContext2D, d: string, color: string, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fill(new Path2D(d));
  ctx.restore();
}
function glowCircle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number, blur: number) {
  ctx.save();
  ctx.filter = `blur(${blur}px)`;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawSushi(ctx: CanvasRenderingContext2D, s: SoulCardStyle, mood: Mood) {
  const ink = s.ink;
  // 斜雨：密度随 motion
  const rainCount = 5 + mood.motion * 3;
  ctx.save();
  ctx.globalAlpha = 0.14;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1;
  for (let i = 0; i < rainCount; i += 1) {
    const x = 70 + (i * 360) / rainCount;
    const y = 140 + (i % 3) * 130;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - 24, y + 100);
    ctx.stroke();
  }
  ctx.restore();
  // 地线与江线水光
  strokePath(ctx, "M36 774 L712 774", ink, 1.4, 0.4);
  strokePath(ctx, "M120 812 L210 812 M250 838 L330 838 M150 864 L205 864", s.accent, 2, 0.4);
  // 草堂
  fillPath(ctx, "M148 676 L245 590 L342 676 Z", "#12241C", 1);
  strokePath(ctx, "M148 676 L245 590 L342 676", ink, 2, 0.82);
  strokePath(ctx, "M200 628 L192 660 M230 612 L224 648 M262 614 L270 650 M292 632 L300 662", s.accent, 1, 0.7);
  strokePath(ctx, "M172 676 L172 774 M318 676 L318 774 M172 676 L318 676", ink, 2, 0.72);
  // 暖窗（全卡唯一暖色）
  glowCircle(ctx, 228, 716, 30, "#E9C47C", 0.55, 12);
  fillPath(ctx, "M210 700 h34 v34 h-34 Z", "#E9C47C", 0.9);
  strokePath(ctx, "M227 700 L227 734 M210 717 L244 717", "#7a5a24", 1, 1);
  // 檐下矮桌 + 两盏茶（叙事物：只有一盏冒热气；warm 档两盏都冒）
  strokePath(ctx, "M262 748 L330 748", ink, 1.6, 0.8);
  strokePath(ctx, "M276 748 q-8 -14 8 -14 q16 0 8 14", ink, 1.6, 0.85);
  strokePath(ctx, "M306 748 q-8 -14 8 -14 q16 0 8 14", ink, 1.6, 0.85);
  strokePath(ctx, "M284 730 q-6 -10 0 -20 q6 -10 0 -20", "#E9C47C", 1.4, 0.75);
  if (mood.warm) strokePath(ctx, "M314 730 q-6 -10 0 -20 q6 -10 0 -20", "#E9C47C", 1.4, 0.7);
}

function drawYangming(ctx: CanvasRenderingContext2D, s: SoulCardStyle, mood: Mood) {
  const ink = s.ink;
  // 窗棂格影：移至上缘中部，避开左上落款与右侧竖排，透明度减半
  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.strokeStyle = s.accent;
  ctx.lineWidth = 1;
  ctx.strokeRect(268, 88, 150, 180);
  ctx.stroke(new Path2D("M318 88 L318 268 M368 88 L368 268 M268 148 L418 148 M268 208 L418 208"));
  ctx.restore();
  // 书案
  strokePath(ctx, "M90 792 L470 792", ink, 2, 0.7);
  strokePath(ctx, "M120 792 L140 860 M440 792 L420 860", ink, 1.6, 0.5);
  // 两页纸（页角微翘）
  fillPath(ctx, "M150 792 L150 706 Q150 700 158 700 L272 700 L272 792 Z", "#1c1610", 0.9);
  fillPath(ctx, "M278 792 L278 700 L392 700 Q400 700 400 706 L400 792 Z", "#1c1610", 0.9);
  strokePath(ctx, "M150 792 L150 706 Q150 700 158 700 L272 700 L272 792", ink, 1.6, 0.9);
  strokePath(ctx, "M278 792 L278 700 L392 700 Q400 700 400 706 L400 792", ink, 1.6, 0.9);
  strokePath(ctx, "M272 700 Q286 690 296 700", ink, 1.6, 0.9);
  strokePath(
    ctx,
    "M170 724 L252 724 M170 742 L252 742 M170 760 L230 760 M298 724 L380 724 M298 742 L360 742",
    s.accent,
    1,
    0.4,
  );
  // 搁下的一支笔（叙事物）
  strokePath(ctx, "M196 792 L330 748", ink, 3, 0.92);
  fillPath(ctx, "M196 792 l-14 5 l3 8 l14 -5 Z", s.accent, 0.8);
  ctx.save();
  ctx.fillStyle = "#1c1610";
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(330, 748, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  // 油灯与径向光晕（warm 档更大更亮）
  const glow = mood.warm ? 0.4 : 0.28;
  const glowR = mood.warm ? 84 : 70;
  glowCircle(ctx, 420, 690, glowR, "#E9C47C", glow, 24);
  fillPath(ctx, "M400 748 L440 748 L432 716 L408 716 Z", "#1c1610", 1);
  strokePath(ctx, "M400 748 L440 748 L432 716 L408 716 Z M420 716 L420 700", ink, 2, 0.85);
  // 灯焰（偏斜随 motion）
  const lean = mood.motion * 6;
  fillPath(ctx, `M420 700 Q${414 - lean} 686 ${420 - lean} 674 Q${426 - lean} 686 420 700 Z`, "#E9C47C", 0.95);
  // 一缕灯烟（长度随 motion）
  const smoke = mood.motion >= 1 ? "M420 672 q-8 -18 2 -40 q8 -18 -2 -40" : "M420 672 q-8 -14 2 -26";
  strokePath(ctx, smoke, ink, 1.2, 0.35);
}

function drawNietzsche(ctx: CanvasRenderingContext2D, s: SoulCardStyle, mood: Mood) {
  const ink = s.ink;
  // 稀疏星
  ctx.save();
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = ink;
  for (const [x, y, r] of [
    [150, 150, 2.4],
    [360, 110, 1.8],
    [96, 300, 1.6],
  ]) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  // 风的斜向刮痕（密度随 motion）
  const wind = 4 + mood.motion * 2;
  for (let i = 0; i < wind; i += 1) {
    const y = 230 + i * (220 / wind);
    strokePath(ctx, `M${60 + (i % 2) * 30} ${y} L${240 + (i % 2) * 90} ${y - 40}`, s.accent, 1, 0.2);
  }
  // 山口晨光（叙事物，唯一暖色）：一线晨光为主角，光晕仅贴线极窄地渗
  const dawnW = mood.warm ? 110 : 86;
  const dawnLine = `M${300 - dawnW} 638 L${300 + dawnW} 638`;
  ctx.save();
  ctx.filter = `blur(${mood.warm ? 5 : 4}px)`;
  strokePath(ctx, dawnLine, "#E07A4A", mood.warm ? 9 : 7, 0.42);
  ctx.restore();
  strokePath(ctx, dawnLine, "#E07A4A", 3, 0.95);
  // 锋利山脊
  const ridge = "M20 720 L150 612 L232 660 L300 626 L368 660 L470 560 L560 636 L680 548 L732 604";
  fillPath(ctx, ridge + " L732 1000 L20 1000 Z", "#0d141c", 0.6);
  strokePath(ctx, ridge, ink, 2.4, 0.9);
}

function drawBuddha(ctx: CanvasRenderingContext2D, s: SoulCardStyle, mood: Mood) {
  const ink = s.ink;
  strokePath(ctx, "M40 616 L712 616", ink, 1.4, 0.5);
  // 远钟小剪影
  strokePath(ctx, "M612 616 L612 540 M660 616 L660 540 M600 540 L672 540", s.accent, 1.4, 0.8);
  fillPath(ctx, "M624 552 Q624 542 636 542 Q648 542 648 552 L650 586 Q636 592 622 586 Z", "#0f0c06", 0.9);
  strokePath(ctx, "M624 552 Q624 542 636 542 Q648 542 648 552 L650 586 Q636 592 622 586 Z M636 586 L636 596", s.accent, 1.4, 0.8);
  // warm 档：水面镀一层微金
  if (mood.warm) {
    ctx.save();
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = "#E9C47C";
    ctx.fillRect(0, 616, LOGICAL_W, 260);
    ctx.restore();
  }
  // 同心涟漪（圈数随 motion；间距逐圈变大）：置于叶正下方水面
  const rippleY = 648;
  const rings = 3 + mood.motion; // 3..5
  const radii = [26, 66, 128, 212, 320];
  const alphas = [0.75, 0.5, 0.32, 0.18, 0.1];
  for (let i = 0; i < rings; i += 1) {
    ctx.save();
    ctx.globalAlpha = alphas[i];
    ctx.strokeStyle = s.accent;
    ctx.lineWidth = 1.8 - i * 0.15;
    ctx.beginPath();
    ctx.ellipse(300, rippleY, radii[i], radii[i] * 0.26, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  // 叙事物：悬停之叶，叶尖抬至水线之上留一线悬空
  fillPath(ctx, "M300 596 Q276 578 300 546 Q324 578 300 596 Z", "#1b160c", 0.95);
  strokePath(ctx, "M300 596 Q276 578 300 546 Q324 578 300 596 Z", ink, 1.6, 0.95);
  strokePath(ctx, "M300 546 L300 590", s.accent, 1, 1);
}

function drawZhuangzi(ctx: CanvasRenderingContext2D, s: SoulCardStyle, mood: Mood) {
  const ink = s.ink;
  // 晨雾：1px 级、两端渐隐的细透水平线（大面积留白）；层数随 motion
  const fog = (y: number, halfW: number, alpha: number, width: number) => {
    const x1 = 375 - halfW;
    const x2 = 375 + halfW;
    const g = ctx.createLinearGradient(x1, y, x2, y);
    g.addColorStop(0, withAlpha(ink, 0));
    g.addColorStop(0.5, withAlpha(ink, alpha));
    g.addColorStop(1, withAlpha(ink, 0));
    ctx.save();
    ctx.strokeStyle = g;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.lineTo(x2, y);
    ctx.stroke();
    ctx.restore();
  };
  fog(536, 322, 0.2, 1.2);
  fog(600, 272, 0.16, 1.1);
  fog(694, 220, 0.14, 1);
  if (mood.motion >= 1) fog(486, 300, 0.13, 1);
  if (mood.motion >= 2) fog(752, 170, 0.11, 1);

  // 远处一叶带桅小舟（叙事物）：弧形船壳 + 桅 + 小帆，舟必须成舟
  fillPath(ctx, "M256 720 Q300 726 344 720 Q300 750 256 720 Z", ink, 0.14);
  strokePath(ctx, "M256 720 Q300 726 344 720 Q300 750 256 720 Z", ink, 1.8, 0.9); // 船壳
  strokePath(ctx, "M300 720 L300 656", ink, 1.8, 0.9); // 桅
  fillPath(ctx, "M300 664 Q322 686 300 704 Z", ink, 0.16); // 帆
  strokePath(ctx, "M300 664 Q322 686 300 704", ink, 1.4, 0.55);
  // warm 档：舟侧一线日光
  if (mood.warm) strokePath(ctx, "M306 664 Q326 688 306 706", "#E9C47C", 1.4, 0.6);

  // 涟漪弧线（船下，寥寥数笔）
  strokePath(ctx, "M250 764 Q300 778 350 764", s.accent, 1.5, 0.5);
  strokePath(ctx, "M210 788 Q300 808 390 788", s.accent, 1.3, 0.3);
  strokePath(ctx, "M170 812 Q300 836 430 812", s.accent, 1.1, 0.16);
}

function drawScene(ctx: CanvasRenderingContext2D, soulId: string, s: SoulCardStyle, mood: Mood) {
  switch (soulId) {
    case "sushi":
      return drawSushi(ctx, s, mood);
    case "yangming":
      return drawYangming(ctx, s, mood);
    case "nietzsche":
      return drawNietzsche(ctx, s, mood);
    case "buddha":
      return drawBuddha(ctx, s, mood);
    case "zhuangzi":
      return drawZhuangzi(ctx, s, mood);
    default:
      return drawSushi(ctx, s, mood);
  }
}

// ---- 竖排回声文字 ----
function drawEcho(ctx: CanvasRenderingContext2D, echo: string, ink: string) {
  const { single, columns } = layoutColumns(echo);
  ctx.save();
  ctx.fillStyle = ink;
  ctx.font = `${COL_FONT}px ${SERIF}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  columns.forEach((col, ci) => {
    const x = single ? SINGLE_COL_X : COL_START_X - ci * COL_GAP;
    codePoints(col).forEach((ch, ri) => {
      ctx.fillText(ch, x, COL_TOP_Y + ri * COL_ADVANCE);
    });
  });
  ctx.restore();
}

// ---- 落款：人物名竖排 + 朱印 + 小日期 ----
function drawColophon(ctx: CanvasRenderingContext2D, card: EchoCardData, s: SoulCardStyle) {
  const top = s.sealCorner === "top";
  const nameX = 80;
  const nameTopY = top ? 132 : 792;
  const nameChars = codePoints(card.soulName);
  ctx.save();
  ctx.fillStyle = s.accent;
  ctx.font = `34px ${SERIF}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  nameChars.forEach((ch, i) => ctx.fillText(ch, nameX, nameTopY + i * 40));
  ctx.restore();

  // 朱印
  const sealX = 54;
  const sealY = nameTopY + nameChars.length * 40 + 8;
  ctx.save();
  ctx.fillStyle = SEAL_COLOR;
  roundRect(ctx, sealX, sealY, 52, 52, 5);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = `21px ${SERIF}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("回", sealX + 26, sealY + 23);
  ctx.fillText("声", sealX + 26, sealY + 46);
  ctx.restore();

  // 小日期（竖排在印章右侧）
  ctx.save();
  ctx.fillStyle = withAlpha(s.accent, 0.7);
  ctx.font = `16px ${SERIF}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const dateChars = codePoints(formatDate(card.createdAt));
  dateChars.forEach((ch, i) => ctx.fillText(ch, sealX + 64, sealY + 12 + i * 18));
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---- 纸纹颗粒噪点 ----
function drawGrain(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const tile = 128;
  const noise = document.createElement("canvas");
  noise.width = tile;
  noise.height = tile;
  const nctx = noise.getContext("2d");
  if (!nctx) return;
  const img = nctx.createImageData(tile, tile);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.floor(Math.random() * 255);
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  nctx.putImageData(img, 0, 0);
  const pattern = ctx.createPattern(noise, "repeat");
  if (!pattern) return;
  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.globalCompositeOperation = "overlay";
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

export function renderEchoCard(
  canvas: HTMLCanvasElement,
  card: EchoCardData,
  options: RenderOptions = {},
): void {
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const soul = getSoulById(card.soulId);
  const style = soul.cardStyle;
  const mood = options.moodOverride ?? deriveMood(card);
  const lightFactor = 1 + mood.light * 0.1;

  ctx.setTransform(EXPORT_SCALE, 0, 0, EXPORT_SCALE, 0, 0);

  // 背景渐变（随 light 提亮/压暗）
  const bg = ctx.createLinearGradient(0, 0, 0, LOGICAL_H);
  bg.addColorStop(0, adjustColor(style.bgTop, lightFactor));
  bg.addColorStop(1, adjustColor(style.bgBottom, lightFactor));
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

  drawScene(ctx, soul.id, style, mood);
  drawEcho(ctx, card.echo, style.ink);
  drawColophon(ctx, card, style);

  // 困境行（可选，默认关）：横排小字，卡底引导行之上
  if (options.includeUserInput && card.userInput && card.userInput.trim()) {
    ctx.save();
    ctx.fillStyle = withAlpha(style.ink, 0.5);
    ctx.font = `22px ${SERIF}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(`——因为你说：「${truncate(card.userInput.trim(), USER_INPUT_MAX)}」`, LOGICAL_W / 2, 926);
    ctx.restore();
  }

  // 底部引导行
  ctx.save();
  ctx.fillStyle = withAlpha(style.ink, 0.42);
  ctx.font = `15px ${SERIF}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const guideVerb = card.intent === "witness" ? "把好消息说给了" : "把心事说给了";
  ctx.fillText(`TA${guideVerb}${card.soulName}｜灵魂回声`, LOGICAL_W / 2, 962);
  ctx.restore();

  // 纸纹（设备像素空间，覆盖全卡）
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawGrain(ctx, CARD_WIDTH, CARD_HEIGHT);
}

export function echoCardToDataURL(card: EchoCardData, options: RenderOptions = {}): string {
  const canvas = document.createElement("canvas");
  renderEchoCard(canvas, card, options);
  return canvas.toDataURL("image/png");
}

export function downloadEchoCard(card: EchoCardData, options: RenderOptions = {}): void {
  const canvas = document.createElement("canvas");
  renderEchoCard(canvas, card, options);
  const fileName = `灵魂回声-${card.soulName}-${compactDate(card.createdAt)}.png`;
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, "image/png");
}
