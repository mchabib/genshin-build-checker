import { z } from "zod";
import { chatJson, describeLlmOptions, type ChatUsage, type LlmOptions } from "./llm.client";
import { allEntriesFor, catalogById, type CatalogCtx } from "../data/buffCatalog";
import { getArtifact, getWeaponText, getTalentData, type StoredTalentData } from "./gameDataStore";
import { getGuide } from "./guideStore";
import type { ShowcaseCharacter } from "./enka.mapper";
import type { DamageCharacter } from "./damage.service";
import type { DamageTable, EnemyConfig, HitDef, HitKind, Modifier, ReactionKey } from "./damage.types";
import type { Element } from "../lib/stats";

/**
 * Lapisan LLM buat kalkulator damage. LLM TIDAK menghitung angka — dia cuma:
 *   1. milih tim (kalau user nggak kasih),
 *   2. nentuin buff/debuff KONDISIONAL mana yang aktif (pakai id katalog kalau ada),
 *   3. nentuin reaksi per jenis hit dan combo rotasi (pakai hit id dari tabel).
 * Output JSON divalidasi zod + di-cap, lalu kode yang menghitung ulang.
 */

const KINDS = ["na", "ca", "plunge", "skill", "burst"] as const;
const SCOPES = ["all", ...KINDS] as const;
const ELEMENTS = ["pyro", "hydro", "electro", "cryo", "dendro", "anemo", "geo", "physical"] as const;
const REACTIONS = [
  "vaporize", "melt", "aggravate", "spread", "overloaded", "burning", "electroCharged",
  "superconduct", "swirl", "shattered", "bloom", "hyperbloom", "burgeon",
] as const;

const ElementEnum = z.enum(ELEMENTS);
const ReactionEnum = z.enum(REACTIONS);
const ScopeEnum = z.enum(SCOPES);
const elemRecord = (max: number) => z.record(ElementEnum, z.number().min(-50).max(max)).optional();

export const ModifierSchema = z.object({
  catalogId: z.string().optional(),
  source: z.string().min(1),
  scope: z.union([ScopeEnum, z.array(ScopeEnum).min(1)]).default("all"),
  hitIds: z.array(z.string()).optional(),
  atkPct: z.number().min(0).max(100).optional(),
  atkFlat: z.number().min(0).max(2000).optional(),
  hpPct: z.number().min(0).max(100).optional(),
  hpFlat: z.number().min(0).max(10000).optional(),
  defPct: z.number().min(0).max(100).optional(),
  defFlat: z.number().min(0).max(2000).optional(),
  em: z.number().min(0).max(500).optional(),
  critRate: z.number().min(0).max(60).optional(),
  critDmg: z.number().min(0).max(120).optional(),
  dmgBonus: z.number().min(0).max(150).optional(),
  elementalDmgBonus: elemRecord(100),
  reactionBonus: z.record(ReactionEnum, z.number().min(0).max(100)).optional(),
  defShred: z.number().min(0).max(60).optional(),
  defIgnore: z.number().min(0).max(60).optional(),
  resShred: elemRecord(70),
  talentMultBonus: z.number().min(0).max(200).optional(),
  talentMultAdd: z.number().min(0).max(500).optional(),
  flatDmg: z.number().min(0).max(5000).optional(),
  infusion: ElementEnum.optional(),
  uptime: z.number().min(0).max(1).optional(),
  note: z.string().optional(),
});

export const LlmDamageOutputSchema = z.object({
  team: z.array(z.string()).default([]), // dipotong ke 3 di postValidate
  teamReason: z.string().default(""),
  modifiers: z.array(ModifierSchema).max(15).default([]),
  reactionPerTalent: z
    .object({
      na: ReactionEnum.nullable().optional(),
      ca: ReactionEnum.nullable().optional(),
      plunge: ReactionEnum.nullable().optional(),
      skill: ReactionEnum.nullable().optional(),
      burst: ReactionEnum.nullable().optional(),
    })
    .default({}),
  naInfusion: ElementEnum.nullable().optional(),
  rotation: z
    .object({ label: z.string().default("rotasi"), counts: z.record(z.string(), z.number().min(0).max(200)) })
    .nullable()
    .default(null),
  notes: z.array(z.string()).max(12).default([]),
  verdict: z.string().default(""),
});
export type LlmDamageOutput = z.infer<typeof LlmDamageOutputSchema>;

