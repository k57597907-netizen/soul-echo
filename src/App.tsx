import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Download,
  ImageDown,
  Loader2,
  Menu,
  Play,
  Send,
  Sparkles,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import BoomerangVideoBg from "./BoomerangVideoBg";
import {
  downloadEchoCard,
  echoCardToDataURL,
  type EchoCardData,
  type Mood,
} from "./echoCard";
import {
  buildFallbackReply,
  buildOpeningText,
  getSoulById,
  soulMatchesName,
  souls,
} from "./shared/souls.mjs";
import type { SoulConfig, SoulId } from "./shared/souls.mjs";

const BG_VIDEO =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260511_131941_d136af49-e243-493a-be14-6ff3f24e09e6.mp4";
const ECHO_STORAGE_KEY = "soul-echo.cards.v1";
const MUTED_STORAGE_KEY = "soul-echo.muted.v1";

// 动效与音频时长常量（WO-003 §6，便于日后调参；单位 ms）
const MOTION = {
  sensingMinMs: 800, // 感应等待最短停留，避免闪跳
  entranceSceneMs: 800, // 入场①场景亮起
  entranceNameMs: 800, // 入场②人物名 + entranceLine
  entranceOpeningMs: 900, // 入场③开场白浮现
  entranceTotalMs: 2500, // 入场总时长
  lineRevealBaseMs: 450, // 逐行浮现基础间隔
  lineRevealMaxMs: 650, // 逐行浮现最大间隔（长行）
  echoPauseMs: 900, // 回声出现前停顿
  audioFadeInMs: 2000, // 环境声淡入
  audioFadeOutMs: 800, // 环境声淡出
  audioTargetVolume: 0.35, // 环境声低音量目标
};

// 首页占位轮播（WO-004 §1.3）：依次演示 witness/pour_out/inquire/meet/gift 五种意图
const PLACEHOLDER_EXAMPLES = [
  "我考上了，三年了终于考上了",
  "努力了很久，还没有结果",
  "尼采怎么看自卑？",
  "今晚想和苏轼喝杯茶",
  "朋友失恋了，想替她求一句话",
];
const PLACEHOLDER_INTERVAL_MS = 4000;

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// 某一行的浮现延迟 = 之前各行步进之和；行越长，步进略久（450–650ms）
function lineStep(text: string): number {
  return [...text].length > 16 ? MOTION.lineRevealMaxMs : MOTION.lineRevealBaseMs;
}
function lineRevealDelay(lines: string[], index: number): number {
  return lines.slice(0, index).reduce((sum, line) => sum + lineStep(line), 0);
}

type View = "home" | "sensing" | "session" | "echoes";
type RhythmStage = "mirror" | "reframe" | "action" | "echo" | "receive" | "magnify" | "free";
type Message = {
  role: "user" | "soul";
  text: string;
};
type EchoCard = {
  id: string;
  createdAt: string;
  soulId: SoulId;
  soulName: string;
  userInput: string;
  intent: string;
  emotionShape: string;
  echo: string;
  scene: string;
  conversationSummary: string;
};
type SensingOption = {
  soul: SoulConfig;
  snippet: string;
  reason: string;
};
type RouteMode = "model" | "fallback" | "local";
type RouteResult = {
  mode: RouteMode;
  crisisFlag: boolean;
  intent: string;
  intentSecondary: string | null;
  emotionShape: string;
  options: SensingOption[];
};
type RouteResponse = {
  mode: RouteMode;
  crisisFlag: boolean;
  intent: string;
  intentSecondary: string | null;
  emotionShape: string;
  recommendations: { soulId: SoulId; snippet: string; reason: string }[];
};

const intentLabels: Record<string, string> = {
  pour_out: "我有话想说",
  inquire: "我想请教",
  meet: "想见一位灵魂",
  crossroad: "面临抉择",
  witness: "想被见证",
  gift: "替人求一句",
  casual: "随便聊聊",
  unknown: "未明",
};

const CRISIS_TEXT =
  "这已经不是一句话能独自扛住的苦。请现在联系一个真实的人——朋友、家人，或当地的紧急电话与心理援助热线。你不需要独自处理这一刻。";

function labelIntent(intent: string) {
  return intentLabels[intent] ?? intent;
}

const rhythmStageLabels: Record<RhythmStage, string> = {
  mirror: "镜像共情",
  reframe: "视角重构",
  action: "破壁动作",
  echo: "结缘回声",
  receive: "接过喜悦",
  magnify: "放大意义",
  free: "自由交谈",
};


function includesAny(text: string, words: string[]) {
  return words.some((word) => text.includes(word));
}

function getSoul(id: SoulId) {
  return getSoulById(id);
}

function buildSensingOption(soul: SoulConfig, input: string): SensingOption {
  const explicit = soulMatchesName(soul, input);
  return {
    soul,
    snippet: explicit ? `${soul.name}听见你在找他。${soul.sensing.snippet}` : soul.sensing.snippet,
    reason: soul.sensing.reason,
  };
}

function routeInput(input: string): RouteResult {
  const text = input.toLowerCase();
  const explicitSouls = souls.filter((soul) => soulMatchesName(soul, input));
  const ordered: SoulConfig[] = [];

  const add = (soul: SoulConfig) => {
    if (!ordered.some((item) => item.id === soul.id)) ordered.push(soul);
  };

  explicitSouls.forEach(add);

  souls.forEach((soul) => {
    if (includesAny(text, soul.routing.keywords)) add(soul);
  });

  if (ordered.length === 0) {
    add(getSoul("sushi"));
    add(getSoul("yangming"));
    add(getSoul("zhuangzi"));
  }
  if (ordered.length === 1) {
    add(ordered[0].id === "sushi" ? getSoul("yangming") : getSoul("sushi"));
    add(ordered[0].id === "nietzsche" ? getSoul("zhuangzi") : getSoul("nietzsche"));
  }
  if (ordered.length === 2) add(getSoul("zhuangzi"));

  const intent = explicitSouls.length > 0 ? "meet" : /怎么看|请教|如何理解|聊聊/.test(input) ? "inquire" : "pour_out";
  const emotionShape = ordered[0]?.routing.emotionShape ?? "未明";

  return {
    mode: "local",
    crisisFlag: false,
    intent,
    intentSecondary: null,
    emotionShape,
    options: ordered.slice(0, 3).map((soul) => buildSensingOption(soul, input)),
  };
}

function toRouteResult(data: RouteResponse): RouteResult {
  return {
    mode: data.mode,
    crisisFlag: Boolean(data.crisisFlag),
    intent: data.intent,
    intentSecondary: data.intentSecondary ?? null,
    emotionShape: data.emotionShape,
    options: (data.recommendations ?? []).map((item) => ({
      soul: getSoulById(item.soulId),
      snippet: item.snippet,
      reason: item.reason,
    })),
  };
}

