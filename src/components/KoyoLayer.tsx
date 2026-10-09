import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import * as L from "leaflet";
import { DEM_TILE_SIZE, loadDemTile } from "../features/koyo/koyoDem";
import { renderKoyoTile, type KoyoTileContext } from "../features/koyo/koyoRender";
import type { KoyoSeasonContext } from "../features/koyo/koyoSeason";
import type { KoyoVegetationGrid } from "../features/koyo/koyoVegetation";

interface Props {
  visible: boolean;
  opacity: number;
  /** 観測所ごとの海面換算の日平均気温(その日の平年値+長期予報+補正) */
  stationT0: Float32Array;
  /** 同・`LOWLAND_ADVANCE_DAYS`日先の値(標高1,500m以下の紅葉を早める補正に使う) */
  stationT0Ahead: Float32Array;
  /** 同・2週間前の値(落葉して2週間たった所を白にする) */
  stationT0Past: Float32Array;
  /** 通年モデル(新緑・雪・雪解け)の気温などの束 */
  season?: KoyoSeasonContext;
  lapseCPerM: number;
  veg: KoyoVegetationGrid | null;
  /** 表示しない植生クラスのコード(チェックリストで外された樹種) */
  hiddenClasses: ReadonlySet<number>;
}

interface TileRecord {
  canvas: HTMLCanvasElement;
  z: number;
  x: number;
  y: number;
  dem: Uint16Array | null;
}

/** 日付スライダーなどの連続操作で、描き直しを間引く間隔(ms) */
const REPAINT_THROTTLE_MS = 60;

/**
 * 紅葉マップのタイルレイヤー。国土地理院の標高タイル(DEM)をもとに、タイルごとに
 * 標高・植生・気温から紅葉の段階を色分けして描く(`koyoRender.ts`)。
 *
 * 日付や地域別補正を変えたときは、タイルを作り直さず(=一瞬消えて見えるのを避けるため)、
 * 表示中のタイルのcanvasへ描き直す。標高データは取得済みのものを使い回す。
 */
export default function KoyoLayer({
  visible,
  opacity,
  stationT0,
  stationT0Ahead,
  stationT0Past,
  season,
  lapseCPerM,
  veg,
  hiddenClasses,
}: Props) {
  const map = useMap();
  const layerRef = useRef<L.GridLayer | null>(null);
  const tilesRef = useRef<Map<HTMLElement, TileRecord>>(new Map());
  const ctxRef = useRef<KoyoTileContext>({
    stationT0,
    stationT0Ahead,
    stationT0Past,
    season,
    lapseCPerM,
    veg,
    hiddenClasses,
  });
  const repaintTimerRef = useRef<number | null>(null);

  function paint(rec: TileRecord) {
    if (!rec.dem) return;
    const c2d = rec.canvas.getContext("2d");
    if (!c2d) return;
    const img = c2d.createImageData(DEM_TILE_SIZE, DEM_TILE_SIZE);
    renderKoyoTile(rec.dem, rec.z, rec.x, rec.y, ctxRef.current, img.data);
    c2d.putImageData(img, 0, 0);
  }

  // 最新の入力(createTile/再描画から参照する)
  useEffect(() => {
    ctxRef.current = { stationT0, stationT0Ahead, stationT0Past, season, lapseCPerM, veg, hiddenClasses };
    if (repaintTimerRef.current !== null) return;
    repaintTimerRef.current = window.setTimeout(() => {
      repaintTimerRef.current = null;
      tilesRef.current.forEach(paint);
    }, REPAINT_THROTTLE_MS);
  }, [stationT0, stationT0Ahead, stationT0Past, season, lapseCPerM, veg, hiddenClasses]);

  useEffect(
    () => () => {
      if (repaintTimerRef.current !== null) window.clearTimeout(repaintTimerRef.current);
    },
    [],
  );

  // レイヤー本体(表示ON/OFFで追加・削除)
  useEffect(() => {
    if (!visible) return;
    const tiles = tilesRef.current;
    const layer = L.gridLayer({
      tileSize: DEM_TILE_SIZE,
      // 日本全体を見る小さいズームでは標高タイルを z6 で取得して縮小表示する(z5以下は枚数が増えるだけで
      // 山頂の標高がなまって低く出るため)。標高タイルの提供は z14 まで。
      minZoom: 5,
      minNativeZoom: 6,
      maxNativeZoom: 14,
      maxZoom: 19,
      zIndex: 345,
      opacity,
      updateWhenIdle: true,
      keepBuffer: 1,
      attribution:
        // 出典の書き方は各配信元の利用規約に合わせた: 植生図は生物多様性センターの例
        // (「1/25,000植生図GISデータ(環境省生物多様性センター)を使用し、〇〇が作成・加工」)、
        // 国土数値情報は「「国土数値情報(〇〇データ)」(国土交通省)をもとに〇〇作成」、
        // 地理院タイル・気象庁は出典+加工した旨。
        '<a href="https://www.biodic.go.jp/kiso/vg/vg_kiso.html" target="_blank" rel="noreferrer">1/25,000植生図GISデータ(環境省生物多様性センター)</a>・' +
        '<a href="https://nlftp.mlit.go.jp/ksj/" target="_blank" rel="noreferrer">「国土数値情報(豪雪地帯データ)」(国土交通省)</a>・' +
        '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noreferrer">地理院タイル(標高タイル)</a>・' +
        '<a href="https://www.data.jma.go.jp/stats/etrn/" target="_blank" rel="noreferrer">気象庁ホームページ(平年値・確率予測資料)</a>をもとに、このアプリが加工して作成',
    });

    // GridLayerのcreateTileを差し替える(サブクラス化せず、既存の作法(rainTileLayer.ts)に合わせて最小限に)
    (layer as unknown as { createTile: (coords: L.Coords, done: L.DoneCallback) => HTMLElement }).createTile = (
      coords,
      done,
    ) => {
      const canvas = document.createElement("canvas");
      canvas.width = DEM_TILE_SIZE;
      canvas.height = DEM_TILE_SIZE;
      const n = 2 ** coords.z;
      const x = ((coords.x % n) + n) % n; // 日付変更線をまたぐコピーの世界のタイルを折り返す
      const rec: TileRecord = { canvas, z: coords.z, x, y: coords.y, dem: null };
      tiles.set(canvas, rec);
      if (coords.y < 0 || coords.y >= n) {
        done(undefined, canvas);
        return canvas;
      }
      loadDemTile(coords.z, x, coords.y)
        .then((dem) => {
          rec.dem = dem;
          paint(rec);
          done(undefined, canvas);
        })
        .catch((e: unknown) => done(e instanceof Error ? e : new Error(String(e)), canvas));
      return canvas;
    };

    layer.on("tileunload", (e: L.TileEvent) => {
      tiles.delete(e.tile);
    });

    layer.addTo(map);
    layerRef.current = layer;
    return () => {
      layer.remove();
      layerRef.current = null;
      tiles.clear();
    };
    // opacityは別のeffectで反映する(ここに入れるとスライダー操作のたびにタイルが作り直される)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, map]);

  useEffect(() => {
    layerRef.current?.setOpacity(opacity);
  }, [opacity]);

  return null;
}