// ---------- prompt ----------
export interface DamagePromptCtx {
  showcase: ShowcaseCharacter;
  char: DamageCharacter;
  talentData: StoredTalentData;
  hits: HitDef[];
  baseline: DamageTable;
  /** modifier yang sudah otomatis aktif (self) — biar LLM nggak dobel */
  autoModifiers: Modifier[];
  team: { key: string; name: string }[];
  roster: { key: string; name: string; element: string | null }[];
  enemy: EnemyConfig;
  reactionsFromUser: Partial<Record<HitKind, ReactionKey | null>>;
  catalogCtx: CatalogCtx;
}

const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+\n/g, "\n").trim();
const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? s.slice(0, n) + "…" : s) : "");

export function buildDamagePrompt(ctx: DamagePromptCtx): { system: string; user: string } {
  const { showcase: sc, char, talentData: td, hits, baseline } = ctx;

  const system = [
    "Kamu analis damage Genshin Impact yang teliti. Tugasmu: memutuskan buff/debuff KONDISIONAL apa yang aktif untuk satu karakter dalam satu tim, reaksi per jenis hit, dan combo rotasi. KAMU TIDAK MENGHITUNG DAMAGE — kode yang menghitung. Kamu hanya mengembalikan JSON terstruktur.",
    "Aturan keras:",
    "- Stat yang SUDAH termasuk di total Enka (jangan dimasukkan lagi): base stat, secondary stat senjata, main/substat artifact, bonus 2pc set, passive statis (contoh: Raiden A4 electro DMG dari ER, Homa HP%/ATK dari HP, Lost Prayer stack dianggap sudah). Hanya efek yang aktif SAAT bertarung/kondisional yang boleh: 4pc set yang butuh trigger, passive A1/A4 kondisional, buff teammate, resistance shred, DEF shred/ignore, Q/E self-buff, senjata bagian kondisional (mis. Homa <50% HP, Foliar Incision stack).",
    "- Kalau ada di KATALOG, WAJIB pakai `catalogId` (angka diambil dari katalog; field angka lain diabaikan KECUALI `uptime` 0-1 yang boleh kamu set untuk menskala buff). Modifier custom hanya untuk yang tidak ada di katalog, dan HARUS ada `source` + `note` singkat (alasan/asumsi). Field custom yang tersedia: atkPct, atkFlat, hpPct, hpFlat, defPct, defFlat, em, critRate, critDmg, dmgBonus (semua elemen), elementalDmgBonus {elemen: %}, reactionBonus {reaksi: %}, defShred, defIgnore, resShred {elemen: %}, talentMultBonus (%×), talentMultAdd (+poin %), flatDmg, infusion, uptime, scope (all|na|ca|plunge|skill|burst atau array), hitIds.",
    "- Jangan tebak angka berlebihan: pakai nilai di teks talent/senjata/set yang diberikan. Kalau ragu, pakai uptime < 1 dan jelaskan di note.",
    "- Jangan dobel: modifier yang sudah ada di daftar 'SUDAH AKTIF OTOMATIS' jangan diulang.",
    "- reactionPerTalent hanya reaksi yang MASUK AKAL untuk elemen hit itu dan tim itu (mis. Hu Tao + Xingqiu → ca: vaporize). null = tanpa reaksi. Transformative (overloaded/swirl/hyperbloom/...) boleh dipakai sebagai proc di rotasi lewat key 'react:<reaksi>'.",
    "- rotation.counts HARUS pakai hit id persis dari TABEL BASELINE (contoh na1, ca1, skill1, burst1) atau 'react:overloaded'. Ambil combo dari guide KQM kalau ada.",
    "- team: maksimal 3 nama teammate. Kalau user sudah memberi tim, kembalikan tim itu apa adanya.",
    "- Bahasa: Indonesia santai buat notes/verdict. Verdict 1-3 kalimat: apa build ini kuat/lemah untuk tim itu.",
    "Format JSON persis (semua field opsional kecuali yang disebut):",
    JSON.stringify(
      {
        team: ["Xingqiu", "Yelan", "Zhongli"],
        teamReason: "…",
        modifiers: [
          { catalogId: "hutao_a4", source: "Hu Tao A4", note: "asumsi HP < 50%" },
          { catalogId: "furina_q", source: "Furina Q", uptime: 0.8, note: "Fanfare butuh waktu naik → rata-rata 80% dari max" },
          { source: "Staff of Homa <50% HP", scope: "all", atkFlat: 369, note: "1% HP ekstra saat HP<50%: 36920×0.01" },
          { source: "Primordial Jade Winged-Spear 7 stack", scope: "all", atkPct: 22.4, dmgBonus: 12, uptime: 0.9, note: "3.2%×7 ATK + 12% DMG saat stack penuh" },
          { source: "Xingqiu C2", scope: "all", resShred: { hydro: 15 }, note: "..." },
        ],
        reactionPerTalent: { na: null, ca: "vaporize", plunge: null, skill: "vaporize", burst: "vaporize" },
        naInfusion: null,
        rotation: { label: "9N2C + Q", counts: { na1: 9, ca1: 9, burst1: 1 } },
        notes: ["…"],
        verdict: "…",
      },
      null,
      1,
    ),
  ].join("\n");

  const L: string[] = [];
  const w = sc.weapon;
  L.push(`=== KARAKTER ===`);
  L.push(`${sc.name} (${td.key}) · ${char.element} · ${sc.weaponType} · Lv ${char.level} · C${sc.constellation} · talent NA/E/Q ${char.talentLevels.normal}/${char.talentLevels.skill}/${char.talentLevels.burst}`);
  L.push(`Senjata: ${w?.name ?? "?"} R${w?.refinement ?? 1} (base ATK ${w?.baseAtk ?? "?"}, secondary ${w?.secondaryStat ?? "?"})`);
  L.push(`  Efek senjata (R${w?.refinement ?? 1}): ${clip(strip(getWeaponText(w?.name, w?.refinement) ?? "(teks tidak tersedia)"), 700)}`);
  L.push(`Set artifact: ${sc.sets.map((s) => `${s.count}pc ${s.name}`).join(" + ") || "-"}`);
  for (const s of sc.sets) {
    const a = getArtifact(s.name);
    if (!a) continue;
    if (s.count >= 4) L.push(`  4pc ${a.name}: ${clip(strip(a.fourPc ?? ""), 400)}`);
    else if (s.count >= 2) L.push(`  2pc ${a.name}: ${clip(strip(a.twoPc ?? ""), 200)} (SUDAH di total Enka)`);
  }
  L.push(`Stat total (Enka): ATK ${sc.finalStats.atk} · HP ${sc.finalStats.hp} · DEF ${sc.finalStats.def} · EM ${sc.stats.elementalMastery} · CR ${sc.stats.critRate}% · CD ${sc.stats.critDmg}% · ER ${sc.stats.energyRecharge}%`);
  const db = Object.entries(sc.dmgBonus).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}%`).join(", ");
  L.push(`DMG bonus (Enka): ${db || "-"} · base ATK ${sc.baseStats.atk}, base HP ${sc.baseStats.hp}, base DEF ${sc.baseStats.def}`);
  L.push(`Elemen NA/CA/plunge default: ${char.naElements.na}/${char.naElements.ca}/${char.naElements.plunge}`);
  L.push("");

  L.push(`=== TALENT (genshin-db) ===`);
  for (const slot of ["normal", "skill", "burst"] as const) {
    const t = td.talents[slot];
    if (t) L.push(`[${slot}] ${t.name}: ${clip(strip(t.description), 900)}`);
  }
  for (const p of td.passives) if (p.slot === "a1" || p.slot === "a4") L.push(`[${p.slot.toUpperCase()}] ${p.name}: ${clip(strip(p.description), 600)}`);
  for (const c of td.constellations) if (c.n <= sc.constellation) L.push(`[C${c.n}] ${c.name}: ${clip(strip(c.description), 400)}`);
  L.push("");

  L.push(`=== TABEL BASELINE (deterministik, self-buff otomatis; enemy Lv ${ctx.enemy.level} RES ${Math.round(ctx.enemy.res.pyro * 100)}%) ===`);
  L.push(`hit id | label | jenis | elemen | multiplier | avg`);
  for (const h of baseline.hits) L.push(`${h.id} | ${h.label}${h.hitCount > 1 ? ` ×${h.hitCount}` : ""} | ${h.kind} | ${h.element} | ${h.multiplierText} | ${Math.round(h.avg)}`);
  L.push("");

  L.push(`=== SUDAH AKTIF OTOMATIS (jangan diulang) ===`);
  L.push(ctx.autoModifiers.length ? ctx.autoModifiers.map((m) => `- ${m.id ?? m.source}: ${m.source}${m.note ? ` (${m.note})` : ""}`).join("\n") : "(tidak ada)");
  L.push("");

  L.push(`=== TIM ===`);
  if (ctx.team.length) {
    L.push(`Tim dari user (pakai ini): ${ctx.team.map((t) => t.name).join(", ")}`);
    for (const t of ctx.team) {
      const tdm = getTalentData(t.key);
      if (!tdm) continue;
      const bits = tdm.passives.filter((p) => p.slot === "a1" || p.slot === "a4").map((p) => `${p.name}: ${clip(strip(p.description), 250)}`);
      const e = tdm.talents.skill ? `E ${tdm.talents.skill.name}: ${clip(strip(tdm.talents.skill.description), 250)}` : "";
      const q = tdm.talents.burst ? `Q ${tdm.talents.burst.name}: ${clip(strip(tdm.talents.burst.description), 250)}` : "";
      L.push(`- ${t.name} (${tdm.element}): ${[e, q, ...bits].filter(Boolean).join(" | ")}`);
    }
  } else {
    L.push(`User TIDAK memberi tim. Pilih 3 teammate terbaik untuk ${sc.name}, UTAMAKAN dari roster showcase ini: ${ctx.roster.map((r) => `${r.name}${r.element ? ` (${r.element})` : ""}`).join(", ") || "(kosong)"}. Kalau roster nggak cocok, boleh pakai karakter umum (Bennett, Xingqiu, dll).`);
  }
  const g = getGuide(td.key);
  if (g) {
    const teamsTxt = [g.raw.exampleTeams, g.raw.teams, g.raw.teambuilding, g.raw.notableTeammates].filter(Boolean).join("\n");
    if (teamsTxt) L.push(`Guide KQM tentang tim:\n${clip(teamsTxt, 2500)}`);
    const combos = [g.raw.combos, g.raw.rotations, g.raw.rotation, g.raw.playstyles].filter(Boolean).join("\n");
    if (combos) L.push(`Guide KQM tentang combo/rotasi:\n${clip(combos, 2000)}`);
  }
  L.push("");

  L.push(`=== KATALOG BUFF (pakai catalogId) ===`);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const e of allEntriesFor(td.key)) {
    const relevant =
      e.kind === "team" ||
      (e.forCharacter && e.forCharacter === td.key) ||
      (e.forSet && sc.sets.some((s) => s.count >= 4 && norm(s.name) === norm(e.forSet!))) ||
      (e.forWeapon && sc.weapon?.name && norm(sc.weapon.name) === norm(e.forWeapon));
    if (!relevant) continue;
    if (ctx.autoModifiers.some((m) => m.id === e.id)) continue;
    if (e.onlyElements && !e.onlyElements.includes(char.element)) continue;
    L.push(`- ${e.id} [${e.kind}${e.fromCharacter ? `, dari ${e.fromCharacter}` : ""}${e.mode === "assume" ? ", kondisional" : ""}]: ${e.description}`);
  }
  L.push("");
  if (Object.keys(ctx.reactionsFromUser).length)
    L.push(`Reaksi dari user (override): ${JSON.stringify(ctx.reactionsFromUser)}`);
  L.push("Balas hanya JSON.");
  return { system, user: L.join("\n") };
}

// ---------- parse + post-validasi ----------
export interface LlmDamageSuggestion {
  team: string[];
  teamReason: string;
  catalogIds: string[];
  /** uptime yang diminta LLM buat entry katalog tertentu */
  catalogUptime: Record<string, number>;
  customModifiers: Modifier[];
  reactions: Partial<Record<HitKind, ReactionKey | null>>;
  naInfusion: Element | null;
  rotation: { label: string; counts: Record<string, number> } | null;
  notes: string[];
  verdict: string;
  warnings: string[];
  model: string;
  usage?: ChatUsage;
  attempts: number;
  cached: boolean;
}

export function postValidate(
  out: LlmDamageOutput,
  hitIds: Set<string>,
  autoIds: Set<string>,
  characterKey?: string,
): Omit<LlmDamageSuggestion, "model" | "usage" | "attempts" | "cached"> {
  const warnings: string[] = [];
  const catalogIds: string[] = [];
  const catalogUptime: Record<string, number> = {};
  const custom: Modifier[] = [];
  const seen = new Set<string>();

  for (const m of out.modifiers) {
    if (m.catalogId) {
      const id = m.catalogId.trim();
      if (!catalogById(id, characterKey)) {
        warnings.push(`LLM sebut catalogId "${id}" yang nggak ada — diabaikan`);
        continue;
      }
      if (m.uptime != null && m.uptime < 1) catalogUptime[id] = m.uptime;
      if (autoIds.has(id)) continue; // sudah otomatis (uptime tetap boleh diterapkan)
      if (seen.has(id)) continue;
      seen.add(id);
      catalogIds.push(id);
      continue;
    }
    const { catalogId: _c, ...rest } = m;
    const srcKey = rest.source.toLowerCase().replace(/[^a-z0-9]/g, "");
    if ([...seen].some((s) => s.replace(/[^a-z0-9]/g, "") === srcKey) || custom.some((c) => c.source === rest.source)) {
      warnings.push(`modifier "${rest.source}" dobel — diabaikan`);
      continue;
    }
    if (!rest.note) warnings.push(`modifier custom "${rest.source}" tanpa note`);
    custom.push({ ...rest, source: rest.source });
  }

  // clamp Σ resShred per elemen ≤ 90
  const shredTotal: Partial<Record<string, number>> = {};
  for (const c of custom) {
    for (const [el, v] of Object.entries(c.resShred ?? {})) {
      const cur = shredTotal[el] ?? 0;
      const allowed = Math.max(0, Math.min(v as number, 90 - cur));
      if (allowed < (v as number)) {
        warnings.push(`resShred ${el} dari "${c.source}" dipotong ${v}→${allowed} (total ≤ 90)`);
        (c.resShred as Record<string, number>)[el] = allowed;
      }
      shredTotal[el] = cur + allowed;
    }
  }

  let rotation: LlmDamageSuggestion["rotation"] = null;
  if (out.rotation) {
    const counts: Record<string, number> = {};
    for (const [id, n] of Object.entries(out.rotation.counts)) {
      if (id.startsWith("react:") || hitIds.has(id)) counts[id] = n;
      else warnings.push(`rotasi: hit id "${id}" nggak ada di tabel — dibuang`);
    }
    if (Object.keys(counts).length) rotation = { label: out.rotation.label || "rotasi", counts };
  }

  const reactions: Partial<Record<HitKind, ReactionKey | null>> = {};
  for (const k of KINDS) {
    const v = out.reactionPerTalent[k];
    if (v !== undefined) reactions[k] = v;
  }

  return {
    team: out.team.map((t) => t.trim()).filter(Boolean).slice(0, 3),
    teamReason: out.teamReason,
    catalogIds,
    catalogUptime,
    customModifiers: custom,
    reactions,
    naInfusion: out.naInfusion ?? null,
    rotation,
    notes: out.notes,
    verdict: out.verdict,
    warnings,
  };
}

// ---------- cache ----------
const cache = new Map<string, { at: number; value: LlmDamageSuggestion }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

export function suggestionCacheKey(ctx: DamagePromptCtx, uid: string, llm: LlmOptions = {}): string {
  return [
    uid,
    ctx.talentData.key,
    ctx.team.map((t) => t.key).join(","),
    ctx.enemy.level,
    JSON.stringify(ctx.reactionsFromUser),
    ctx.showcase.finalStats.atk,
    ctx.showcase.finalStats.hp,
    describeLlmOptions(llm),
  ].join("|");
}

export async function suggestDamageWithLlm(
  ctx: DamagePromptCtx,
  uid: string,
  llm: LlmOptions = {},
): Promise<LlmDamageSuggestion> {
  const key = suggestionCacheKey(ctx, uid, llm);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.value, cached: true };

  const { system, user } = buildDamagePrompt(ctx);
  // max_tokens gede karena di DeepSeek token thinking ikut kehitung di dalamnya
  const res = await chatJson({ system, user, schema: LlmDamageOutputSchema, temperature: 0.2, maxTokens: 8000, llm });
  const validated = postValidate(
    res.data,
    new Set(ctx.hits.map((h) => h.id)),
    new Set(ctx.autoModifiers.map((m) => m.id).filter((x): x is string => !!x)),
    ctx.talentData.key,
  );
  const value: LlmDamageSuggestion = { ...validated, model: describeLlmOptions({ ...llm, model: res.model }), usage: res.usage, attempts: res.attempts, cached: false };
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function clearSuggestionCache() {
  cache.clear();
}
