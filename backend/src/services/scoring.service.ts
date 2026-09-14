import type { NormalizedStats } from "../lib/stats";

export type CheckStatus = "pass" | "warn" | "fail" | "info" | "skip";

export interface CheckLine {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface ScoringResult {
  passed: boolean;
  score: number;
  grade: "S" | "A" | "B" | "C" | "D";
  buildName: string | null;
  erLabel: string | null;
  checks: CheckLine[];
  recommendations: string[];
}

// ---- bentuk data guide (dari KQM, sudah di-parse) ----
export interface GuideBuild {
  name: string | null;
  sands: string[];
  goblet: string[];
  circlet: string[];
  substatPriority: string[];
}
export interface ErRequirement {
  label: string;
  min: number;
  max: number | null;
}
export interface GuideSet {
  pieces: number;
  name: string;
  note: string | null;
}
export interface GuideInput {
  builds: GuideBuild[];
  erRequirements: ErRequirement[];
  sets: GuideSet[];
  weaponsRanked?: string[];
  rawErRequirements?: string | null;
}

// ---- input build user ----
export interface ArtifactInput {
  slot: string; // flower | plume | sands | goblet | circlet
  mainStat: string; // token kanonik
  substats: { stat: string; value: number }[];
}
export interface WeaponInput {
  name: string | null;
  refinement: number;
  secondaryStat: string | null;
}
export interface ScoreArgs {
  stats: NormalizedStats;
  guide: GuideInput;
  artifacts?: ArtifactInput[];
  activeSets?: { name: string; count: number }[];
  weapon?: WeaponInput | null;
  constellation?: number;
  talentPriority?: string | null;
  buildIndex?: number;
  erLabel?: string;
  /** role dari modul karakter (scrape-data/Buffs): shielder/healer/buffer nggak di-fail soal crit */
  role?: string | null;
  /** hasil benchmark vs build acuan (benchmark.service) — jadi 1 check; role non-DPS cuma info */
  benchmark?: { ratio: number; status: "pass" | "warn" | "fail"; verdict: string; rotation: string } | null;
}

/** role yang damage-nya bukan tujuan utama → cek crit & ER jadi info, bukan fail */
const NON_DPS_ROLES = new Set(["shielder", "healer", "buffer", "support"]);

const WEIGHT: Record<CheckStatus, number> = {
  pass: 1,
  info: 1,
  warn: 0.5,
  fail: 0,
  skip: 0,
};

function grade(s: number): ScoringResult["grade"] {
  if (s >= 90) return "S";
  if (s >= 80) return "A";
  if (s >= 70) return "B";
  if (s >= 55) return "C";
  return "D";
}

/** "CRIT" cocok dengan "CRIT Rate"/"CRIT DMG"; sisanya exact (case-insensitive). */
function statMatches(actual: string, allowed: string[]): boolean {
  const a = actual.toLowerCase();
  return allowed.some((x) => {
    const t = x.toLowerCase();
    if (t === "crit") return a === "crit rate" || a === "crit dmg" || a === "crit";
    if (a === "crit" && (t === "crit rate" || t === "crit dmg")) return true;
    return a === t;
  });
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function chooseEr(reqs: ErRequirement[], erLabel?: string): ErRequirement | null {
  if (!reqs.length || !erLabel) return null;
  return reqs.find((r) => norm(r.label).includes(norm(erLabel))) ?? null;
}

/**
 * Coba pilih arketipe ER yang paling cocok sama senjata + constellation user.
 * Return null kalau nggak yakin (biar fallback ke rentang).
 */
export function chooseErAuto(
  reqs: ErRequirement[],
  weapon: WeaponInput | null | undefined,
  con: number | undefined,
): { req: ErRequirement; why: string } | null {
  if (reqs.length < 2) return null;
  const wName = weapon?.name ? norm(weapon.name) : "";
  const wIsFav = wName.includes("favonius");
  const wIsEr = weapon?.secondaryStat === "ER" || wIsFav;

  let best: { req: ErRequirement; score: number; why: string } | null = null;
  for (const r of reqs) {
    const L = norm(r.label);
    let score = 0;
    const why: string[] = [];

    // --- constellation ---
    if (con != null) {
      if (/c6/.test(L)) {
        if (con >= 6) {
          score += 6;
          why.push("C6");
        } else score -= 8;
      }
      if (/c0c5|c0c1|c1c5/.test(L)) {
        if (con < 6) {
          score += 4;
          why.push(`C${con}`);
        } else score -= 6;
      }
      if (/(^|[^0-9])c0([^0-9]|$)/.test(L) && !/c0c/.test(L)) {
        if (con === 0) score += 3;
        else score -= 4;
      }
    }

    // --- weapon by name ---
    if (wName && wName.length > 4 && L.includes(wName)) {
      score += 10;
      why.push(weapon!.name!);
    }
    if (/withfavonius|favonius/.test(L)) {
      if (wIsFav) {
        score += 5;
        why.push("Favonius");
      } else if (/withoutfavonius|nonfavonius/.test(L)) score += 0;
      else score -= 3;
    }
    if (/withoutfavonius|nonerweapon|nonersword|otherweapon/.test(L)) {
      if (!wIsEr) {
        score += 3;
        why.push("weapon non-ER");
      }
    }
    // refinement
    const rMatch = /r([1-5])/.exec(L);
    if (rMatch && weapon) {
      if (/r([1-5])\+/.test(L)) {
        if (weapon.refinement >= Number(rMatch[1])) score += 2;
      } else if (weapon.refinement === Number(rMatch[1])) score += 3;
      else score -= 1;
    }

    if (!best || score > best.score)
      best = { req: r, score, why: why.join(" + ") };
  }

  return best && best.score >= 5
    ? { req: best.req, why: best.why || "match otomatis" }
    : null;
}

function erCheck(
  reqs: ErRequirement[],
  erVal: number,
  picked: ErRequirement | null,
): { status: CheckStatus; label: string; detail: string } {
  // arketipe spesifik dipilih user
  if (picked) {
    const lo = picked.min;
    const hi = picked.max ?? picked.min;
    if (erVal < lo - 15)
      return {
        status: "fail",
        label: `ER (${picked.label})`,
        detail: `ER ${erVal.toFixed(1)}% jauh di bawah "${picked.label}" (${lo}%+). Burst bakal telat.`,
      };
    if (erVal < lo)
      return {
        status: "warn",
        label: `ER (${picked.label})`,
        detail: `ER ${erVal.toFixed(1)}% sedikit di bawah "${picked.label}" (${lo}%). Mepet.`,
      };
    if (picked.max && erVal > hi + 25)
      return {
        status: "info",
        label: `ER (${picked.label})`,
        detail: `ER ${erVal.toFixed(1)}% di atas "${picked.label}" (maks ${hi}%). Sisa roll ER bisa dialihin ke damage.`,
      };
    return {
      status: "pass",
      label: `ER (${picked.label})`,
      detail: `ER ${erVal.toFixed(1)}% pas buat "${picked.label}" (${lo}${picked.max ? `–${hi}` : "+"}%).`,
    };
  }

  // nggak tahu tim → pakai rentang seluruh arketipe
  const mins = reqs.map((r) => r.min);
  const lo = Math.min(...mins);
  const hi = Math.max(...reqs.map((r) => r.max ?? r.min));
  if (erVal >= hi)
    return {
      status: "pass",
      label: "ER requirement",
      detail: `ER ${erVal.toFixed(1)}% cukup buat semua skenario tim di guide (${lo}–${hi}%).`,
    };
  if (erVal >= lo)
    return {
      status: "warn",
      label: "ER requirement",
      detail: `ER ${erVal.toFixed(1)}% cukup buat sebagian tim. Guide: ${lo}–${hi}% tergantung komposisi — pakai "--er <label>" buat cek spesifik.`,
    };
  return {
    status: "fail",
    label: "ER requirement",
    detail: `ER ${erVal.toFixed(1)}% di bawah semua skenario tim (min ${lo}%). Burst bakal telat.`,
  };
}

export function scoreBuild(args: ScoreArgs): ScoringResult {
  const { stats, guide } = args;
  const checks: CheckLine[] = [];
  const recs: string[] = [];

  const build =
    guide.builds[args.buildIndex ?? 0] ?? guide.builds[0] ?? null;
  const wantsCrit =
    !!build &&
    [...build.circlet, ...build.substatPriority].some((s) =>
      /crit/i.test(s),
    );

  // 0. info senjata + constellation + talent (nggak di-score)
  if (args.weapon?.name) {
    checks.push({
      key: "weapon",
      label: "Senjata",
      status: "info",
      detail: `${args.weapon.name} R${args.weapon.refinement}${
        args.weapon.secondaryStat ? ` · secondary ${args.weapon.secondaryStat}` : ""
      }${args.constellation != null ? ` · C${args.constellation}` : ""}`,
    });
  }
  if (args.talentPriority) {
    checks.push({
      key: "talentPriority",
      label: "Talent priority (KQM)",
      status: "info",
      detail: args.talentPriority.replace(/^Talent Priority\s*/i, "").split("\n")[0].trim(),
    });
  }

  // 1. ER requirement — prioritas: label eksplisit > auto (weapon/con) > rentang
  let erPicked = chooseEr(guide.erRequirements, args.erLabel);
  let erWhy: string | null = null;
  if (!erPicked) {
    const auto = chooseErAuto(guide.erRequirements, args.weapon, args.constellation);
    if (auto) {
      erPicked = auto.req;
      erWhy = auto.why;
    }
  }
  const erVal = stats.energyRecharge || 100;
  let erLabelUsed: string | null = null;
  if (guide.erRequirements.length) {
    const e = erCheck(guide.erRequirements, erVal, erPicked);
    erLabelUsed = erPicked?.label ?? null;
    const detail = erWhy
      ? `${e.detail}\n(dipilih otomatis dari: ${erWhy})`
      : e.detail;
    checks.push({ key: "er", label: e.label, status: e.status, detail });
    if (e.status === "fail" || e.status === "warn") recs.push(e.detail);
  } else {
    checks.push({
      key: "er",
      label: "ER requirement",
      status: "skip",
      detail: guide.rawErRequirements
        ? `Tabel ER nggak keparse — cek manual:\n${guide.rawErRequirements.slice(0, 400)}`
        : "Guide nggak nyebut ER requirement spesifik.",
    });
  }

  // 2. CR:CD ratio (cuma kalau karakternya emang mau crit). Ideal ~1:2, tapi
  // 1:1.6 – 1:3 masih fine; baru masalah kalau ekstrem.
  const nonDps = !!args.role && NON_DPS_ROLES.has(args.role);
  if (wantsCrit && stats.critRate > 0 && stats.critDmg > 0) {
    const ratio = stats.critDmg / stats.critRate;
    let status: CheckStatus = "pass";
    if (ratio < 1.15 || ratio > 5.0) status = "fail";
    else if (ratio < 1.6 || ratio > 3.0) status = "warn";
    let detail =
      status === "pass"
        ? `Rasio CR:CD sehat (1 : ${ratio.toFixed(2)}).`
        : ratio < 1.6
          ? `CRIT DMG agak ketinggalan (1 : ${ratio.toFixed(2)}, ideal ~1:2). Geser substat ke CD.`
          : `CRIT DMG kebanyakan relatif ke CRIT Rate (1 : ${ratio.toFixed(2)}, ideal ~1:2). Tambah CR / kurangi CD.`;
    if (nonDps && status !== "pass") {
      // role non-DPS (mis. Zhongli shielder): crit bukan prioritas → jangan dihitung sebagai kegagalan
      detail = `${detail}\n(role ${args.role}: crit bukan prioritas — nggak dihitung sebagai kekurangan)`;
      status = "info";
    }
    checks.push({ key: "critRatio", label: "CRIT Ratio", status, detail });
    if (status !== "pass" && status !== "info") recs.push(detail);
  }

  // 2b. benchmark: damage build kamu vs build acuan artifact standar (rotasi/tim sama)
  if (args.benchmark) {
    const b = args.benchmark;
    let status: CheckStatus = b.status;
    let detail = `${b.verdict} (rotasi: ${b.rotation})`;
    if (nonDps && status !== "pass") {
      detail = `${detail}\n(role ${args.role}: damage bukan tujuan utama — cuma info)`;
      status = "info";
    }
    checks.push({ key: "benchmark", label: "Benchmark vs standar KQMS", status, detail });
    if (status === "warn" || status === "fail") recs.push(detail);
  }

  // 3-5. main stat per slot
  if (args.artifacts?.length && build) {
    for (const [slot, allowed] of [
      ["sands", build.sands],
      ["goblet", build.goblet],
      ["circlet", build.circlet],
    ] as const) {
      if (!allowed.length) continue;
      const art = args.artifacts.find((a) => a.slot === slot);
      if (!art) continue;
      const ok = statMatches(art.mainStat, allowed);
      const detail = ok
        ? `${cap(slot)} ${art.mainStat} sesuai rekomendasi (${allowed.join(" / ")}).`
        : `${cap(slot)} ${art.mainStat} — KQM rekomendasiin ${allowed.join(" / ")}.`;
      checks.push({
        key: `main_${slot}`,
        label: `Main stat ${cap(slot)}`,
        status: ok ? "pass" : "warn",
        detail,
      });
      if (!ok) recs.push(detail);
    }
  }

  // 6. substat priority — flag stat yang dapet ROLL BANYAK tapi nggak relevan.
  // Roll kecil (RNG 1x) diabaikan; flat & DEF% dianggap noise kecuali build minta.
  if (args.artifacts?.length && build?.substatPriority.length) {
    const rollValue = new Map<string, number>();
    for (const a of args.artifacts)
      for (const s of a.substats)
        rollValue.set(s.stat, (rollValue.get(s.stat) ?? 0) + s.value);

    const acceptable = new Set<string>();
    for (const p of build.substatPriority) {
      if (/crit/i.test(p)) {
        acceptable.add("crit rate");
        acceptable.add("crit dmg");
      }
      acceptable.add(p.toLowerCase());
    }
    const NOISE = new Set(["flat hp", "flat atk", "flat def", "def%"]);
    // ambang "signifikan" per stat (kira-kira > 2 roll bagus)
    const THRESH: Record<string, number> = {
      "crit rate": 12,
      "crit dmg": 25,
      er: 18,
      em: 45,
      "hp%": 20,
      "atk%": 20,
      "def%": 20,
    };

    const wasted = [...rollValue.entries()]
      .filter(([stat, v]) => {
        const k = stat.toLowerCase();
        if (acceptable.has(k) || NOISE.has(k)) return false;
        return v >= (THRESH[k] ?? 999);
      })
      .map(([stat]) => stat);

    if (wasted.length) {
      const detail = `Roll substat kebuang di: ${wasted.join(", ")}. Prioritas KQM: ${build.substatPriority.join(" > ")}.`;
      checks.push({
        key: "substatPriority",
        label: "Substat priority",
        status: "warn",
        detail,
      });
      recs.push(detail);
    } else {
      checks.push({
        key: "substatPriority",
        label: "Substat priority",
        status: "pass",
        detail: `Substat nyambung sama prioritas KQM (${build.substatPriority.join(" > ")}).`,
      });
    }
  }

  // 6b. weapon tier (dari ranking KQM)
  if (args.weapon?.name && guide.weaponsRanked && guide.weaponsRanked.length >= 3) {
    const ranked = guide.weaponsRanked;
    const idx = ranked.findIndex(
      (w) => norm(w).includes(norm(args.weapon!.name!)) || norm(args.weapon!.name!).includes(norm(w)),
    );
    if (idx === 0) {
      checks.push({
        key: "weapon_tier",
        label: "Senjata (tier KQM)",
        status: "pass",
        detail: `${args.weapon.name} = pilihan #1 KQM buat karakter ini.`,
      });
    } else if (idx > 0 && idx <= 2) {
      checks.push({
        key: "weapon_tier",
        label: "Senjata (tier KQM)",
        status: "pass",
        detail: `${args.weapon.name} termasuk top ${idx + 1} pilihan KQM.`,
      });
    } else if (idx > 2) {
      checks.push({
        key: "weapon_tier",
        label: "Senjata (tier KQM)",
        status: "info",
        detail: `${args.weapon.name} ada di ranking KQM (#${idx + 1} dari ${ranked.length}). Lebih atas: ${ranked.slice(0, 3).join(", ")}.`,
      });
    } else {
      checks.push({
        key: "weapon_tier",
        label: "Senjata (tier KQM)",
        status: "info",
        detail: `${args.weapon.name} nggak ada di ranking KQM. Rekomendasi teratas: ${ranked.slice(0, 3).join(", ")}.`,
      });
    }
  }

  // 7. artifact set
  if (args.activeSets?.length && guide.sets.length) {
    const four = args.activeSets.find((s) => s.count >= 4);
    const recommended = guide.sets.map((s) => s.name);
    if (four) {
      const match = recommended.find(
        (r) => norm(r).includes(norm(four.name)) || norm(four.name).includes(norm(r)),
      );
      checks.push({
        key: "set",
        label: "Artifact set",
        status: match ? "pass" : "warn",
        detail: match
          ? `4pc ${four.name} termasuk rekomendasi KQM.`
          : `4pc ${four.name} bukan set rekomendasi. KQM: ${recommended.slice(0, 4).join(", ")}.`,
      });
      if (!match)
        recs.push(
          `Pertimbangin set rekomendasi: ${recommended.slice(0, 3).join(", ")}.`,
        );
    } else {
      checks.push({
        key: "set",
        label: "Artifact set",
        status: "info",
        detail: `Belum ada 4pc. Set rekomendasi: ${recommended.slice(0, 3).join(", ")}.`,
      });
    }
  }

  const scored = checks.filter((c) => c.status !== "skip");
  const score =
    scored.length === 0
      ? 0
      : Math.round(
          (scored.reduce((s, c) => s + WEIGHT[c.status], 0) / scored.length) * 100,
        );
  const passed = !checks.some((c) => c.status === "fail");

  if (!recs.length)
    recs.push("Build udah sesuai guide KQM. Fokus naikin kualitas substat.");

  return {
    passed,
    score,
    grade: grade(score),
    buildName: build?.name ?? null,
    erLabel: erLabelUsed,
    checks,
    recommendations: recs,
  };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
