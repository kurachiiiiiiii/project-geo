import type { ReactNode } from "react";
import { dateFromDayNumber } from "../features/koyo/koyoForecast";
import type { PointTimelineRow, TimelineEntry } from "../features/koyo/koyoModel";
import {
  KOYO_STAGE_LABEL,
  NONFOREST_ESTIMATE_MIN_ELEV_M,
  VEG_CLASS,
  speciesByClassCode,
  type KoyoStage,
} from "../features/koyo/koyoSpecies";
import type { KoyoPointInfo } from "../features/koyo/useKoyo";
import { Leaf, TreeDeciduous, TreePine } from "../lib/lucide";
import { Ico } from "./Ico";

/**
 * 天文情報パネルに出す、その地点の植生と紅葉の見頃(推定)。
 * 計算は`features/koyo/`(`useKoyo`が地点ごとに求めた`KoyoPointInfo`)で、ここは表示だけを担当する。
 */
export interface AstroKoyoInfo {
  /** 選択した地点の植生・樹種別の見頃。標高を取得中などで未確定のときはnull */
  point: KoyoPointInfo | null;
  /** 見頃を調べる期間(その年の9/1〜12/31。1970年1月1日からの日数) */
  dayRange: { start: number; end: number };
  /** 日本時間の今日(1970年1月1日からの日数) */
  today: number;
}

function mmdd(day: number): string {
  const d = dateFromDayNumber(day);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** 日付の表示。期間の最初の日にすでに達していた場合は「9/1以前」にする */
function formatEntry(e: TimelineEntry, rangeStart: number): string {
  if (e.day === null) return "—";
  if (e.alreadyReached && e.day === rangeStart) return `${mmdd(e.day)}以前`;
  return mmdd(e.day);
}

/** 今日の時点の段階(その地点の樹種の、色づき始め・見頃・落葉の日と今日を比べて決める) */
function stageOnDay(row: PointTimelineRow, day: number): KoyoStage {
  if (row.end.day !== null && day >= row.end.day) return "fallen";
  if (row.peak.day !== null && day >= row.peak.day) return "peak";
  if (row.start.day !== null && day >= row.start.day) return "turning";
  return "unripe";
}

/** 見頃の日までの距離(今日から)を言葉にする */
function peakDistanceText(row: PointTimelineRow, today: number): string | null {
  const peak = row.peak.day;
  if (peak === null) return null;
  const diff = peak - today;
  if (diff > 0) return `あと${diff}日`;
  if (diff === 0) return "今日から見頃";
  if (row.end.day !== null && today >= row.end.day) return `見頃は${-diff}日前に過ぎた見込み`;
  return `見頃に入って${-diff}日目`;
}

export default function AstroKoyoSection({ info }: { info: AstroKoyoInfo }) {
  const { point, dayRange, today } = info;

  let body: ReactNode;
  if (!point || point.loading) {
    body = <div className="astro-panel__none">植生と紅葉の見頃を計算中…(標高を取得しています)</div>;
  } else if (point.elevM === null || !point.cls) {
    body = <div className="astro-panel__none">この地点の標高を取得できなかったため、紅葉の見頃を推定できません(海上、または通信エラー)</div>;
  } else {
    const code = point.cls.classCode;
    const species = speciesByClassCode(code);
    const row = point.rows.find((r) => r.species.classCode === code) ?? null;
    const estimatedHigh = point.cls.source === "highAltitudeEstimate";
    const basis =
      point.cls.source === "vegetation"
        ? "植生図"
        : estimatedHigh
          ? `標高${NONFOREST_ESTIMATE_MIN_ELEV_M.toLocaleString("ja-JP")}m以上は高山帯`
          : "標高から推定";
    const elev = `標高${Math.round(point.elevM).toLocaleString("ja-JP")}m`;

    if (code === VEG_CLASS.none) {
      body = (
        <>
          <div className="astro-panel__koyo-veg">
            <Ico icon={TreeDeciduous} /> 植生: 森林以外(市街地・農地・水域など) <span className="astro-panel__kougen-tenki-note">({elev}・{basis})</span>
          </div>
          <div className="astro-panel__none">森林ではないため、紅葉の対象外です</div>
        </>
      );
    } else if (code === VEG_CLASS.evergreen || !species || !row) {
      body = (
        <>
          <div className="astro-panel__koyo-veg">
            <Ico icon={TreePine} /> 植生: 常緑樹林(スギ・ヒノキ・アカマツ・シラビソなど) <span className="astro-panel__kougen-tenki-note">({elev}・{basis})</span>
          </div>
          <div className="astro-panel__none">常緑樹林は紅葉しません</div>
        </>
      );
    } else {
      const stage = stageOnDay(row, today);
      const distance = peakDistanceText(row, today);
      const peakLabel =
        row.peak.day === null ? `${mmdd(dayRange.end)}までに見頃にならない見込み` : `${formatEntry(row.peak, dayRange.start)}ごろ`;
      const early = point.earlyRow;
      body = (
        <>
          <div className="astro-panel__koyo-veg">
            <Ico icon={TreeDeciduous} /> 植生:{" "}
            {estimatedHigh ? (
              <>
                高山帯の草地・低木(<b>{species.listName}</b>)
              </>
            ) : (
              <b>{species.listName}</b>
            )}{" "}
            <span className="astro-panel__kougen-tenki-note">({elev}・{basis})</span>
          </div>
          <div className="astro-panel__koyo-peak">
            <Ico icon={Leaf} /> 紅葉のピーク(見頃): <b>{peakLabel}</b>
            {distance && <span className="astro-panel__kougen-tenki-note"> ({distance})</span>}
          </div>
          {early && (
            <div className="astro-panel__koyo-peak">
              <Ico icon={Leaf} /> ナナカマドなど早く紅葉する種類のピーク:{" "}
              <b>
                {early.peak.day === null
                  ? `${mmdd(dayRange.end)}までにならない見込み`
                  : `${formatEntry(early.peak, dayRange.start)}ごろ`}
              </b>
              <span className="astro-panel__kougen-tenki-note"> (この標高の林に混じる。色づき始め {formatEntry(early.start, dayRange.start)})</span>
            </div>
          )}
          <dl className="astro-panel__koyo-list">
            <dt>色づき始め</dt>
            <dd>{formatEntry(row.start, dayRange.start)}</dd>
            <dt>見頃</dt>
            <dd>
              {formatEntry(row.peak, dayRange.start)}
              {row.peak.day !== null && row.end.day !== null && ` 〜 ${mmdd(row.end.day - 1)}`}
            </dd>
            <dt>落葉・終盤</dt>
            <dd>{formatEntry(row.end, dayRange.start)}</dd>
            <dt>今日({mmdd(today)})</dt>
            <dd>{KOYO_STAGE_LABEL[stage]}</dd>
          </dl>
          <p className="astro-panel__hint astro-panel__kougen-tenki-note">
            {estimatedHigh
              ? `標高${NONFOREST_ESTIMATE_MIN_ELEV_M.toLocaleString("ja-JP")}m以上は高山帯の植生として、高山の草紅葉・低木(${species.examples})の紅葉の時期を示しています。`
              : `${species.examples}。`}
            気温(長期予報を反映)だけを手掛かりにした目安で、実際の色づきとは数日〜1週間以上ずれることがあります。
          </p>
        </>
      );
    }
  }

  return (
    <div className="astro-panel__kougen-tenki astro-panel__koyo">
      <div className="astro-panel__kougen-tenki-title"><Ico icon={Leaf} /> 紅葉・植生(推定)</div>
      {body}
    </div>
  );
}
