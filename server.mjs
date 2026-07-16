import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { getSoulById, soulMatchesName, souls } from "./src/shared/souls.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function pickSoul(id) {
  return getSoulById(id);
}

function hashText(text) {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

const rhythmGuides = {
  mirror: {
    label: "镜像共情",
    instruction: "先接住用户。复述其具体困境，不急着讲道理，不急着给答案，最后轻轻给出破壁动作。",
  },
  reframe: {
    label: "视角重构",
    instruction: "用角色思想改变用户的解释框架。必须提出一个开放问题，不能只安慰。",
  },
  action: {
    label: "破壁动作",
    instruction: "如果用户完成了动作，先确认动作的意义；如果没有完成，温和把他带回一个更小的动作。",
  },
  echo: {
    label: "结缘回声",
    instruction: "让对话自然收束，凝结成一句属于本次相遇的回声，不要随机摘名言。",
  },
};

function normalizeRhythmStage(value, stage, returnedFromAction) {
  if (returnedFromAction) return "action";
  if (value && rhythmGuides[value]) return value;
  return stage === "opening" ? "mirror" : "reframe";
}

// WO-004 见证意图节奏（新增分支，与 rhythmGuides 并列，不影响倾诉路径）
const witnessGuides = {
  receive: {
    label: "接过喜悦",
    instruction: "先接住这份高兴本身，具体回应用户说的那件事。不要安慰，不要转向困难，只是真切地为这件事高兴。",
  },
  magnify: {
    label: "放大意义",
    instruction:
      "把这件事放进用户更长的生命线里看——它证明了什么，这条路是怎么一步步走过来的。提一个让喜悦更深的开放问题，不要提“但是”。",
  },
  echo: {
    label: "贺辞回声",
    instruction: "凝结一句贺辞，同回声规格，含用户此事的影子。气质是举杯而非抚慰。",
  },
};

function normalizeWitnessStage(value, stage) {
  if (value && witnessGuides[value]) return value;
  return stage === "opening" ? "receive" : "magnify";
}

function localResponse({ soul, userMessage, stage, rhythmStage, returnedFromAction }) {
  const seed = hashText(`${soul.name}:${stage}:${rhythmStage}:${userMessage}`);
  const lines = soul.fallback.lines;
  const first = lines[seed % lines.length];
  const second = lines[(seed + 1) % lines.length];
  const question = soul.fallback.reframeQuestions[seed % soul.fallback.reframeQuestions.length];
  const actionLine = returnedFromAction
    ? soul.fallback.actionDoneLine
    : soul.action;

  if (rhythmStage === "mirror") {
    return {
      mode: "fallback",
      rhythmStage,
      replyLines: [
        `我听见你说：“${userMessage}”`,
        first,
        second,
        actionLine,
      ],
      echo: soul.fallback.echo,
    };
  }

  if (rhythmStage === "reframe") {
    return {
      mode: "fallback",
      rhythmStage,
      replyLines: [
        `你刚才说：“${userMessage}”`,
        first,
        question,
        actionLine,
      ],
      echo: soul.fallback.echo,
    };
  }

  if (rhythmStage === "action") {
    return {
      mode: "fallback",
      rhythmStage,
      replyLines: [
        `你刚才说：“${userMessage}”`,
        actionLine,
        second,
        "别急着把这一刻变成结论，先让它在你心里慢一点。",
      ],
      echo: soul.fallback.echo,
    };
  }

  return {
    mode: "fallback",
    rhythmStage,
    replyLines: [
      `你刚才说：“${userMessage}”`,
      first,
      second,
      soul.fallback.echoLine,
    ],
    echo: soul.echo,
  };
}

function buildPrompt({ soul, userMessage, stage, rhythmStage, returnedFromAction, history }) {
  const prior = Array.isArray(history)
    ? history
        .slice(-8)
        .map((message) => `${message.role === "user" ? "用户" : soul.name}：${message.text}`)
        .join("\n")
    : "";

  // WO-004-R1：core + stances.pourOut 装配；与重构前逐行等价（禁区为 core∪pourOut 并集）
  const core = soul.role.core;
  const st = soul.role.stances.pourOut;

  return [
    {
      role: "system",
      content: [
        `你是产品「灵魂回声」里的${soul.name}式灵魂回应者。`,
        core.identity,
        "产品目标是灵魂按摩：温柔接住用户，给他新的生命视角，而不是提供标准建议。",
        `你的思想核心：${st.belief}`,
        `你的思想指纹：${core.fingerprint}`,
        `你的话术气质：${st.tone}`,
        `你的称呼方式：${core.addressStyle}`,
        `你的思维动作：${st.thinkingMoves.join(" / ")}`,
        `你的策略池：${st.strategyPool.join(" / ")}`,
        `你的意象池：${core.imageryPool.join(" / ")}`,
        `你的禁区：${[...core.taboos, ...st.extraTaboos].join(" / ")}`,
        `你的破壁动作：${soul.action}`,
        `当前节奏：${rhythmGuides[rhythmStage].label}`,
        `节奏要求：${rhythmGuides[rhythmStage].instruction}`,
        "不要自称 AI，不要做心理诊断，不要声称提供治疗，不要编造史实。",
        "不要写成古文，不要堆名言，不要空泛鸡汤。",
        "要回应用户具体说的话，每次都要有一点新的观察。",
        "镜像共情阶段要先接住；视角重构阶段必须提出开放问题；破壁动作阶段要确认小动作；结缘回声阶段要自然收束。",
        "输出 JSON，字段为 replyLines 和 echo。",
        "replyLines 是 3 到 5 句中文数组，每句不超过 42 个字。",
        "echo 是一句可保存的精神回声，不超过 28 个字。",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `对话阶段：${stage === "opening" ? "首次回应" : "持续对话"}`,
        `当前节奏：${rhythmGuides[rhythmStage].label}`,
        returnedFromAction ? "用户刚刚完成了一个破壁动作。" : "用户还没有明确完成破壁动作。",
        prior ? `最近对话：\n${prior}` : "",
        `用户现在说：${userMessage}`,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
}

// WO-004-R1 见证提示词：core + stances.witness 装配；pourOut 的思维动作/策略池/开场白/belief 完全不出现
function buildWitnessPrompt({ soul, userMessage, stage, rhythmStage, history }) {
  const core = soul.role.core;
  const w = soul.role.stances.witness;
  const prior = Array.isArray(history)
    ? history
        .slice(-8)
        .map((message) => `${message.role === "user" ? "用户" : soul.name}：${message.text}`)
        .join("\n")
    : "";

  const systemContent = [
    `你是产品「灵魂回声」里的${soul.name}式灵魂回应者。`,
    core.identity,
    "用户带着好消息或人生节点而来，你是一个有分量的见证者。产品目标不是安慰，而是郑重地与他一同为这件事高兴。",
    `你的思想核心：${core.coreBelief}`,
    `你的思想指纹：${core.fingerprint}`,
    `你接喜事的味道：${w.tone}`,
    `你看喜事的角度：${w.belief}`,
    `你的称呼方式：${core.addressStyle}`,
    `你的思维动作：${w.thinkingMoves.join(" / ")}`,
    `你的策略池：${w.strategyPool.join(" / ")}`,
    `你的意象池：${core.imageryPool.join(" / ")}`,
    `当前节奏：${witnessGuides[rhythmStage].label}`,
    `节奏要求：${witnessGuides[rhythmStage].instruction}`,
    `硬禁令（必须逐条遵守）：${w.extraTaboos.join("；")}。`,
    "不要自称 AI，不要做心理诊断，不要编造史实，不要写成古文，不要堆名言。",
    "要回应用户具体说的那件事，每次都要有一点新的观察。",
    "下面这轮是姿态示范：学它像举杯的人，不像颁奖主持，更不像心理咨询师；学姿态，不要照抄内容。",
    "输出 JSON，字段为 replyLines 和 echo。",
    "replyLines 是 3 到 5 句中文数组，每句不超过 42 个字。",
    "echo 是一句贺辞，不超过 28 个字。",
  ].join("\n");

  return [
    { role: "system", content: systemContent },
    { role: "user", content: `用户现在说：${w.fewShot.user}` },
    { role: "assistant", content: JSON.stringify({ replyLines: w.fewShot.soul, echo: w.fallback.echo }) },
    {
      role: "user",
      content: [
        `对话阶段：${stage === "opening" ? "首次回应" : "持续对话"}`,
        `当前节奏：${witnessGuides[rhythmStage].label}`,
        prior ? `最近对话：\n${prior}` : "",
        `用户现在说：${userMessage}`,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
}

// WO-004 相见/闲聊自由对话提示词（不套节奏机）
function buildFreePrompt({ soul, userMessage, history }) {
  const prior = Array.isArray(history)
    ? history
        .slice(-8)
        .map((message) => `${message.role === "user" ? "用户" : soul.name}：${message.text}`)
        .join("\n")
    : "";

  const core = soul.role.core;
  const m = soul.role.stances.meet;

  return [
    {
      role: "system",
      content: [
        `你是产品「灵魂回声」里的${soul.name}式灵魂回应者。`,
        core.identity,
        "用户此刻没有明确议题，只想和你待一会儿、随意聊聊。按你的角色宪法自然交谈，不套任何固定节奏，不急着给道理或破壁动作。",
        `你的思想核心：${core.coreBelief}`,
        `你的话术气质：${m.tone}`,
        `你的称呼方式：${core.addressStyle}`,
        `你的意象池：${core.imageryPool.join(" / ")}`,
        `你的禁区：${core.taboos.join(" / ")}`,
        "如果用户在闲聊中自然转向倾诉或报喜，你就顺着自然转换语气，不要生硬切换，也不要重新自我介绍。",
        "不要自称 AI，不要做心理诊断，不要编造史实，不要写成古文，不要堆名言，不要空泛鸡汤。",
        "输出 JSON，字段为 replyLines 和 echo。",
        "replyLines 是 2 到 4 句中文数组，每句不超过 42 个字。",
        "echo：只有当这轮对话自然出现一句值得凝结、属于此刻相遇的话时才写，否则留空字符串。不要为凑而凑。",
      ].join("\n"),
    },
    {
      role: "user",
      content: [prior ? `最近对话：\n${prior}` : "", `用户现在说：${userMessage}`]
        .filter(Boolean)
        .join("\n"),
    },
  ];
}

// WO-004 见证 fallback（无 key）
function localWitnessResponse({ soul, userMessage, rhythmStage }) {
  const fw = soul.role.stances.witness.fallback;
  const seed = hashText(`${soul.name}:witness:${rhythmStage}:${userMessage}`);
  const first = fw.lines[seed % fw.lines.length];
  const second = fw.lines[(seed + 1) % fw.lines.length];

  if (rhythmStage === "magnify") {
    return {
      mode: "fallback",
      rhythmStage,
      replyLines: [first, "这一步不是凭空来的，是你自己一步步走出来的。", "你还想把这份好，接着走到哪里去？"],
      echo: fw.echo,
    };
  }
  if (rhythmStage === "echo") {
    return {
      mode: "fallback",
      rhythmStage,
      replyLines: [second, "这一刻值得记下。"],
      echo: fw.echo,
    };
  }
  // receive
  return {
    mode: "fallback",
    rhythmStage,
    replyLines: [`听见你说：“${userMessage}”`, first, second],
    echo: fw.echo,
  };
}

// WO-004 相见/闲聊 fallback（无 key）：自然回应，不套节奏、不强求回声
function localFreeResponse({ soul, userMessage }) {
  const seed = hashText(`${soul.name}:free:${userMessage}`);
  const first = soul.fallback.lines[seed % soul.fallback.lines.length];
  return {
    mode: "fallback",
    rhythmStage: "free",
    replyLines: [`你说：“${userMessage}”`, first],
    echo: "",
  };
}

// WO-004 新分支专用的模型调用（倾诉路径仍用 handleChat 内既有内联块，不改）
async function callChatModel(provider, messages) {
  const requestBody = {
    model: provider.model,
    messages,
    temperature: 0.82,
    response_format: { type: "json_object" },
  };
  let upstream = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  if (!upstream.ok && upstream.status === 400) {
    const { response_format, ...retryBody } = requestBody;
    upstream = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(retryBody),
    });
  }
  if (!upstream.ok) {
    const message = await upstream.text();
    throw new Error(message.slice(0, 800));
  }
  const result = await upstream.json();
  return extractJson(result.choices?.[0]?.message?.content || "");
}

function getProvider() {
  const apiKey =
    process.env.AI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    "";
  const baseUrl =
    process.env.AI_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    (process.env.DEEPSEEK_API_KEY ? "https://api.deepseek.com" : "https://api.openai.com/v1");
  const model =
    process.env.AI_MODEL ||
    process.env.OPENAI_MODEL ||
    process.env.DEEPSEEK_MODEL ||
    (process.env.DEEPSEEK_API_KEY ? "deepseek-chat" : "gpt-4o-mini");
  return { apiKey, baseUrl: baseUrl.replace(/\/$/, ""), model };
}

function extractJson(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("model did not return JSON");
    return JSON.parse(match[0]);
  }
}

const CRISIS_TRIGGERS = [
  "不想活了",
  "想死",
  "活着没意义",
  "想结束自己",
  "自杀",
  "自残",
  "我撑不下去了",
  "我准备好了结",
];
const BANNED_SNIPPET_PHRASES = ["我理解你", "别难过", "加油"];
const REASON_MAX = 30;
const INTENT_VALUES = new Set([
  "pour_out",
  "inquire",
  "meet",
  "witness",
  "gift",
  "crossroad",
  "casual",
  "crisis",
]);
const DEFAULT_TRIO = ["sushi", "yangming", "zhuangzi"];
const ROUTE_TIMEOUT_MS = 8000;
const MAX_INPUT_LENGTH = 500;
const SNIPPET_MIN = 18;
const SNIPPET_MAX = 48;

function codePointLength(text) {
  return [...text].length;
}

function includesAny(text, words) {
  return words.some((word) => text.includes(word));
}

function detectCrisis(input) {
  return includesAny(input, CRISIS_TRIGGERS);
}

function crisisResponse(mode) {
  return {
    mode,
    crisisFlag: true,
    intent: "crisis",
    intentSecondary: null,
    emotionShape: "未明",
    recommendations: [],
  };
}

// WO-004-R1 §6 降级路由正负词表
const WITNESS_WORDS = [
  "考上", "录取", "通过", "升职", "转正", "拿到", "结婚", "怀孕",
  "出生", "毕业", "痊愈", "走出来了", "成功", "太开心", "太高兴",
];
// 负面/困境信号 = 五位路由关键词并集（复用既有信号，保证 pour_out 选人逻辑不变）
const NEGATIVE_WORDS = [...new Set(souls.flatMap((soul) => soul.routing.keywords))];

function matchWitness(input) {
  return includesAny(input, WITNESS_WORDS) || /终于.*了/.test(input);
}

// 喜事人物映射（intent-spectrum §2.4）：释怀→佛陀，超越→尼采，基础庆贺序 苏轼/王阳明/庄子
function witnessSouls(input) {
  const order = [];
  if (/走出来|痊愈|想开|释怀/.test(input)) order.push("buddha");
  if (/突破|超越|征服|逆袭/.test(input)) order.push("nietzsche");
  order.push("sushi", "yangming", "zhuangzi");
  return [...new Set(order)].slice(0, 3).map((id) => getSoulById(id));
}

function witnessRoute(input) {
  return {
    mode: "fallback",
    crisisFlag: false,
    intent: "witness",
    intentSecondary: null,
    emotionShape: "苦尽甘来",
    recommendations: witnessSouls(input).map((soul) => ({
      soulId: soul.id,
      snippet: soul.role.stances.witness.fallback.lines[0],
      reason: soul.role.stances.witness.tone,
    })),
  };
}

function neutralRoute() {
  return {
    mode: "fallback",
    crisisFlag: false,
    intent: "unknown",
    intentSecondary: null,
    emotionShape: "未明",
    recommendations: DEFAULT_TRIO.map((id) => getSoulById(id)).map((soul) => ({
      soulId: soul.id,
      snippet: soul.neutralSnippet,
      reason: soul.sensing.reason,
    })),
  };
}

function fallbackRoute(input) {
  if (detectCrisis(input)) return crisisResponse("fallback");

  const text = input.toLowerCase();
  const explicitSouls = souls.filter((soul) => soulMatchesName(soul, input));

  // pour_out/meet/inquire 共用的选人逻辑（逐字保留自原 fallbackRoute）
  const buildPourOut = (intent) => {
    const ordered = [];
    const add = (soul) => {
      if (!ordered.some((item) => item.id === soul.id)) ordered.push(soul);
    };
    explicitSouls.forEach(add);
    souls.forEach((soul) => {
      if (includesAny(text, soul.routing.keywords)) add(soul);
    });
    if (ordered.length === 0) DEFAULT_TRIO.forEach((id) => add(getSoulById(id)));
    if (ordered.length === 1) {
      add(ordered[0].id === "sushi" ? getSoulById("yangming") : getSoulById("sushi"));
      add(ordered[0].id === "nietzsche" ? getSoulById("zhuangzi") : getSoulById("nietzsche"));
    }
    if (ordered.length === 2) add(getSoulById("zhuangzi"));
    return {
      mode: "fallback",
      crisisFlag: false,
      intent,
      intentSecondary: null,
      emotionShape: ordered[0]?.routing.emotionShape ?? "未明",
      recommendations: ordered.slice(0, 3).map((soul) => ({
        soulId: soul.id,
        snippet: soulMatchesName(soul, input)
          ? `${soul.name}听见你在找他。${soul.sensing.snippet}`
          : soul.sensing.snippet,
        reason: soul.sensing.reason,
      })),
    };
  };

  // 显式人名 → meet；请教句式 → inquire（原优先级不变）
  if (explicitSouls.length > 0) return buildPourOut("meet");
  if (/怎么看|请教|如何理解|聊聊/.test(input)) return buildPourOut("inquire");

  // §6 正负判断
  const hasWitness = matchWitness(input);
  const hasNegative = includesAny(text, NEGATIVE_WORDS);
  if (hasWitness && hasNegative) return neutralRoute(); // 悲喜交加不瞎猜
  if (hasWitness) return witnessRoute(input);
  if (hasNegative) return buildPourOut("pour_out");
  return neutralRoute(); // 都不命中 → 未明
}

function buildSoulProfiles() {
  return souls
    .map((soul) =>
      [
        soul.id,
        `${soul.name}（别名：${soul.aliases.join("、")}）`,
        soul.routingProfile.bestFor,
        soul.routingProfile.voiceHint,
        soul.routingProfile.notFor,
      ].join(" | "),
    )
    .join("\n");
}

function buildRoutePrompt(input) {
  return [
    {
      role: "system",
      content: [
        "你是产品「灵魂回声」的路由感应器。用户会输入一句当下想说的话，你要完成四件事，并只输出 JSON。",
        "",
        "可选的灵魂（每位的适用域与语气见下方资料）：",
        buildSoulProfiles(),
        "",
        '第一步，危机判断。若用户表达自杀、自残、想结束生命、撑不下去等直接或间接信号，输出 {"crisisFlag": true, "intent": "crisis"}，不输出其他字段。仅在真实危机信号时触发，普通的难过、失意、焦虑不算。',
        "",
        "第二步，意图分类。从以下枚举中选一个主意图，可选一个次意图：",
        "- pour_out：带着困境或负向情绪来倾诉",
        "- inquire：请教一个思想问题（怎么看/如何理解/为什么）",
        "- crossroad：面临具体人生选择（要不要/该不该/A还是B）",
        "- witness：分享好消息或人生节点",
        "- gift：替另一个人来求一句话（第三人称困境）",
        "- meet：点名想见某位灵魂，或无明确议题",
        "- casual：纯闲聊",
        "",
        "第三步，判断情绪形状：失意/内耗/执念/虚无/焦虑/好奇/苦尽甘来，或其他贴切的中文短词；判断不出用“未明”。",
        "",
        "第四步，推荐 2-3 位灵魂并为每位写感应片段。规则：",
        "- 用户点名的灵魂必须排第一位。",
        "- 即使用户点名某位灵魂，也必须再推荐一到两位适合的陪衬，总数保持 2-3 位。",
        "- 其余按人物适用域与用户输入的贴合度选。",
        `- 感应片段是该灵魂“隔着门听见了用户这句话”后的第一声回应：必须针对用户的具体内容，必须符合该人物的语气资料，${SNIPPET_MIN} 到 ${SNIPPET_MAX} 个中文字符，不引用诗词名言，不用古文腔，不说教，不用“我理解你/别难过”这类客服安慰语。`,
        "- 每位附一句不超过 20 字的推荐理由。",
        "",
        '输出 JSON：{"crisisFlag": false, "intent": "...", "intentSecondary": null 或枚举值, "emotionShape": "...", "recommendations": [{"soulId": "...", "snippet": "...", "reason": "..."}]}',
      ].join("\n"),
    },
    {
      role: "user",
      content: input,
    },
  ];
}

function isValidSnippet(snippet) {
  if (typeof snippet !== "string") return false;
  const length = codePointLength(snippet);
  if (length < SNIPPET_MIN || length > SNIPPET_MAX) return false;
  return !includesAny(snippet, BANNED_SNIPPET_PHRASES);
}

async function callRouteModel(input, provider) {
  const requestBody = {
    model: provider.model,
    messages: buildRoutePrompt(input),
    temperature: 0.4,
    response_format: { type: "json_object" },
  };

  const send = (body) =>
    fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS),
    });

  let upstream = await send(requestBody);

  if (!upstream.ok && upstream.status === 400) {
    const { response_format, ...retryBody } = requestBody;
    upstream = await send(retryBody);
  }

  if (!upstream.ok) throw new Error(`route model failed: ${upstream.status}`);

  const result = await upstream.json();
  return extractJson(result.choices?.[0]?.message?.content || "");
}

function pickReason(item) {
  const reason = typeof item.reason === "string" ? item.reason.trim() : "";
  if (reason && codePointLength(reason) <= REASON_MAX) return reason;
  return getSoulById(item.soulId).sensing.reason;
}

async function routeWithModel(input, provider) {
  const parsed = await callRouteModel(input, provider);

  if (parsed.crisisFlag === true) return crisisResponse("model");

  const intent = String(parsed.intent || "");
  if (!INTENT_VALUES.has(intent)) return null;

  const intentSecondary =
    parsed.intentSecondary && INTENT_VALUES.has(String(parsed.intentSecondary))
      ? String(parsed.intentSecondary)
      : null;

  const raw = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
  const knownIds = new Set(souls.map((soul) => soul.id));
  const recommendations = raw
    .filter((item) => item && knownIds.has(item.soulId) && isValidSnippet(item.snippet))
    .map((item) => ({
      soulId: item.soulId,
      snippet: item.snippet,
      reason: pickReason(item),
    }))
    .slice(0, 3);

  if (recommendations.length < 2) return null;

  return {
    mode: "model",
    crisisFlag: false,
    intent,
    intentSecondary,
    emotionShape: String(parsed.emotionShape || "未明"),
    recommendations,
  };
}

async function handleRoute(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "Invalid JSON." });
    return;
  }

  const input = String(payload.input || "").trim();
  if (!input) {
    sendJson(res, 400, { error: "Missing input." });
    return;
  }
  if (codePointLength(input) > MAX_INPUT_LENGTH) {
    sendJson(res, 400, { error: "Input too long." });
    return;
  }

  if (detectCrisis(input)) {
    sendJson(res, 200, crisisResponse("fallback"));
    return;
  }

  const provider = getProvider();
  if (!provider.apiKey) {
    sendJson(res, 200, fallbackRoute(input));
    return;
  }

  try {
    sendJson(res, 200, (await routeWithModel(input, provider)) ?? fallbackRoute(input));
  } catch {
    sendJson(res, 200, fallbackRoute(input));
  }
}

