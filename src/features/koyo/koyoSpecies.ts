/**
 * 紅葉マップ: 樹種グループの定義。
 *
 * 「植生GISを使用し 木ごとの紅葉時期を推定」への対応。環境省の植生図(自然環境保全基礎調査の
 * 1/25,000植生図)の凡例名を、紅葉の挙動が似ている少数の「樹種グループ」にまとめ、グループごとに
 * 紅葉の進行を決める気温のしきい値(日最低気温ベース)を持たせている。
 *
 * 【しきい値の根拠と限界(重要)】
 * - カエデ類の「日最低気温8℃以下で色づき始め、5℃以下で一気に進む」は、ウェザーニュースが
 *   イロハモミジの目安として紹介しているもの(同記事は「明確に8℃以下、5℃以下というデータが
 *   存在するわけではない」という専門家の注記も併記している)。
 * - それ以外の樹種のしきい値は、上記を基準に、山岳の例年の見頃時期(旭岳・立山室堂・上高地・
 *   京都・東京など)と気温の平年値から**概算で合わせた初期値**であり、文献で確定した値では
 *   ない。実際の見頃と合わないときは、このファイルの数値を直すか、画面の「地域別の気温補正」
 *   で調整すること。
 * - 紅葉は気温以外(日照・水分・標高以外の地形・個体差・その年の夏の猛暑など)の影響も受ける。
 *   このモデルはあくまで気温だけを手掛かりにした目安である。
 */

export type KoyoSpeciesId =
  | "maple"
  | "beech"
  | "oak"
  | "birch"
  | "larch"
  | "alpineShrub"
  | "deciduousMix";

/**
 * 植生グリッド(`public/data/koyoVegetation.bin.gz`)のクラスコード(uint8)。
 * `scripts/build-koyo-vegetation.py` の `CLASS_*` と**必ず揃えること**。
 */
export const VEG_CLASS = {
  /** 森林以外(市街地・農地・水域・草地など)・不明。紅葉マップには描かない */
  none: 0,
  /** 常緑樹林(スギ・ヒノキ・アカマツ・シラビソ・照葉樹など)。紅葉しない */
  evergreen: 1,
  maple: 2,
  beech: 3,
  oak: 4,
  birch: 5,
  larch: 6,
  alpineShrub: 7,
  deciduousMix: 8,
} as const;

export interface KoyoSpecies {
  id: KoyoSpeciesId;
  /** 植生グリッド上のクラスコード */
  classCode: number;
  name: string;
  /**
   * チェックリスト(地図の左上)・天文情報での表示名。「白樺」「モミジ」など一般的な呼び名も併記する
   * (「ブナ 白樺 カラマツなど 木ごとのチェックリスト」への対応)。
   */
  listName: string;
  /** 代表的な樹種(凡例表示用) */
  examples: string;
  /** 見頃のときの葉の色 */
  leafColor: string;
  /** 「色づき始め」になる日最低気温(℃)。これ以下で色づき始める */
  startMinC: number;
  /** 「見頃」になる日最低気温(℃) */
  peakMinC: number;
  /** 「落葉・終盤」になる日最低気温(℃) */
  endMinC: number;
  /** しきい値の根拠・前提 */
  basis: string;
}