function getNextRhythmStage(
  intent: string,
  nextUserTurn: number,
  returnedFromAction: boolean,
): RhythmStage {
  // 相见/闲聊：不套节奏机
  if (intent === "meet" || intent === "casual") return "free";
  // 见证：接过喜悦 → 放大意义 → 贺辞回声
  if (intent === "witness") {
    if (nextUserTurn <= 1) return "receive";
    if (nextUserTurn === 2) return "magnify";
    return "echo";
  }
  // 倾诉等：原逻辑一行不改
  if (returnedFromAction) return "action";
  if (nextUserTurn <= 1) return "mirror";
  if (nextUserTurn === 2) return "reframe";
  if (nextUserTurn === 3) return "action";
  return "echo";
}

// 首页/入场用：按 intent 决定开场阶段
function openingRhythmStage(intent: string | undefined): RhythmStage {
  if (intent === "witness") return "receive";
  if (intent === "meet" || intent === "casual") return "free";
  return "mirror";
}

function SoulScene({ soul, ambienceOn }: { soul: SoulConfig; ambienceOn: boolean }) {
  return (
    <div className="absolute inset-0 overflow-hidden">
      <div className="absolute inset-0" style={{ background: soul.sceneStyle.base }} />
      <div className="absolute inset-0 opacity-90" style={{ background: soul.sceneStyle.light }} />
      <div className="absolute inset-0 opacity-95" style={{ background: soul.sceneStyle.ground }} />
      <div
        className={`absolute left-[10%] top-[20%] h-56 w-56 rounded-full border border-white/12 bg-white/10 blur-xl transition-opacity duration-700 ${
          ambienceOn ? "opacity-70" : "opacity-20"
        }`}
        style={{ animation: ambienceOn ? "ambientDrift 18s ease-in-out infinite" : undefined }}
      />
      <div
        className={`absolute right-[14%] top-[32%] h-44 w-44 rounded-full border border-white/10 bg-black/10 blur-2xl transition-opacity duration-700 ${
          ambienceOn ? "opacity-60" : "opacity-15"
        }`}
        style={{ animation: ambienceOn ? "ambientPulse 9s ease-in-out infinite" : undefined }}
      />
      <div className="absolute inset-x-[-10%] bottom-[35%] h-px bg-white/24" />
      <div className="absolute left-[12%] top-[16%] h-48 w-48 rounded-full border border-white/16 bg-white/8 blur-sm" />
      <div className="absolute right-[8%] top-[12%] h-72 w-72 rounded-full border border-white/10 bg-black/10 blur-md" />
      <div className="absolute bottom-[6%] left-[8%] h-44 w-[84%] rounded-[100%] bg-black/22 blur-3xl" />
      <div className="absolute bottom-[24%] left-1/2 h-40 w-40 -translate-x-1/2 rounded-full border border-white/26 bg-white/12 text-center text-7xl leading-[10rem] text-white/30 shadow-2xl shadow-black/30 backdrop-blur-sm">
        {soul.sceneStyle.symbol}
      </div>
      <div className="absolute bottom-[24%] left-1/2 h-56 w-56 -translate-x-1/2 rounded-full border border-white/10" />
      <div className="absolute bottom-[24%] left-1/2 h-72 w-72 -translate-x-1/2 rounded-full border border-white/8" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,rgba(5,12,10,.18)_58%,rgba(5,12,10,.52)_100%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,.04)_1px,transparent_1px),linear-gradient(0deg,rgba(255,255,255,.035)_1px,transparent_1px)] bg-[size:72px_72px] opacity-30" />
    </div>
  );
}

function EchoCardExportModal({
  card,
  onClose,
}: {
  card: EchoCardData;
  onClose: () => void;
}) {
  const [includeUserInput, setIncludeUserInput] = useState(false);
  const [previewSrc, setPreviewSrc] = useState("");
  const hasUserInput = Boolean(card.userInput && card.userInput.trim());
  const withInput = includeUserInput && hasUserInput;

  useEffect(() => {
    setPreviewSrc(echoCardToDataURL(card, { includeUserInput: withInput }));
  }, [card, withInput]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90dvh] w-full max-w-md flex-col overflow-y-auto rounded-[2rem] border border-white/60 bg-[#fbf8ee] p-5 shadow-2xl shadow-black/30 sm:p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm font-semibold text-[#587151]">保存回声卡</p>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-[#52604c] transition hover:bg-black/5"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 预览走 img（由全尺寸 canvas 转 dataURL），便于 iOS 长按保存 */}
        <div className="mx-auto w-full max-w-[300px]">
          {previewSrc && (
            <img
              src={previewSrc}
              alt={`${card.soulName}的回声卡预览`}
              className="w-full rounded-2xl shadow-lg shadow-black/20"
            />
          )}
          <p className="mt-2 text-center text-xs text-[#8a927e]">长按图片可保存</p>
        </div>

        {hasUserInput && (
          <label className="mt-5 flex cursor-pointer items-center gap-3 rounded-2xl border border-[#1f2a1d]/10 bg-white/70 px-4 py-3 text-sm text-[#33402f]">
            <input
              type="checkbox"
              checked={includeUserInput}
              onChange={(event) => setIncludeUserInput(event.target.checked)}
              className="h-4 w-4 accent-[#1f2a1d]"
            />
            带上我的这句话
          </label>
        )}

        <button
          type="button"
          onClick={() => downloadEchoCard(card, { includeUserInput: withInput })}
          className="mt-5 flex items-center justify-center gap-2 rounded-full bg-[#1f2a1d] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#2a3827] active:translate-y-px"
        >
          <Download className="h-4 w-4" />
          下载回声卡
        </button>
      </div>
    </div>
  );
}