async function handleChat(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "Invalid JSON." });
    return;
  }

  const userMessage = String(payload.userMessage || "").trim();
  if (!userMessage) {
    sendJson(res, 400, { error: "Missing userMessage." });
    return;
  }

  // WO-004 §4 对话中危机前置拦截：命中即返回安全响应，不进入其后任何逻辑
  if (detectCrisis(userMessage)) {
    sendJson(res, 200, { mode: "safety", crisisFlag: true, rhythmStage: "mirror", replyLines: [], echo: "" });
    return;
  }

  const soul = pickSoul(String(payload.soul || "sushi"));
  const stage = payload.stage === "opening" ? "opening" : "continue";
  const returnedFromAction = Boolean(payload.returnedFromAction || payload.returnedFromTea);
  const rhythmStage = normalizeRhythmStage(payload.rhythmStage, stage, returnedFromAction);
  const intent = String(payload.intent || "");

  // WO-004 §2 见证节奏分支
  if (intent === "witness") {
    const witnessStage = normalizeWitnessStage(payload.rhythmStage, stage);
    const witnessProvider = getProvider();
    if (!witnessProvider.apiKey) {
      sendJson(res, 200, localWitnessResponse({ soul, userMessage, rhythmStage: witnessStage }));
      return;
    }
    try {
      const parsed = await callChatModel(
        witnessProvider,
        buildWitnessPrompt({ soul, userMessage, stage, rhythmStage: witnessStage, history: payload.history }),
      );
      sendJson(res, 200, {
        mode: "model",
        rhythmStage: witnessStage,
        replyLines: Array.isArray(parsed.replyLines) ? parsed.replyLines.slice(0, 5) : [],
        echo: String(parsed.echo || soul.role.stances.witness.fallback.echo),
      });
    } catch (error) {
      sendJson(res, 200, localWitnessResponse({ soul, userMessage, rhythmStage: witnessStage }));
    }
    return;
  }

  // WO-004 §3 相见/闲聊自由对话分支（不套节奏机）
  if (intent === "meet" || intent === "casual") {
    const freeProvider = getProvider();
    if (!freeProvider.apiKey) {
      sendJson(res, 200, localFreeResponse({ soul, userMessage }));
      return;
    }
    try {
      const parsed = await callChatModel(
        freeProvider,
        buildFreePrompt({ soul, userMessage, history: payload.history }),
      );
      sendJson(res, 200, {
        mode: "model",
        rhythmStage: "free",
        replyLines: Array.isArray(parsed.replyLines) ? parsed.replyLines.slice(0, 4) : [],
        echo: String(parsed.echo || ""),
      });
    } catch (error) {
      sendJson(res, 200, localFreeResponse({ soul, userMessage }));
    }
    return;
  }

  const provider = getProvider();
  if (!provider.apiKey) {
    sendJson(res, 200, localResponse({ soul, userMessage, stage, rhythmStage, returnedFromAction }));
    return;
  }

  try {
    const requestBody = {
      model: provider.model,
      messages: buildPrompt({
        soul,
        userMessage,
        stage,
        rhythmStage,
        returnedFromAction,
        history: payload.history,
      }),
      temperature: 0.82,
      response_format: { type: "json_object" },
    };
    let upstream = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!upstream.ok && upstream.status === 400) {
      const { response_format, ...retryBody } = requestBody;
      upstream = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${provider.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(retryBody),
      });
    }

    if (!upstream.ok) {
      const message = await upstream.text();
      sendJson(res, 502, { error: "Model request failed.", detail: message.slice(0, 800) });
      return;
    }

    const result = await upstream.json();
    const content = result.choices?.[0]?.message?.content || "";
    const parsed = extractJson(content);
    sendJson(res, 200, {
      mode: "model",
      rhythmStage,
      replyLines: Array.isArray(parsed.replyLines) ? parsed.replyLines.slice(0, 5) : [],
      echo: String(parsed.echo || soul.echo),
    });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : "Unknown error." });
  }
}

async function handleStatic(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const normalized = normalize(decodeURIComponent(requested)).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(root, normalized);

  try {
    const content = await readFile(filePath);
    res.writeHead(200, { "content-type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "Not found." });
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") {
    await handleChat(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/api/route") {
    await handleRoute(req, res);
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    await handleStatic(req, res);
    return;
  }
  sendJson(res, 405, { error: "Method not allowed." });
});

// 直接运行时才监听；被 import（如零漂移 diff 测试）时不启动服务
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  server.listen(port, () => {
    console.log(`Soul Echo demo running at http://localhost:${port}/`);
  });
}

// 供测试/校验用（零漂移 pourOut diff）
export { buildPrompt, buildWitnessPrompt, buildFreePrompt };
