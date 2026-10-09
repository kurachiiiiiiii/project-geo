import { useState } from "react";
import { EVERGREEN_COLOR, EVERGREEN_LIST_NAME, KOYO_SPECIES, VEG_CLASS } from "../features/koyo/koyoSpecies";
import type { KoyoController } from "../features/koyo/useKoyo";
import { useIsMobile } from "../lib/useIsMobile";
import { ChevronDown, ChevronUp, Leaf } from "../lib/lucide";
import { Ico } from "./Ico";

interface Props {
  koyo: KoyoController;
  /** 現在地ボタン(左上)が無い環境(Android版)では、その分を詰めて上端に置く */
  noLocateButton?: boolean;
}

/**
 * 「ブナ 白樺 カラマツなど 木ごとのチェックリストも 左上に追加してください」への対応。
 * 紅葉マップの表示中だけ、地図の左上に出す樹種ごとのチェックリスト。外した樹種は地図に描かない
 * (標高帯モデルで代用している画素にも効く)。常緑樹林(紅葉しない緑)も1項目として出し入れできる。
 * 状態は`useKoyo`にあり、次回起動時にも残る。スマホでは地図を覆わないよう、最初は閉じておく。
 */
export default function KoyoSpeciesChecklist({ koyo, noLocateButton = false }: Props) {
  const isMobile = useIsMobile();
  // 開閉は利用者の操作で決める。操作するまでは画面幅に応じた既定(PC=開く、スマホ=閉じる)に従う
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const open = openOverride ?? !isMobile;

  if (!koyo.visible) return null;

  const { hiddenClasses, setClassShown, setAllClassesShown } = koyo;
  const items = [
    ...KOYO_SPECIES.map((sp) => ({ code: sp.classCode, name: sp.listName, color: sp.leafColor })),
    { code: VEG_CLASS.evergreen, name: EVERGREEN_LIST_NAME, color: EVERGREEN_COLOR },
  ];
  const shownCount = items.filter((it) => !hiddenClasses.has(it.code)).length;

  return (
    <div
      className={`layer-control koyo-species${noLocateButton ? " koyo-species--top" : ""}`}
      role="group"
      aria-label="紅葉マップに表示する樹種"
    >
      <button
        type="button"
        className="koyo-species__head"
        onClick={() => setOpenOverride(!open)}
        aria-expanded={open}
      >
        <span><Ico icon={Leaf} /> 表示する樹種</span>
        <span className="koyo-species__count">
          {shownCount}/{items.length} <Ico icon={open ? ChevronUp : ChevronDown} />
        </span>
      </button>

      {open && (
        <>
          <div className="koyo-species__bulk">
            <button type="button" className="koyo-species__bulk-button" onClick={() => setAllClassesShown(true)}>
              すべて表示
            </button>
            <button type="button" className="koyo-species__bulk-button" onClick={() => setAllClassesShown(false)}>
              すべて非表示
            </button>
          </div>
          <ul className="koyo-species__list">
            {items.map((it) => {
              const shown = !hiddenClasses.has(it.code);
              return (
                <li key={it.code}>
                  <label className="koyo-species__item">
                    <input type="checkbox" checked={shown} onChange={(e) => setClassShown(it.code, e.target.checked)} />
                    <span className="koyo-species__swatch" style={{ background: it.color }} />
                    <span className="koyo-species__name">{it.name}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
