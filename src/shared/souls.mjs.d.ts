export type SoulId = "sushi" | "yangming" | "buddha" | "nietzsche" | "zhuangzi";

export interface SoulSceneStyle {
  base: string;
  light: string;
  ground: string;
  symbol: string;
}

export interface SoulRouting {
  emotionShape: string;
  keywords: string[];
}

export interface SoulSensing {
  snippet: string;
  reason: string;
}

export interface SoulRoutingProfile {
  bestFor: string;
  notFor: string;
  voiceHint: string;
}

export interface SoulCardStyle {
  bgTop: string;
  bgBottom: string;
  ink: string;
  accent: string;
  sealCorner: "top" | "bottom";
}

export interface SoulAmbient {
  sound: string;
  texture: string;
  cue: string;
  audioSrc: string;
}

export interface SoulCore {
  identity: string;
  coreBelief: string;
  fingerprint: string;
  addressStyle: string;
  imageryPool: string[];
  taboos: string[];
}

export interface SoulStancePourOut {
  belief: string;
  tone: string;
  thinkingMoves: string[];
  strategyPool: string[];
  openingTemplate: string;
  extraTaboos: string[];
}

export interface SoulStanceWitness {
  belief: string;
  tone: string;
  thinkingMoves: string[];
  strategyPool: string[];
  openingTemplate: string;
  extraTaboos: string[];
  fewShot: { user: string; soul: string[] };
  fallback: { lines: string[]; echo: string };
}

export interface SoulStanceMeet {
  tone: string;
  openingTemplate: string;
}

export interface SoulRoleConstitution {
  core: SoulCore;
  stances: {
    pourOut: SoulStancePourOut;
    witness: SoulStanceWitness;
    meet: SoulStanceMeet;
  };
}

export interface SoulFallback {
  lines: string[];
  reframeQuestions: string[];
  actionDoneLine: string;
  echoLine: string;
  replyTemplate: string;
  echo: string;
}

export interface SoulConfig {
  id: SoulId;
  name: string;
  aliases: string[];
  domain: string;
  scene: string;
  ambient: SoulAmbient;
  color: string;
  sceneStyle: SoulSceneStyle;
  routing: SoulRouting;
  sensing: SoulSensing;
  routingProfile: SoulRoutingProfile;
  cardStyle: SoulCardStyle;
  waitingLine: string;
  entranceLine: string;
  nightLines: string[];
  neutralSnippet: string;
  role: SoulRoleConstitution;
  action: string;
  echo: string;
  fallback: SoulFallback;
}

export const souls: SoulConfig[];
export const defaultSoulId: SoulId;
export function getSoulById(id: string): SoulConfig;
export function soulMatchesName(soul: SoulConfig, input: string): boolean;
export function fillTemplate(template: string, input: string): string;
export const WITNESS_TABOOS: string[];
export function buildOpeningText(soul: SoulConfig, input: string): string;
export function buildFallbackReply(
  soul: SoulConfig,
  input: string,
): {
  reply: string;
  echo: string;
};