// 开发用样卡页（?samples）：一屏排出 WO-002 §5 要求的 7 张样卡，各带下载。
// 用 mood 覆盖精确生成，不参与正常产品流程。main.tsx 据 URL 决定是否渲染。
export function SamplesGallery() {
  const specs: { soulId: SoulId; label: string; mood: Mood }[] = [
    { soulId: "sushi", label: "苏轼 · 标准档", mood: { light: 0, motion: 0, warm: 0 } },
    { soulId: "yangming", label: "王阳明 · 标准档", mood: { light: 0, motion: 0, warm: 0 } },
    { soulId: "buddha", label: "佛陀 · 标准档", mood: { light: 0, motion: 0, warm: 0 } },
    { soulId: "nietzsche", label: "尼采 · 标准档", mood: { light: 0, motion: 0, warm: 0 } },
    { soulId: "zhuangzi", label: "庄子 · 标准档", mood: { light: 0, motion: 0, warm: 0 } },
    { soulId: "sushi", label: "苏轼 · 亮档", mood: { light: 1, motion: 0, warm: 1 } },
    { soulId: "buddha", label: "佛陀 · 动势2档", mood: { light: 0, motion: 2, warm: 0 } },
  ];
  return (
    <section className="min-h-[100dvh] w-full bg-[#14110c] px-6 py-12">
      <h1 className="mb-8 text-center text-2xl font-semibold text-[#e9e2d0]">
        回声卡样卡 · WO-002 R1
      </h1>
      <div className="mx-auto grid max-w-6xl gap-8 sm:grid-cols-2 lg:grid-cols-3">
        {specs.map((spec) => {
          const soul = getSoulById(spec.soulId);
          const card: EchoCardData = {
            soulId: soul.id,
            soulName: soul.name,
            echo: soul.fallback.echo,
            createdAt: "2026-07-11T00:00:00",
          };
          const opts = { moodOverride: spec.mood };
          return (
            <div key={spec.label} className="flex flex-col items-center gap-3">
              <p className="text-sm font-semibold text-[#cdb27a]">{spec.label}</p>
              <img
                src={echoCardToDataURL(card, opts)}
                alt={spec.label}
                className="w-full max-w-[280px] rounded-xl shadow-lg shadow-black/40"
              />
              <button
                type="button"
                onClick={() => downloadEchoCard(card, opts)}
                className="rounded-full bg-[#cdb27a] px-4 py-1.5 text-xs font-semibold text-[#14110c]"
              >
                下载
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [view, setView] = useState<View>("home");
  const [dilemma, setDilemma] = useState("");
  const [routeResult, setRouteResult] = useState<RouteResult | null>(null);
  const [selectedSoul, setSelectedSoul] = useState<SoulConfig>(souls[0]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [echo, setEcho] = useState(souls[0].echo);
  const [echoCards, setEchoCards] = useState<EchoCard[]>([]);
  const [reply, setReply] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isSensing, setIsSensing] = useState(false);
  const [sensingError, setSensingError] = useState("");
  const [rhythmStage, setRhythmStage] = useState<RhythmStage>("mirror");
  const [muted, setMuted] = useState(false);
  const [audioAvailable, setAudioAvailable] = useState(false);
  const [entering, setEntering] = useState(false);
  const [skipReveal, setSkipReveal] = useState(false);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const [placeholderActive, setPlaceholderActive] = useState(true);
  const [exportCard, setExportCard] = useState<EchoCardData | null>(null);
  const ambienceOn = true; // 视觉场景氛围常开；reduced-motion 由 CSS 兜底
  const audioRef = useRef<HTMLAudioElement>(null);
  const fadeRef = useRef<number | null>(null);
  const entranceTimer = useRef<number | null>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 首页占位轮播：每 4 秒切换；聚焦输入框后停止
  useEffect(() => {
    if (!placeholderActive) return;
    const id = window.setInterval(
      () => setPlaceholderIndex((i) => (i + 1) % PLACEHOLDER_EXAMPLES.length),
      PLACEHOLDER_INTERVAL_MS,
    );
    return () => window.clearInterval(id);
  }, [placeholderActive]);

  // 今晚推荐：按日期哈希选人物与句子（同一天稳定、跨天轮换）
  const nightPick = useMemo(() => {
    const d = new Date();
    const key = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    const soul = souls[key % souls.length];
    return { soul, line: soul.nightLines[key % soul.nightLines.length] };
  }, []);

  // 切换灵魂时重置音频可用性（缺文件则保持不可用 → 不显示开关）
  useEffect(() => {
    setAudioAvailable(false);
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
  }, [selectedSoul.id, selectedSoul.ambient.audioSrc]);

  // 环境声管线：入场淡入、离场/静音淡出；自动播放被拦截则等下次交互再淡入
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !selectedSoul.ambient.audioSrc || !audioAvailable) return;

    const clearFade = () => {
      if (fadeRef.current) {
        window.clearInterval(fadeRef.current);
        fadeRef.current = null;
      }
    };
    const fadeTo = (target: number, ms: number, onDone?: () => void) => {
      clearFade();
      if (prefersReducedMotion()) {
        audio.volume = target;
        onDone?.();
        return;
      }
      const from = audio.volume;
      const steps = Math.max(1, Math.round(ms / 50));
      let i = 0;
      fadeRef.current = window.setInterval(() => {
        i += 1;
        audio.volume = Math.min(1, Math.max(0, from + (target - from) * (i / steps)));
        if (i >= steps) {
          clearFade();
          onDone?.();
        }
      }, 50);
    };

    const shouldPlay = view === "session" && !muted;
    if (shouldPlay) {
      audio.volume = 0;
      const start = () => fadeTo(MOTION.audioTargetVolume, MOTION.audioFadeInMs);
      audio
        .play()
        .then(start)
        .catch(() => {
          // 自动播放被浏览器策略拦截：静默等待下一次用户交互再淡入
          const resume = () => {
            audio.play().then(start).catch(() => undefined);
            window.removeEventListener("pointerdown", resume);
            window.removeEventListener("keydown", resume);
          };
          window.addEventListener("pointerdown", resume, { once: true });
          window.addEventListener("keydown", resume, { once: true });
        });
    } else {
      fadeTo(0, MOTION.audioFadeOutMs, () => audio.pause());
    }
    return clearFade;
  }, [view, muted, audioAvailable, selectedSoul.ambient.audioSrc]);

  // 静音选择持久化
  useEffect(() => {
    try {
      setMuted(window.localStorage.getItem(MUTED_STORAGE_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(ECHO_STORAGE_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as EchoCard[];
      if (Array.isArray(parsed)) setEchoCards(parsed);
    } catch {
      setEchoCards([]);
    }
  }, []);

  const persistEchoCards = (cards: EchoCard[]) => {
    setEchoCards(cards);
    window.localStorage.setItem(ECHO_STORAGE_KEY, JSON.stringify(cards));
  };

  const navLinks = useMemo(
    () => [
      { href: "#souls", label: "灵魂" },
      { href: "#process", label: "过程" },
      { href: "#echo", label: "回声" },
    ],
    [],
  );

  const returnHome = () => {
    setMenuOpen(false);
    setView("home");
  };

  const showEchoes = () => {
    setMenuOpen(false);
    setView("echoes");
  };

  const resetHome = () => {
    setView("home");
    setReply("");
    setSensingError("");
    setRouteResult(null);
    setIsStarting(false);
    setIsSending(false);
    setRhythmStage("mirror");
    setEntering(false);
    if (entranceTimer.current) {
      window.clearTimeout(entranceTimer.current);
      entranceTimer.current = null;
    }
  };

  const toggleMute = () => {
    setMuted((value) => {
      const next = !value;
      try {
        window.localStorage.setItem(MUTED_STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  // 入场仪式：任意点击立即完成，直达可输入
  const skipEntrance = () => {
    if (!entering) return;
    if (entranceTimer.current) {
      window.clearTimeout(entranceTimer.current);
      entranceTimer.current = null;
    }
    setEntering(false);
  };

  // 逐行浮现中用户开始输入/点击 → 剩余行立即全显
  const revealNow = () => setSkipReveal(true);

  const senseSouls = async (event?: FormEvent) => {
    event?.preventDefault();
    const cleanDilemma = dilemma.trim();
    if (!cleanDilemma || isSensing) return;

    setSensingError("");
    setIsSensing(true);
    const started = Date.now();
    // 强制最短停留：即便响应更快也停满，避免闪跳
    const holdMin = async () => {
      const wait = MOTION.sensingMinMs - (Date.now() - started);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    };

    try {
      const response = await fetch("/api/route", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: cleanDilemma }),
      });

      if (response.status === 400) {
        await holdMin();
        setSensingError("这句话有点长，先收到 500 字以内再说给我听。");
        return;
      }
      if (!response.ok) throw new Error("route unavailable");

      const result = toRouteResult((await response.json()) as RouteResponse);
      await holdMin();
      setRouteResult(result);
      setView("sensing");
    } catch {
      const result = routeInput(cleanDilemma);
      await holdMin();
      setRouteResult(result);
      setView("sensing");
    } finally {
      setIsSensing(false);
    }
  };

  const beginSession = async (soul: SoulConfig, event?: FormEvent) => {
    event?.preventDefault();
    const cleanDilemma = dilemma.trim();
    if (!cleanDilemma || isStarting) return;

    const openStage = openingRhythmStage(routeResult?.intent);
    setIsStarting(true);
    setSelectedSoul(soul);
    setEcho(soul.echo);
    setRhythmStage(openStage);
    setSkipReveal(false);
    const userMessage = { role: "user" as const, text: cleanDilemma };
    setMessages([userMessage]);
    setReply("");
    setView("session");

    // 入场仪式（~2.5s，可点击跳过）；reduced-motion 直达对话
    if (entranceTimer.current) window.clearTimeout(entranceTimer.current);
    if (!prefersReducedMotion()) {
      setEntering(true);
      entranceTimer.current = window.setTimeout(() => {
        setEntering(false);
        entranceTimer.current = null;
      }, MOTION.entranceTotalMs);
    }

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stage: "opening",
          rhythmStage: openStage,
          userMessage: cleanDilemma,
          soul: soul.id,
          intent: routeResult?.intent ?? null,
          intentSecondary: routeResult?.intentSecondary ?? null,
          emotionShape: routeResult?.emotionShape ?? null,
        }),
      });
      if (!response.ok) throw new Error("opening unavailable");
      const data = (await response.json()) as {
        replyLines?: string[];
        echo?: string;
        rhythmStage?: RhythmStage;
        crisisFlag?: boolean;
      };
      if (data.crisisFlag) {
        setMessages([userMessage, { role: "soul", text: CRISIS_TEXT }]);
      } else {
        const text =
          data.replyLines?.filter(Boolean).join("\n") ||
          `${buildOpeningText(soul, cleanDilemma)}\n\n${soul.action}`;
        setMessages([userMessage, { role: "soul", text }]);
        setEcho(data.echo || soul.echo);
        setRhythmStage(data.rhythmStage || openStage);
      }
    } catch {
      setMessages([
        userMessage,
        { role: "soul", text: `${buildOpeningText(soul, cleanDilemma)}\n\n${soul.action}` },
      ]);
    } finally {
      setIsStarting(false);
    }
  };

  const sendReply = async (event: FormEvent) => {
    event.preventDefault();
    const cleanReply = reply.trim();
    if (!cleanReply || isSending) return;

    setReply("");
    setIsSending(true);
    setSkipReveal(false);
    const returnedFromAction = /茶|水|喝|做了|写了|呼吸|整理|闭眼|写下|松/.test(cleanReply);
    const nextUserTurn = messages.filter((message) => message.role === "user").length + 1;
    const nextRhythmStage = getNextRhythmStage(routeResult?.intent ?? "", nextUserTurn, returnedFromAction);
    setRhythmStage(nextRhythmStage);
    setMessages((current) => [...current, { role: "user", text: cleanReply }]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stage: "continue",
          rhythmStage: nextRhythmStage,
          userMessage: cleanReply,
          soul: selectedSoul.id,
          returnedFromAction,
          history: messages.slice(-8),
          intent: routeResult?.intent ?? null,
          intentSecondary: routeResult?.intentSecondary ?? null,
          emotionShape: routeResult?.emotionShape ?? null,
        }),
      });

      if (!response.ok) throw new Error("chat unavailable");
      const data = (await response.json()) as {
        replyLines?: string[];
        echo?: string;
        rhythmStage?: RhythmStage;
        crisisFlag?: boolean;
      };
      if (data.crisisFlag) {
        setMessages((current) => [...current, { role: "soul", text: CRISIS_TEXT }]);
      } else {
        const text =
          data.replyLines?.filter(Boolean).join("\n") ||
          buildFallbackReply(selectedSoul, cleanReply).reply;
        setMessages((current) => [...current, { role: "soul", text }]);
        setEcho(data.echo || selectedSoul.echo);
        setRhythmStage(data.rhythmStage || nextRhythmStage);
      }
    } catch {
      const local = buildFallbackReply(selectedSoul, cleanReply);
      setMessages((current) => [...current, { role: "soul", text: local.reply }]);
      setEcho(local.echo);
    } finally {
      setIsSending(false);
    }
  };

  const buildConversationSummary = () => {
    const soulLine = [...messages].reverse().find((message) => message.role === "soul")?.text ?? "";
    return soulLine.split("\n").filter(Boolean).slice(0, 2).join(" ");
  };

  const generateEchoCard = () => {
    const card: EchoCard = {
      id: `${Date.now()}-${selectedSoul.id}`,
      createdAt: new Date().toISOString(),
      soulId: selectedSoul.id,
      soulName: selectedSoul.name,
      userInput: dilemma.trim(),
      intent: routeResult?.intent ?? "一次相遇",
      emotionShape: routeResult?.emotionShape ?? selectedSoul.domain.split("、")[0],
      echo,
      scene: selectedSoul.scene,
      conversationSummary: buildConversationSummary(),
    };
    persistEchoCards([card, ...echoCards].slice(0, 30));
    setView("echoes");
  };

  const canGenerateEcho = messages.filter((message) => message.role === "user").length >= 2;

  // 打开导出弹层（对话列回声时刻 = 全站唯一的图片保存入口）
  const openEchoExport = () =>
    setExportCard({
      soulId: selectedSoul.id,
      soulName: selectedSoul.name,
      echo,
      userInput: dilemma.trim(),
      createdAt: new Date().toISOString(),
      intent: routeResult?.intent,
      emotionShape: routeResult?.emotionShape,
    });

  // 回声时刻：节奏走到 echo 阶段、且最新一句是灵魂回复时，回声特殊出场
  const latestMessage = messages[messages.length - 1];
  const latestSoulLines =
    latestMessage && latestMessage.role === "soul"
      ? latestMessage.text.split("\n").filter(Boolean)
      : [];
  const echoMomentActive = rhythmStage === "echo" && latestSoulLines.length > 0;
  const echoRevealDelayMs = skipReveal
    ? 0
    : lineRevealDelay(latestSoulLines, latestSoulLines.length) + MOTION.echoPauseMs;

  return (
    <section
      className={`relative min-h-[100dvh] w-full bg-[#eef1e4] ${
        view === "session" ? "overflow-hidden" : "overflow-x-hidden overflow-y-auto"
      }`}
    >
      <style>
        {`
          @keyframes ambientDrift {
            0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
            50% { transform: translate3d(18px, -22px, 0) scale(1.08); }
          }
          @keyframes ambientPulse {
            0%, 100% { transform: scale(0.94); opacity: .42; }
            50% { transform: scale(1.14); opacity: .72; }
          }
          @keyframes echoBreathe {
            0%, 100% { opacity: .4; transform: scale(0.85); }
            50% { opacity: .8; transform: scale(1.15); }
          }
          @keyframes lineReveal {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
          }
          @keyframes riseFade {
            from { opacity: 0; transform: translateY(14px); }
            to { opacity: 1; transform: translateY(0); }
          }
          @keyframes softIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          .anim-line { opacity: 0; animation: lineReveal 0.5s ease-out forwards; }
          .anim-rise { opacity: 0; animation: riseFade 0.7s ease-out forwards; }
          .anim-soft { opacity: 0; animation: softIn 0.6s ease-out forwards; }
          @media (prefers-reduced-motion: reduce) {
            .anim-line, .anim-rise, .anim-soft {
              opacity: 1 !important;
              animation: none !important;
            }
          }
          @media (prefers-reduced-motion: reduce) {
            * {
              animation-duration: 0.001ms !important;
              animation-iteration-count: 1 !important;
              transition-duration: 0.001ms !important;
              scroll-behavior: auto !important;
            }
          }
        `}
      </style>
      {selectedSoul.ambient.audioSrc && (
        <audio
          ref={audioRef}
          loop
          preload="auto"
          src={selectedSoul.ambient.audioSrc}
          onCanPlay={() => setAudioAvailable(true)}
          onError={() => setAudioAvailable(false)}
        />
      )}
      {view === "session" ? (
        <SoulScene soul={selectedSoul} ambienceOn={ambienceOn} />
      ) : (
        <>
          <BoomerangVideoBg src={BG_VIDEO} className="absolute inset-0 h-full w-full" />
          <div className="absolute inset-0 bg-gradient-to-br from-white/20 via-white/5 to-[#1f2a1d]/25" />
          <div className="absolute inset-0 bg-white/20" />
        </>
      )}

      <nav className="absolute left-0 right-0 top-0 z-30 flex items-center justify-between py-4 pl-4 pr-16 sm:py-6 sm:pl-6 sm:pr-20 md:pl-10 md:pr-24">
        <button onClick={resetHome} className="flex items-center gap-2 text-[#2d3a2a]">
          <span className="text-lg font-semibold tracking-tight sm:text-xl md:text-2xl">
            灵魂回声
          </span>
        </button>

        <div className="hidden max-w-[min(46rem,calc(100vw-18rem))] items-center gap-1 rounded-full border border-white/60 bg-white/70 py-1 pl-5 pr-1 shadow-sm backdrop-blur-md 2xl:flex">
          {navLinks.map((link, i) => (
            <a
              key={link.href}
              href={link.href}
              onClick={(event) => {
                if (link.label === "回声") {
                  event.preventDefault();
                  showEchoes();
                }
              }}
              className={`px-2.5 py-2 text-sm transition-colors ${
                i === 0
                  ? "font-semibold text-[#1f2a1d]"
                  : "font-medium text-[#4b5b47] hover:text-[#1f2a1d]"
              }`}
            >
              {link.label}
            </a>
          ))}
          <button
            onClick={returnHome}
            className="ml-1 shrink-0 rounded-full bg-[#1f2a1d] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#2a3827]"
          >
            开始
          </button>
        </div>

        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="relative flex h-10 w-10 items-center justify-center rounded-full border border-white/60 bg-white/70 text-[#1f2a1d] backdrop-blur-md transition-all duration-300 hover:bg-white/90 2xl:hidden"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
        >
          <Menu
            className={`absolute h-5 w-5 transition-all duration-300 ${
              menuOpen ? "rotate-90 scale-50 opacity-0" : "rotate-0 scale-100 opacity-100"
            }`}
          />
          <X
            className={`absolute h-5 w-5 transition-all duration-300 ${
              menuOpen ? "rotate-0 scale-100 opacity-100" : "-rotate-90 scale-50 opacity-0"
            }`}
          />
        </button>
      </nav>

      <div
        className={`fixed inset-0 z-20 transition-opacity duration-300 lg:hidden ${
          menuOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setMenuOpen(false)}
      >
        <div className="absolute inset-0 bg-[#1f2a1d]/40 backdrop-blur-sm" />
      </div>

      <div
        className={`fixed bottom-0 right-0 top-0 z-20 w-[85%] max-w-sm bg-white/95 shadow-2xl backdrop-blur-xl transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] 2xl:hidden ${
          menuOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex h-full flex-col px-8 pb-8 pt-24">
          {navLinks.map((link, i) => (
            <a
              key={link.href}
              href={link.href}
              onClick={(event) => {
                setMenuOpen(false);
                if (link.label === "回声") {
                  event.preventDefault();
                  showEchoes();
                }
              }}
              className={`border-b border-[#1f2a1d]/10 py-4 text-2xl font-semibold text-[#1f2a1d] transition-all duration-500 ${
                menuOpen ? "translate-x-0 opacity-100" : "translate-x-8 opacity-0"
              }`}
              style={{ transitionDelay: menuOpen ? `${150 + i * 70}ms` : "0ms" }}
            >
              {link.label}
            </a>
          ))}
          <button
            onClick={returnHome}
            className="mt-8 rounded-full bg-[#1f2a1d] px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#2a3827]"
          >
            开始
          </button>
        </div>
      </div>

      {view === "home" && (
        <>
          <div className="relative z-10 flex flex-col items-center px-4 pt-24 text-center sm:px-6 sm:pt-28 md:pt-32">
            <h1
              className="max-w-5xl text-[2rem] font-normal leading-[0.95] text-[#336443] sm:text-4xl md:text-5xl lg:text-[4.75rem] xl:text-[5.25rem]"
              style={{
                fontFamily:
                  '"Neue Haas Grotesk Display Pro 55 Roman", "Neue Haas Grotesk Text Pro", "Helvetica Neue", Helvetica, Arial, sans-serif',
                letterSpacing: "0",
              }}
            >
              <span className="whitespace-nowrap">把此刻，</span>
              <span className="whitespace-nowrap text-[#85AB8B]">说给一位伟大的灵魂</span>
            </h1>
            <p className="mt-6 max-w-md px-2 text-sm leading-relaxed text-[#4b5b47] sm:mt-8 sm:text-base md:text-lg">
              开心的、难过的、想不通的，说一句，让几位灵魂先回应你。
            </p>
            <form
              onSubmit={senseSouls}
              className="mt-8 w-full max-w-2xl rounded-[2rem] border border-white/65 bg-white/72 p-2 shadow-2xl shadow-[#1f2a1d]/10 backdrop-blur-xl"
            >
              <label htmlFor="soul-input" className="sr-only">
                此刻，你想向哪位灵魂倾诉？
              </label>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="relative flex-1">
                  <textarea
                    id="soul-input"
                    value={dilemma}
                    onChange={(event) => setDilemma(event.target.value)}
                    onFocus={() => setPlaceholderActive(false)}
                    className="min-h-24 w-full resize-none rounded-[1.55rem] bg-transparent px-5 py-4 text-left text-sm leading-7 text-[#1f2a1d] outline-none sm:min-h-16"
                    placeholder=""
                  />
                  {placeholderActive && !dilemma.trim() && (
                    <div className="pointer-events-none absolute inset-0 flex items-start px-5 py-4">
                      <span
                        key={placeholderIndex}
                        className="anim-soft text-sm leading-7 text-[#6b7665]/70"
                      >
                        {PLACEHOLDER_EXAMPLES[placeholderIndex]}
                      </span>
                    </div>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={!dilemma.trim() || isSensing}
                  className="flex items-center justify-center gap-2 rounded-full bg-[#1f2a1d] px-6 py-3 text-sm font-semibold text-white transition hover:bg-[#2a3827] disabled:cursor-not-allowed disabled:bg-[#9aa493]"
                >
                  {isSensing ? "感应中" : "感应"}
                </button>
              </div>
              {isSensing && (
                <div className="flex items-center justify-center gap-2.5 px-5 pb-3 pt-1">
                  <span
                    className="h-2.5 w-2.5 rounded-full bg-[#40513b]"
                    style={{ animation: "echoBreathe 2s ease-in-out infinite" }}
                  />
                  <span className="text-xs text-[#40513b]/85">灵魂们正在隔门倾听……</span>
                </div>
              )}
              {sensingError && (
                <p className="px-5 pb-3 text-left text-xs text-[#8a5a4a]">{sensingError}</p>
              )}
            </form>
            <button
              onClick={showEchoes}
              className="mt-4 text-xs font-semibold text-[#40513b] transition-opacity hover:opacity-70"
            >
              我的回声 {echoCards.length > 0 ? `(${echoCards.length})` : ""}
            </button>
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[5] h-64 bg-gradient-to-t from-[#1f2a1d]/55 to-transparent sm:hidden" />

          <div className="absolute bottom-6 left-4 right-4 z-10 max-w-sm sm:bottom-8 sm:left-6 sm:right-auto md:bottom-10 md:left-10">
            <div className="mb-3 flex items-center gap-2 text-[#3d5638] sm:text-white/95">
              <Sparkles className="h-4 w-4" />
              <span className="text-sm font-semibold sm:font-medium">
                今晚推荐：{nightPick.soul.name}
              </span>
            </div>
            <p className="mb-6 max-w-xs text-xs font-medium leading-relaxed text-[#3d5638]/90 sm:font-normal sm:text-white/85">
              {nightPick.line}
            </p>
          </div>

          <div className="absolute bottom-8 right-16 z-10 hidden items-center gap-2 text-sm text-white/90 2xl:flex md:bottom-10 md:right-24">
            <button className="flex h-6 w-6 items-center justify-center rounded-full bg-white/20 backdrop-blur-sm transition-colors hover:bg-white/30">
              <Play className="ml-0.5 h-3 w-3 fill-white text-white" />
            </button>
            <span className="font-medium">看一次灵魂会客厅</span>
            <span className="text-white/60">1:35</span>
          </div>
        </>
      )}

      {view === "sensing" && routeResult && (
        <main className="relative z-10 mx-auto flex min-h-screen w-full max-w-5xl flex-col justify-center px-4 py-24 sm:px-6">
          <button
            onClick={resetHome}
            className="mb-8 flex w-fit items-center gap-2 text-sm font-semibold text-[#263523]/80 transition-opacity hover:opacity-70"
          >
            <ArrowLeft className="h-4 w-4" />
            改一句话
          </button>
          {routeResult.crisisFlag ? (
            <div className="rounded-[2rem] border border-white/65 bg-white/74 p-8 text-center shadow-2xl shadow-[#1f2a1d]/10 backdrop-blur-xl sm:p-12">
              <p className="mx-auto max-w-xl text-base leading-9 text-[#33402f] sm:text-lg">
                {CRISIS_TEXT}
              </p>
            </div>
          ) : (
          <div className="rounded-[2rem] border border-white/65 bg-white/74 p-5 shadow-2xl shadow-[#1f2a1d]/10 backdrop-blur-xl sm:p-8">
            <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="mb-3 text-sm font-semibold text-[#587151]">灵魂感应</p>
                <h2 className="text-3xl font-semibold leading-tight text-[#1f2a1d] sm:text-5xl">
                  {routeResult.intent === "unknown" ? "有几位灵魂愿意听你说说。" : "有几位灵魂回应了你。"}
                </h2>
                {routeResult.mode === "model" ? (
                  <p className="mt-4 max-w-xl text-sm leading-7 text-[#4d5c48] sm:text-base">
                    判断为：{labelIntent(routeResult.intent)} / {routeResult.emotionShape}
                    。你可以选择一个场域进入。
                  </p>
                ) : routeResult.intent === "unknown" ? null : (
                  <p className="mt-4 max-w-xl text-sm leading-7 text-[#4d5c48] sm:text-base">
                    你可以选择一个场域进入。
                  </p>
                )}
                {import.meta.env.DEV && (
                  <p className="mt-2 font-mono text-[0.68rem] text-[#8a927e]">
                    route: {routeResult.mode} · {routeResult.intent}
                  </p>
                )}
              </div>
              <button
                onClick={resetHome}
                className="w-fit rounded-full border border-[#1f2a1d]/15 bg-white/60 px-4 py-2 text-xs font-semibold text-[#40513b] transition hover:bg-white"
              >
                重新输入
              </button>
            </div>

            <div className="mb-5 rounded-[1.5rem] border border-[#1f2a1d]/10 bg-[#f7f5ea]/80 p-4 text-left text-sm leading-7 text-[#33402f]">
              {dilemma}
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              {routeResult.options.map((option) => (
                <button
                  key={option.soul.id}
                  onClick={() => beginSession(option.soul)}
                  disabled={isStarting}
                  className="group flex min-h-72 flex-col justify-between rounded-[1.75rem] border border-[#1f2a1d]/12 bg-white/72 p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:bg-white hover:shadow-xl hover:shadow-[#1f2a1d]/10 disabled:cursor-wait disabled:opacity-70"
                >
                  <div>
                    <p className="text-xs font-semibold text-[#6b765f]">{option.soul.domain}</p>
                    <h3 className="mt-4 text-4xl font-semibold text-[#1f2a1d]">
                      {option.soul.name}
                    </h3>
                    <p className="mt-5 text-base leading-8 text-[#2e3b2a]">{option.snippet}</p>
                  </div>
                  <div>
                    <p className="mt-6 text-xs leading-6 text-[#687463]">{option.reason}</p>
                    <span className="mt-5 inline-flex rounded-full bg-[#1f2a1d] px-4 py-2 text-xs font-semibold text-white transition group-hover:bg-[#2a3827]">
                      进入场域
                    </span>
                  </div>
                </button>
              ))}
            </div>

            {isStarting && (
              <div className="mt-5 flex items-center gap-2 text-sm font-semibold text-[#40513b]">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在入场
              </div>
            )}
          </div>
          )}
        </main>
      )}

      {view === "echoes" && (
        <main className="relative z-10 mx-auto flex min-h-[100dvh] w-full max-w-6xl flex-col px-4 py-24 sm:px-6">
          <button
            onClick={resetHome}
            className="mb-8 flex w-fit items-center gap-2 text-sm font-semibold text-[#263523]/80 transition-opacity hover:opacity-70"
          >
            <ArrowLeft className="h-4 w-4" />
            回到首页
          </button>

          <section className="rounded-[2rem] border border-white/65 bg-white/76 p-5 shadow-2xl shadow-[#1f2a1d]/10 backdrop-blur-xl sm:p-8">
            <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="mb-3 text-sm font-semibold text-[#587151]">我的回声</p>
                <h2 className="text-3xl font-semibold leading-tight text-[#1f2a1d] sm:text-5xl">
                  你保存过的相遇。
                </h2>
              </div>
              <button
                onClick={resetHome}
                className="w-fit rounded-full bg-[#1f2a1d] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[#2a3827]"
              >
                再见一位灵魂
              </button>
            </div>

            {echoCards.length === 0 ? (
              <div className="rounded-[1.75rem] border border-[#1f2a1d]/10 bg-[#f7f5ea]/80 p-8 text-[#40513b]">
                <p className="text-xl font-semibold text-[#1f2a1d]">还没有保存的回声。</p>
                <p className="mt-3 max-w-xl text-sm leading-7">
                  完成一次对话后，点击“生成回声”，它会被放在这里。这里先做本地保存，不需要账号。
                </p>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {echoCards.map((card) => (
                  <article
                    key={card.id}
                    className="flex min-h-80 flex-col justify-between rounded-[1.75rem] border border-[#1f2a1d]/12 bg-[#f7f5ea]/88 p-5 shadow-sm"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6b765f]">
                            Spiritual Echo
                          </p>
                          <h3 className="mt-3 text-3xl font-semibold text-[#1f2a1d]">
                            {card.soulName}
                          </h3>
                        </div>
                        <p className="shrink-0 text-xs text-[#6b765f]">
                          {new Date(card.createdAt).toLocaleDateString("zh-CN")}
                        </p>
                      </div>
                      <p className="mt-6 text-3xl leading-snug text-[#1f2a1d]">{card.echo}</p>
                      <p className="mt-6 text-sm leading-7 text-[#53604d]">{card.conversationSummary}</p>
                    </div>
                    <div className="mt-8 border-t border-[#1f2a1d]/10 pt-4">
                      <p className="line-clamp-2 text-xs leading-6 text-[#6b765f]">{card.userInput}</p>
                      <div className="mt-3 flex items-center justify-between gap-3">
                        <p className="text-xs font-semibold text-[#40513b]">
                          {labelIntent(card.intent)} / {card.emotionShape}
                        </p>
                        <button
                          type="button"
                          onClick={() =>
                            setExportCard({
                              soulId: card.soulId,
                              soulName: card.soulName,
                              echo: card.echo,
                              userInput: card.userInput,
                              createdAt: card.createdAt,
                              intent: card.intent,
                              emotionShape: card.emotionShape,
                            })
                          }
                          className="flex items-center gap-1.5 rounded-full border border-[#1f2a1d]/15 bg-white/70 px-3 py-1.5 text-xs font-semibold text-[#40513b] transition hover:bg-white"
                        >
                          <ImageDown className="h-3.5 w-3.5" />
                          保存为图片
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </main>
      )}

      {view === "session" && (
        <main className="relative z-10 mx-auto grid h-screen w-full max-w-6xl grid-cols-1 gap-4 overflow-hidden px-4 pb-4 pt-20 sm:px-6 sm:pb-6 lg:grid-cols-[0.85fr_1.25fr] lg:gap-5 lg:pt-24">
          <section className="hidden min-h-0 flex-col justify-end rounded-[2rem] border border-white/30 bg-[#111c17]/55 p-6 text-white shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8 lg:flex">
            <button
              onClick={() => setView(routeResult ? "sensing" : "home")}
              className="mb-auto flex w-fit items-center gap-2 text-sm font-semibold text-white/80 transition-opacity hover:opacity-70"
            >
              <ArrowLeft className="h-4 w-4" />
              修改困境
            </button>
            <p className="mt-16 text-sm font-semibold text-white/65">今晚入场</p>
            <h2 className="mt-3 text-5xl font-semibold tracking-normal sm:text-7xl">
              {selectedSoul.name}
            </h2>
            <p className="mt-4 max-w-sm text-sm leading-7 text-white/78">
              {selectedSoul.scene}
            </p>
            <div className="mt-5 rounded-3xl border border-white/16 bg-white/10 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-white/85">
                <Volume2 className="h-4 w-4 shrink-0 text-white/70" />
                <span className="truncate">{selectedSoul.ambient.sound}</span>
              </div>
              <p className="mt-3 text-xs leading-6 text-white/62">{selectedSoul.ambient.texture}</p>
            </div>
            <div className="mt-8 rounded-3xl border border-white/20 bg-white/12 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/50">
                Spiritual Echo
              </p>
              <p className="mt-3 text-2xl leading-snug text-white sm:text-3xl">{echo}</p>
            </div>
          </section>

          <section className="flex min-h-0 flex-col rounded-[2rem] border border-white/60 bg-[#fbf8ee]/88 shadow-2xl shadow-[#1f2a1d]/15 backdrop-blur-xl">
            <div className="shrink-0 border-b border-[#1f2a1d]/10 px-5 py-4 sm:px-7">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-[#587151]">灵魂会客厅</p>
                  <p className="mt-1 text-xs text-[#667160]">
                    当前：{selectedSoul.name} / {selectedSoul.domain}
                  </p>
                  <p className="mt-1 text-xs text-[#7a846f]">{selectedSoul.ambient.cue}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {audioAvailable && (
                    <button
                      type="button"
                      onClick={toggleMute}
                      className="flex h-8 w-8 items-center justify-center rounded-full border border-[#1f2a1d]/10 bg-white/60 text-[#52604c] transition hover:bg-white"
                      aria-label={muted ? "取消静音" : "静音"}
                      title={selectedSoul.ambient.sound}
                    >
                      {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                    </button>
                  )}
                  {rhythmStage !== "free" && (
                    <span className="rounded-full border border-[#1f2a1d]/10 bg-white/60 px-3 py-2 text-xs font-semibold text-[#52604c]">
                      {rhythmStageLabels[rhythmStage]}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={generateEchoCard}
                    disabled={!canGenerateEcho}
                    className="w-fit rounded-full bg-[#1f2a1d] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#2a3827] disabled:cursor-not-allowed disabled:bg-[#9aa493]"
                  >
                    {canGenerateEcho ? "生成回声" : "再聊一句后生成"}
                  </button>
                </div>
              </div>
            </div>

            <div
              className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-5 py-5 sm:px-7"
              onClick={revealNow}
            >
              {messages.map((message, index) => {
                if (message.role === "user") {
                  return (
                    <div key={`${message.role}-${index}`} className="flex justify-end">
                      <p className="max-w-[86%] whitespace-pre-line rounded-[1.5rem] bg-[#1f2a1d] px-5 py-4 text-sm leading-7 text-white sm:text-base">
                        {message.text}
                      </p>
                    </div>
                  );
                }
                const lines = message.text.split("\n").filter(Boolean);
                const isLatestSoul = index === messages.length - 1;
                const reveal = isLatestSoul && !skipReveal;
                return (
                  <div key={`${message.role}-${index}`} className="flex justify-start">
                    <div className="max-w-[86%] space-y-1 rounded-[1.5rem] bg-white px-5 py-4 text-sm leading-7 text-[#263523] shadow-sm sm:text-base">
                      {lines.map((line, li) => (
                        <p
                          key={li}
                          className={reveal ? "anim-line" : undefined}
                          style={reveal ? { animationDelay: `${lineRevealDelay(lines, li)}ms` } : undefined}
                        >
                          {line}
                        </p>
                      ))}
                    </div>
                  </div>
                );
              })}
              {echoMomentActive && (
                <div className="flex justify-start">
                  <div
                    className="anim-rise max-w-[86%]"
                    style={{ animationDelay: `${echoRevealDelayMs}ms` }}
                  >
                    <p
                      className="text-2xl leading-relaxed sm:text-3xl"
                      style={{
                        fontFamily: '"Songti SC", "Noto Serif SC", "STSong", serif',
                        color: selectedSoul.cardStyle.accent,
                      }}
                    >
                      {echo}
                    </p>
                    <button
                      type="button"
                      onClick={openEchoExport}
                      className="anim-soft mt-4 flex items-center gap-2 rounded-full bg-[#1f2a1d] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#2a3827]"
                      style={{ animationDelay: `${echoRevealDelayMs + 600}ms` }}
                    >
                      <ImageDown className="h-3.5 w-3.5" />
                      保存回声卡
                    </button>
                  </div>
                </div>
              )}
              {(isStarting || isSending) && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-2.5 rounded-full bg-white px-4 py-3 text-sm text-[#56644f] shadow-sm">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{
                        backgroundColor: selectedSoul.cardStyle.accent,
                        animation: "echoBreathe 2s ease-in-out infinite",
                      }}
                    />
                    {selectedSoul.waitingLine}
                  </div>
                </div>
              )}
              <div ref={threadEndRef} />
            </div>

            <form onSubmit={sendReply} className="shrink-0 border-t border-[#1f2a1d]/10 p-4 sm:p-5">
              <label htmlFor="reply" className="sr-only">
                继续对话
              </label>
              <div className="flex items-end gap-3 rounded-[1.75rem] border border-[#d9decd] bg-white p-2 shadow-sm">
                <textarea
                  id="reply"
                  value={reply}
                  onChange={(event) => setReply(event.target.value)}
                  onFocus={revealNow}
                  className="max-h-32 min-h-12 flex-1 resize-none bg-transparent px-3 py-3 text-sm leading-6 text-[#1f2a1d] outline-none"
                  placeholder="把你刚才的感受继续说给他听..."
                />
                <button
                  type="submit"
                  disabled={!reply.trim() || isSending}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#1f2a1d] text-white transition disabled:cursor-not-allowed disabled:bg-[#9aa493]"
                  aria-label="发送"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </form>
          </section>
        </main>
      )}

      {exportCard && (
        <EchoCardExportModal card={exportCard} onClose={() => setExportCard(null)} />
      )}

      {entering && (
        <div
          onClick={skipEntrance}
          className="fixed inset-0 z-50 flex cursor-pointer items-center justify-center overflow-hidden"
          style={{ background: "#05080a" }}
          role="button"
          aria-label="跳过入场"
        >
          <div
            className="anim-soft absolute inset-0"
            style={{ background: selectedSoul.sceneStyle.base, animationDuration: `${MOTION.entranceSceneMs}ms` }}
          />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,rgba(5,8,10,.55)_100%)]" />
          <div
            className="anim-rise relative z-10 px-6 text-center"
            style={{ animationDelay: `${MOTION.entranceSceneMs}ms`, animationDuration: "700ms" }}
          >
            <p className="text-sm font-medium tracking-[0.3em] text-white/70">
              {selectedSoul.entranceLine}
            </p>
            <h2
              className="mt-4 text-6xl font-semibold text-white sm:text-8xl"
              style={{ fontFamily: '"Songti SC", "Noto Serif SC", "STSong", serif' }}
            >
              {selectedSoul.name}
            </h2>
            <p className="mt-8 text-xs text-white/45">自动入场中 · 轻触可跳过</p>
          </div>
        </div>
      )}
    </section>
  );
}

export default App;