export const KOYO_SPECIES: readonly KoyoSpecies[] = [
  {
    id: "maple",
    classCode: VEG_CLASS.maple,
    name: "カエデ類",
    listName: "カエデ類(モミジ)",
    examples: "イロハモミジ・ハウチワカエデ・ミネカエデなど",
    leafColor: "#e91d0d",
    startMinC: 8,
    peakMinC: 5,
    endMinC: 1,
    basis: "日最低気温8℃以下で色づき始め、5℃以下で一気に進む(イロハモミジの目安)。京都・東京の例年の見頃とも概ね合う",
  },
  {
    id: "beech",
    classCode: VEG_CLASS.beech,
    name: "ブナ",
    listName: "ブナ",
    examples: "ブナ・イヌブナ",
    leafColor: "#f8ad28",
    startMinC: 7,
    peakMinC: 4,
    endMinC: 1,
    basis: "カエデ類より1℃ほど低温側(上高地周辺の例年の見頃からの概算。要調整)",
  },
  {
    id: "oak",
    classCode: VEG_CLASS.oak,
    name: "ミズナラ・コナラ",
    listName: "ミズナラ・コナラ",
    examples: "ミズナラ・コナラ・クヌギ・アベマキ",
    leafColor: "#d7781b",
    startMinC: 7,
    peakMinC: 4,
    endMinC: 0,
    basis: "ブナと同程度で、褐色になって残る期間がやや長い(概算。要調整)",
  },
  {
    id: "birch",
    classCode: VEG_CLASS.birch,
    name: "ダケカンバ・シラカンバ",
    listName: "ダケカンバ・シラカンバ(白樺)",
    examples: "ダケカンバ・シラカンバ・ハンノキ類",
    leafColor: "#fbdb2f",
    startMinC: 7,
    peakMinC: 4,
    endMinC: 1,
    basis: "亜高山帯〜高原の落葉広葉樹。上高地周辺の例年の見頃からの概算(要調整)",
  },
  {
    id: "larch",
    classCode: VEG_CLASS.larch,
    name: "カラマツ",
    listName: "カラマツ",
    examples: "カラマツ(落葉針葉樹・黄金色)",
    leafColor: "#f3b917",
    startMinC: 4,
    peakMinC: 2,
    endMinC: -2,
    basis: "広葉樹より遅く、見頃は日最低気温2℃前後(上高地・軽井沢周辺の例年の見頃からの概算。要調整)",
  },
  {
    id: "alpineShrub",
    classCode: VEG_CLASS.alpineShrub,
    name: "ナナカマド・高山低木(早く紅葉)",
    listName: "ナナカマドなど早く紅葉する種類(高山・亜高山の低木)",
    examples: "ナナカマド・ミネカエデ・ミヤマハンノキ・ミヤマナラ・ウルシ類など",
    // 「ナナカマドの色をイエロー寄りに」: 色相約33°(#ce8731)→約42°(彩度・明るさはそのまま)。ブナ(約38°)とカラマツ(約44°)の間で、彩度が低いので見分けられる
    leafColor: "#ce9f31",
    startMinC: 8,
    peakMinC: 5.6,
    endMinC: 2.6,
    basis:
      "ナナカマドなど、広葉樹の中でも特に早く紅葉する種類。「三ツ石山(岩手)では9月28日にピーク、栗駒山も同様」という" +
      "実際の見頃に合わせた値。標高1,500m以下を約1週間早める補正(`koyoModel.ts`のLOWLAND_ADVANCE_DAYS)を入れたあとの平年では、" +
      "三ツ石山の山頂付近(1,466m)で見頃入り9/21〜終盤10/4(中ほどが9/28)、栗駒山の山頂付近(1,626m)で9/24〜10/8になる。" +
      "全国一律のしきい値なので、旭岳・立山室堂など北海道や中部の高山では実際より早く出る可能性がある" +
      "(その場合は画面の「地域別の気温補正」で調整。要調整)。標高2,000m以上で植生図が「森林以外」の場所の推定にも、この値を使う",
  },
  {
    id: "deciduousMix",
    classCode: VEG_CLASS.deciduousMix,
    name: "その他の落葉広葉樹",
    listName: "その他の落葉広葉樹",
    examples: "ケヤキ・シデ類・クリ・ヤマザクラ・ヤナギ類など",
    leafColor: "#fa7018",
    startMinC: 8,
    peakMinC: 5,
    endMinC: 1,
    basis: "カエデ類と同じ値を仮置き(樹種が混ざるため)",
  },
];

/** 常緑樹林(紅葉しない)の表示名。チェックリストで「樹種」の1つとして出し入れできる */
export const EVERGREEN_LIST_NAME = "常緑樹林(スギ・ヒノキ・アカマツなど。紅葉しない)";

/**
 * 地図・凡例・チェックリストで共通に使う、紅葉以外の色。
 * 「常緑樹の色をもう少し 緑をつよくしてください」「全体的にもう少し 彩度を強く」への対応で、
 * 常緑樹林は濃い緑、まだ緑の落葉樹は明るい黄緑にして、見分けがつくようにしている。
 * 常緑樹林は、のちに「彩度を低く」の要望で、同じ色合い・明るさのまま彩度を約8割→約5割に下げた(#0e7d34 → #24663a)。
 * 3Dビューの紅葉メッシュと、常緑樹林の木の色も、この色から作る。
 */
