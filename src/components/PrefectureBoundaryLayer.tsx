import { useEffect, useState } from "react";
import { GeoJSON, Pane } from "react-leaflet";
import type { GeoJsonObject } from "geojson";

/**
 * 「県境と海岸線を、グリッドや雲の中、気温からでも視認できるようにして」という指示への
 * 対応。雲判定メッシュ(`CloudMeshLayer.tsx`)・衛星画像・アメダス観測所マーカーなど、
 * 地図をほぼ覆ってしまう不透明度の高いレイヤーの下で、都道府県境・海岸線の位置が
 * 分からなくなってしまう問題に対応するため、これらより手前(z-indexが高い)に、
 * どんな背景の上でも見分けられるよう縁取り付きの線で描く専用レイヤー。
 *
 * 【データについて】国土地理院「地球地図日本」のシェープファイルをGeoJSON/TopoJSON化した
 * `dataofjapan/land`リポジトリ(https://github.com/dataofjapan/land)の`japan.topojson`
 * (都道府県ごとに境がある日本地図、47件)を元に、`topojson-simplify`で簡略化
 * (Visvalingam-Whyattアルゴリズム、weight=0.0001。元の頂点数71,256→14,434、
 * ファイルサイズ約4.2MB→約560KB)してから`topojson-client`でGeoJSONへ変換した
 * (`public/data/japanPrefectures.geojson`)。都道府県ごとの多角形の外周がそのまま
 * 県境・海岸線になる(海に面した県は海岸線が外周そのもの)。
 *
 * ライセンス: 出典は国土地理院「地球地図日本」。非営利目的での利用のため出典明記のみで
 * 良いとされている(`dataofjapan/land`のREADME参照)。README.mdにも出典を明記している。
 *
 * このGeoJSON(約560KB)はPWAの事前キャッシュ対象拡張子(vite.config.tsの
 * `globPatterns`)に含めていないため、初回アクセス時に強制ダウンロードされることはなく、
 * 実際にこのレイヤーが使われるとき(=このコンポーネントがマウントされたとき)に初めて
 * 取得される。
 *
 * 【常時表示にした理由】この指示は「グリッドや雲、気温の下に隠れて見えなくなっている
 * 既存の地図情報を見えるようにしてほしい」という意図であり、追加のON/OFFが必要な
 * 独立した「データレイヤー」というより、地図そのものの読みやすさの改善に近いため、
 * 他のレイヤーのように表示/非表示のチェックボックスは設けず、常時表示にしている。
 */

const BOUNDARY_PANE_NAME = "prefectureBoundaryPane";
// markerPane(600、アメダス観測所マーカー)・popupPane(700)の間。ポップアップより下にして
// おけば、クリックしたポップアップ自体はこの線に隠れない。
const BOUNDARY_PANE_Z_INDEX = 620;

const GEOJSON_URL = `${import.meta.env.BASE_URL}data/japanPrefectures.geojson`;

export default function PrefectureBoundaryLayer() {
  const [geo, setGeo] = useState<GeoJsonObject | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(GEOJSON_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`県境データの取得に失敗しました (HTTP ${res.status})`);
        return res.json() as Promise<GeoJsonObject>;
      })
      .then((data) => {
        if (!cancelled) setGeo(data);
      })
      .catch((e: unknown) => {
        // 県境の表示は補助的なものなので、失敗しても致命的にはせず黙って諦める
        console.warn("県境・海岸線データの読み込みに失敗しました:", e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!geo) return null;

  return (
    <Pane name={BOUNDARY_PANE_NAME} style={{ zIndex: BOUNDARY_PANE_Z_INDEX, pointerEvents: "none" }}>
      {/*
        白い縁取り(太め)を先に描き、その上に濃い本線(細め)を重ねる「白フチ文字」と同じ
        考え方。雲(白〜グレー)の上でも海(濃い色の衛星画像)の上でも、どちらか一方の色に
        線が沈んで見えなくなることがないようにするため。
      */}
      <GeoJSON data={geo} interactive={false} style={() => ({ color: "#ffffff", weight: 3, opacity: 0.85, fill: false })} />
      <GeoJSON
        data={geo}
        interactive={false}
        style={() => ({ color: "#16213e", weight: 1.1, opacity: 0.95, fill: false })}
        // データの出典(国土地理院「地球地図日本」、dataofjapan/land経由)を地図右下の
        // 属性表示に出す。2枚重ねているうち片方だけに付ければ十分(重複表示を避ける)。
        attribution='<a href="https://www.gsi.go.jp/kankyochiri/gm_jpn.html" target="_blank" rel="noreferrer">地球地図日本</a>'
      />
    </Pane>
  );
}