export const EVERGREEN_COLOR = "#24663a";
export const UNRIPE_COLOR = "#60b635";
export const FALLEN_COLOR = "#957a50";
/** 春: 新緑の最盛(明るい黄緑)と、葉のない冬の木(うすい茶色)の色。凡例と地図(`koyoRender.ts`)で共通 */
export const SHINRYOKU_COLOR = "#a6e03c";
export const BARE_COLOR = "#8d7a5c";
/** 雪(落葉して2週間以上〜雪解け)の色。凡例と地図で共通 */
export const SNOW_COLOR = "#fafafc";

/**
 * 「高度2000m以上の場所で 森林ではない判定の場所については 推定で 紅葉の時期を推定してください」への対応。
 * 植生図が「森林以外」とする場所でも、標高がこれ以上なら、高山帯の草紅葉・低木(ナナカマド・ミネカエデ・
 * ガンコウラン・チングルマなど)が紅葉するものとみなし、`NONFOREST_ESTIMATE_CLASS`(早く紅葉する高山の種類)の
 * しきい値で扱う。
 * その後「2000m以上の場所に森林ではないとこはないはずです」との指摘を受け、標高2,000m以上は「森林以外」として
 * 扱わない(画面でも「森林以外」と出さず、高山帯の植生として、地図でもほかの植生と同じ濃さで描く)ことにした。
 */
export const NONFOREST_ESTIMATE_MIN_ELEV_M = 2000;
export const NONFOREST_ESTIMATE_CLASS: number = VEG_CLASS.alpineShrub;

/** 植生図が「森林以外(none)」の場所の、実際に扱う樹種グループ。標高が低ければnone(描かない)のまま */
export function effectiveClassForNonForest(elevM: number): number {
  return elevM >= NONFOREST_ESTIMATE_MIN_ELEV_M ? NONFOREST_ESTIMATE_CLASS : VEG_CLASS.none;
}

export const KOYO_SPECIES_BY_ID: Readonly<Record<KoyoSpeciesId, KoyoSpecies>> = Object.fromEntries(
  KOYO_SPECIES.map((s) => [s.id, s]),
) as Record<KoyoSpeciesId, KoyoSpecies>;

const SPECIES_BY_CLASS_CODE = new Map<number, KoyoSpecies>(KOYO_SPECIES.map((s) => [s.classCode, s]));

export function speciesByClassCode(code: number): KoyoSpecies | null {
  return SPECIES_BY_CLASS_CODE.get(code) ?? null;
}

export type KoyoStage = "unripe" | "turning" | "peak" | "fallen";

export const KOYO_STAGE_LABEL: Record<KoyoStage, string> = {
  unripe: "まだ緑",
  turning: "色づき始め",
  peak: "見頃",
  fallen: "落葉・終盤",
};

export interface StageResult {
  stage: KoyoStage;
  /** turning のとき 0(色づき始め)〜1(見頃の手前)。それ以外は 0 or 1 */
  progress: number;
}

/**
 * 日最低気温(℃)から紅葉の段階を決める。
 * 気温は日を追って下がっていくので、「その地点のその日の日最低気温の推定値」が
 * しきい値のどこにあるかだけで段階が決まる(標高が高い=寒い所ほど先に進む)。
 */
export function stageForMinTemp(species: KoyoSpecies, tMinC: number): StageResult {
  if (tMinC > species.startMinC) return { stage: "unripe", progress: 0 };
  if (tMinC > species.peakMinC) {
    const span = species.startMinC - species.peakMinC;
    return { stage: "turning", progress: span > 0 ? (species.startMinC - tMinC) / span : 1 };
  }
  if (tMinC > species.endMinC) return { stage: "peak", progress: 1 };
  return { stage: "fallen", progress: 1 };
}

// ---------------------------------------------------------------------------
// 早く紅葉する種類(ナナカマドなど)の混生
// ---------------------------------------------------------------------------

/**
 * 「ナナカマドなど紅葉の早い種類もあります。早い種類のものは、早く紅葉するように変更してください」
 * 「ナナカマドのある三ツ石山では9月28日には紅葉がピークになっていました。栗駒山なども同様です」への対応。
 *
 * 植生図の凡例は優占する樹種(ブナ林・ミズナラ林・ダケカンバ林など)で区切られていて、そこに混じる
 * ナナカマド・ウルシ類・ミネカエデなどは区別できない。そのため、これらの早く紅葉する種類
 * (`alpineShrub`グループのしきい値)を、落葉広葉樹林の「混生帯」では**混ざっているもの**として扱う:
 * 林の優占種より早く色づく間は、早い種類の色(赤)を優先して描き、優占種が見頃に追いついたら
 * 優占種の色に戻す(=パッチ状に赤が先に出る様子を、先に進んだ方の色で表す)。
 *
 * 混生帯は「その場所の年平均気温が`EARLY_MIX_MAX_ANNUAL_C`以下」(山地帯上部〜亜高山帯。東北なら標高およそ
 * 800m以上、中部山岳なら1,300m以上)とした概算。低地の林には適用しない。
 * 左上のチェックリストで「ナナカマド…(早く紅葉)」を外すと、この混生も無効になる。
 */
export const EARLY_SPECIES_ID: KoyoSpeciesId = "alpineShrub";

/** 早く紅葉する種類が混じるとみなす、優占種のクラス(落葉広葉樹林)。カラマツ・常緑樹林・非森林には適用しない */
const EARLY_MIX_HOST_CLASSES: ReadonlySet<number> = new Set([
  VEG_CLASS.maple,
  VEG_CLASS.beech,
  VEG_CLASS.oak,
  VEG_CLASS.birch,
  VEG_CLASS.deciduousMix,
]);

/** 混生帯の上限とする、年平均気温(℃)。これ以下の場所で早い種類が混じるとみなす */
export const EARLY_MIX_MAX_ANNUAL_C = 8;

/** この地点(クラス・年平均気温)に、早く紅葉する種類を混生させるか */
export function earlyMixApplies(classCode: number, annualMeanC: number): boolean {
  return EARLY_MIX_HOST_CLASSES.has(classCode) && annualMeanC <= EARLY_MIX_MAX_ANNUAL_C;
}

/** 段階の進み具合を1本の数直線にしたもの(色づき始め 0 → 見頃の手前 1 → 見頃 1。連続になるようにしてある) */
function colorLevel(r: StageResult): number {
  if (r.stage === "unripe") return 0;
  if (r.stage === "turning") return r.progress;
  return 1; // peak
}

/**
 * 混生帯で、早い種類の色を**どれだけ**混ぜるか(0〜1の連続値。地図のグラデーション用)。
 * 早い種類が優占種より十分(`EARLY_LEAD_FULL`以上)進んでいれば1、並んでいれば0で、その間はなめらかに変える
 * (色が急に切り替わって見えないように)。優占種がすでに落葉・終盤のとき、早い種類がまだ緑・落葉のときは0。
 * 早い種類は「色づき始め〜見頃」の間だけ効かせ、落葉後の色は出さない。
 */
const EARLY_LEAD_FULL = 0.3;

export function earlyLeadWeight(own: StageResult, early: StageResult): number {
  if (own.stage === "fallen") return 0;
  if (early.stage === "unripe" || early.stage === "fallen") return 0;
  const lead = colorLevel(early) - colorLevel(own);
  if (lead <= 0) return 0;
  const t = Math.min(1, lead / EARLY_LEAD_FULL);
  return t * t * (3 - 2 * t); // smoothstep
}

/**
 * 植生図が無いときの代替(標高帯モデル): その場所の**年平均気温**から、日本の山地の垂直分布帯に
 * 沿って樹種グループをあてる。年平均気温は 平年値(海面換算)−逓減率×標高 で求める。
 *
 * 帯の境目は一般的な温量指数(WI)の区分(丘陵帯〜山地帯下部: WI 85〜、ブナ帯: WI 45〜85、
 * 亜高山帯: WI 15〜45、高山帯: 〜15)を、年平均気温に概算で読み替えたもの
 * (年平均10.5℃≒WI 85、6.5℃≒WI 45、3℃≒WI 15)。あくまで目安で、実際の植生
 * (針葉樹林・植林・草地・市街地など)は反映できない。そのため呼び出し側で、低標高(平野・市街地)は
 * 描画対象外にしている。
 */
export function fallbackClassByAnnualTemp(annualMeanC: number): number {
  if (annualMeanC >= 10.5) return VEG_CLASS.oak; // 丘陵〜山地帯下部: コナラ・ミズナラ・カエデ類の混交
  if (annualMeanC >= 6.5) return VEG_CLASS.beech; // ブナ帯
  if (annualMeanC >= 3) return VEG_CLASS.birch; // 亜高山帯: ダケカンバ(針葉樹との混交)
  return VEG_CLASS.alpineShrub; // 高山帯
}
