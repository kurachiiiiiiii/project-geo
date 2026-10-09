#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
紅葉マップ用の植生グリッドを作る変換スクリプト。

環境省 自然環境保全基礎調査(1/25,000植生図)のポリゴンデータ(Shapefile / GeoJSON / GeoPackage /
GeoParquet / zip)を読み、凡例名を紅葉の樹種グループ(src/features/koyo/koyoSpecies.ts の VEG_CLASS)に
分類して、約500mメッシュ(緯度1/240°×経度1/160°)の1バイトのグリッドへ集約し、次の2つを書き出す:

    public/data/koyoVegetation.json    メタデータ(範囲・刻み・出典・作成日時)
    public/data/koyoVegetation.bin.gz  uint8の行優先配列(rows×cols)をgzipしたもの

アプリ側(src/features/koyo/koyoVegetation.ts)はこの2つが無ければ標高帯モデルで代用して動く。

使い方(まず --inspect で凡例名の列と分類結果を確認し、そのあと変換する):

    pip install geopandas shapely rasterio pyarrow pyogrio numpy

    # 1) 中身の確認(列名・凡例名・分類結果・分類できなかった凡例名を表示。ファイルは書かない)
    python scripts/build-koyo-vegetation.py data-src/vegetation --inspect

    # 2) 変換(data-src/vegetation の中のファイルを再帰的にすべて読む)
    python scripts/build-koyo-vegetation.py data-src/vegetation

    # 凡例名の列を指定する(細かい凡例名の列を先に。複数指定すると、先の列で分類できなければ次の列を使う)
    python scripts/build-koyo-vegetation.py data-src/vegetation --name-cols HANREI_N,CHU_N
    # 文字化けする(Shapefileがcp932のとき)
    python scripts/build-koyo-vegetation.py data-src/vegetation --encoding cp932
    # 分類ルールを足す・上書きする(JSON: [["正規表現", "maple"], ...]。組み込みのルールより優先)
    python scripts/build-koyo-vegetation.py data-src/vegetation --extra-rules my_rules.json

分類の考え方(classify_name):
  1. 明らかに森林でない凡例(水田・市街地・開放水域など)は「森林以外」。
  2. 樹種名のキーワードが凡例名に含まれていれば、**最初に現れるもの**(同じ位置なら長いもの)を採用する
     (例: 「ミヤマハンノキ群落」は「ハンノキ」より先に「ミヤマハンノキ」が見つかり高山低木、
      「カラマツ植林」はカラマツ、「ブナ-ミズナラ群落」はブナ)。複数の樹種が混じる凡例は先頭の樹種に代表させる。
  3. 樹種が見つからず、草原・ササ・岩・裸地などの語があれば「森林以外」。
  4. どれにも当たらなければ未分類(「森林以外」として扱い、--inspect と変換の最後に一覧を表示する)。
     未分類が多い場合は、列の選び方か規則を見直すこと。

メッシュの細かさ: 既定は約250m(--cell-scale 2。緯度1/480°×経度1/320°)。従来の約500mにするには --cell-scale 1。
アプリは刻みを koyoVegetation.json から読むので、どちらで作っても動く。

メッシュごとの決め方(aggregate_cell): そのメッシュの被覆面積のうち、落葉樹グループの合計が35%以上なら
落葉樹グループ内で最も面積の大きい樹種、そうでなければ(常緑樹林 / 森林以外)の大きい方。
植生図がまったく無いメッシュは 255(アプリ側は標高帯モデルで代用)。
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import re
import sys
from collections import Counter
from pathlib import Path

import numpy as np

# ---------------------------------------------------------------------------
# クラスコード。src/features/koyo/koyoSpecies.ts の VEG_CLASS と必ず揃えること
# (scripts/ のテストではなく、変換後に Node 側で読み戻して確認している)。
# ---------------------------------------------------------------------------
RULES_PATH = Path(__file__).with_name("koyo-veg-rules.json")
_RULES = json.loads(RULES_PATH.read_text(encoding="utf-8"))

CLASS_NAMES = _RULES["classes"]
CLASS_NONE = CLASS_NAMES["none"]
CLASS_EVERGREEN = CLASS_NAMES["evergreen"]
CLASS_MAPLE = CLASS_NAMES["maple"]
CLASS_BEECH = CLASS_NAMES["beech"]
CLASS_OAK = CLASS_NAMES["oak"]
CLASS_BIRCH = CLASS_NAMES["birch"]
CLASS_LARCH = CLASS_NAMES["larch"]
CLASS_ALPINE_SHRUB = CLASS_NAMES["alpineShrub"]
CLASS_DECIDUOUS_MIX = CLASS_NAMES["deciduousMix"]
CLASS_UNKNOWN = 255

CLASS_LABEL = {v: k for k, v in CLASS_NAMES.items()}
DECIDUOUS_CLASSES = (
    CLASS_MAPLE,
    CLASS_BEECH,
    CLASS_OAK,
    CLASS_BIRCH,
    CLASS_LARCH,
    CLASS_ALPINE_SHRUB,
    CLASS_DECIDUOUS_MIX,
)

# グリッドの刻み(src/features/koyo/koyoVegetation.ts と同じ)。既定は約250m(--cell-scale 2)、--cell-scale 1 で従来の約500m
LAT_STEP = 1 / 480
LON_STEP = 1 / 320
SUPERSAMPLE = 3  # 1メッシュを 3×3 に細分してラスタライズし、面積比を求める(--cell-scale 1 のときは 4×4)

# 日本全体を覆う作業用グリッド(最後にデータのある範囲へ切り詰める)
JAPAN_WEST, JAPAN_EAST, JAPAN_SOUTH, JAPAN_NORTH = 122.0, 154.0, 20.0, 46.0

# ---------------------------------------------------------------------------
# 凡例名 → 樹種グループ
# ---------------------------------------------------------------------------

# 分類規則は koyo-veg-rules.json(Node版の build-koyo-vegetation.mjs と共通)
STRONG_NONE = re.compile(_RULES["strongNone"])
WEAK_NONE = re.compile(_RULES["weakNone"])
# (クラスコード, 語のリスト)。位置が最も早いもの→長いもの→この並びの順で採用する
SPECIES_KEYWORDS: list[tuple[int, list[str]]] = [(CLASS_NAMES[e["class"]], e["words"]) for e in _RULES["species"]]
# 凡例名(先頭の列)から決まらなかったときだけ使う、2列目以降(植生自然度区分など)の手掛かり
# 2列目以降にこの語があれば、凡例名に樹種名が入っていても森林以外(例: 「エゾツガザクラ群落 / 自然草原」)
AUTHORITATIVE_NONE = re.compile(_RULES["authoritativeNone"]) if _RULES.get("authoritativeNone") else None
HINTS: list[tuple[re.Pattern, int]] = [(re.compile(h["pattern"]), CLASS_NAMES[h["class"]]) for h in _RULES.get("hints", [])]


def build_rules(extra_rules: list[tuple[str, str]] | None):
    flat: list[tuple[str, int, int]] = []  # (語, クラス, 並び順)
    order = 0
    for cls, words in SPECIES_KEYWORDS:
        for w in words:
            flat.append((w, cls, order))
            order += 1
    extra = []
    for pattern, cname in extra_rules or []:
        if cname not in CLASS_NAMES:
            raise SystemExit(f"--extra-rules: 不明なクラス名 {cname!r}(使えるのは {', '.join(CLASS_NAMES)})")
        extra.append((re.compile(pattern), CLASS_NAMES[cname]))
    return flat, extra


def classify_names(names: list[str], rules) -> int | None:
    """
    凡例名の列の値(先頭が最も細かい凡例名)から樹種グループを決める。
    まず先頭の列だけで樹種キーワードを探し、決まらなければ2列目以降の手掛かり(HINTS)で決める。
    """
    first = names[0] if names else ""
    rest = " / ".join(n for n in names[1:] if n)
    for rx, cls in rules[1]:  # --extra-rules は凡例名(先頭の列)に当てる。組み込みの規則より優先
        if first and rx.search(first):
            return cls
    if rest and AUTHORITATIVE_NONE and AUTHORITATIVE_NONE.search(rest):
        return CLASS_NONE
    c = classify_name(first, rules)
    if c is not None:
        return c
    if rest:
        for rx, cls in HINTS:
            if rx.search(rest):
                return cls
    return None


def classify_name(name: str, rules) -> int | None:
    """1つの凡例名を樹種グループにする(樹種キーワード・明らかな森林以外の語)。分類できなければ None。"""
    flat, _extra = rules
    if not name:
        return None
    if STRONG_NONE.search(name):
        return CLASS_NONE
    best = None  # (位置, -長さ, 並び順, クラス)
    for word, cls, order in flat:
        pos = name.find(word)
        if pos < 0:
            continue
        key = (pos, -len(word), order, cls)
        if best is None or key < best:
            best = key
    if best is not None:
        return best[3]
    if WEAK_NONE.search(name):
        return CLASS_NONE
    return None


# ---------------------------------------------------------------------------
# 読み込み
# ---------------------------------------------------------------------------

VECTOR_SUFFIXES = {".shp", ".geojson", ".json", ".gpkg", ".fgb", ".parquet", ".geoparquet", ".zip"}
JAPANESE = re.compile(r"[ぁ-んァ-ヶ一-龠]")


def list_inputs(paths: list[str]) -> list[Path]:
    out: list[Path] = []
    for p in paths:
        pp = Path(p)
        if pp.is_dir():
            out.extend(sorted(f for f in pp.rglob("*") if f.is_file() and f.suffix.lower() in VECTOR_SUFFIXES))
        elif pp.is_file():
            out.append(pp)
        else:
            raise SystemExit(f"見つかりません: {p}")
    if not out:
        raise SystemExit("読み込めるファイル(.shp/.geojson/.gpkg/.parquet/.zip など)がありません")
    return out


def read_vector(path: Path, encoding: str | None):
    import geopandas as gpd

    if path.suffix.lower() in {".parquet", ".geoparquet"}:
        return gpd.read_parquet(path)
    target = f"zip://{path}" if path.suffix.lower() == ".zip" else str(path)
    kwargs = {"encoding": encoding} if encoding else {}
    return gpd.read_file(target, **kwargs)


def to_wgs84(gdf):
    if gdf.crs is None:
        print("  ⚠ 座標系の情報がありません。緯度経度(EPSG:4326)として扱います", file=sys.stderr)
        return gdf
    if gdf.crs.to_epsg() != 4326:
        return gdf.to_crs(4326)
    return gdf


def _is_text(series) -> bool:
    """文字列の列か(pandasのバージョンによりobject型とstring型がある)"""
    import pandas as pd

    return pd.api.types.is_object_dtype(series) or pd.api.types.is_string_dtype(series)


def text_columns(gdf) -> list[str]:
    """日本語の文字を含む文字列の列(=凡例名の候補)。ユニーク数の多い(=細かい)順。"""
    cols = []
    for c in gdf.columns:
        if c == gdf.geometry.name or not _is_text(gdf[c]):
            continue
        sample = gdf[c].dropna().astype(str)
        if sample.empty:
            continue
        if sample.head(2000).map(lambda s: bool(JAPANESE.search(s))).mean() < 0.5:
            continue
        cols.append((int(sample.nunique()), c))
    cols.sort(reverse=True)
    return [c for _, c in cols]


def mojibake_hint(gdf) -> bool:
    """文字列の列があるのに日本語が1つも見つからない=文字化けの疑い"""
    for c in gdf.columns:
        if c == gdf.geometry.name or not _is_text(gdf[c]):
            continue
        s = gdf[c].dropna().astype(str).head(500)
        if not s.empty and not s.map(lambda x: bool(JAPANESE.search(x))).any() and s.map(lambda x: bool(re.search(r"[^\x00-\x7f]", x))).any():
            return True
    return False


def label_polygons(gdf, name_cols: list[str], rules):
    """各ポリゴンのクラスコードと、分類に使った凡例名(未分類の集計用)を返す。"""
    # 列の組(行ごとの値のタプル)ごとに1回だけ分類する。先頭の列が最も細かい凡例名
    keys = gdf[name_cols].fillna("").astype(str)
    uniq = keys.drop_duplicates()
    table: dict[tuple, tuple[int | None, str]] = {}
    for row in uniq.itertuples(index=False, name=None):
        cls = classify_names([v for v in row], rules)
        used = " / ".join(v for v in row if v)
        table[row] = (cls, used)
    classes = np.empty(len(gdf), dtype=np.int16)
    used_names: list[str] = []
    for i, row in enumerate(keys.itertuples(index=False, name=None)):
        cls, used = table[row]
        classes[i] = -1 if cls is None else cls
        used_names.append(used)
    return classes, used_names


# ---------------------------------------------------------------------------
# ラスタライズと集約
# ---------------------------------------------------------------------------


def aggregate_cell(counts: np.ndarray) -> np.ndarray:
    """
    counts: (10, R, C)。counts[0]は未使用、counts[1+クラスコード]がそのクラスの細分サンプル数。
    戻り値: (R, C) の uint8。被覆なしは255。
    """
    covered = counts[1:].sum(axis=0).astype(np.int32)
    none_n = counts[1 + CLASS_NONE].astype(np.int32)
    ever_n = counts[1 + CLASS_EVERGREEN].astype(np.int32)
    dec = np.stack([counts[1 + c] for c in DECIDUOUS_CLASSES]).astype(np.int32)  # (7, R, C)
    dec_n = dec.sum(axis=0)
    best_dec = np.array(DECIDUOUS_CLASSES, dtype=np.uint8)[dec.argmax(axis=0)]
    out = np.where(
        covered == 0,
        CLASS_UNKNOWN,
        np.where(
            dec_n * 100 >= covered * 35,
            best_dec,
            np.where(ever_n > none_n, CLASS_EVERGREEN, CLASS_NONE),
        ),
    ).astype(np.uint8)
    return out


def rasterize_into(grid: np.ndarray, gdf, classes: np.ndarray, west: float, north: float, chunk_rows: int = 96):
    """gdf(WGS84)のポリゴンを、classes(クラスコード。-1は未分類=森林以外扱い)で grid に書き込む。"""
    from rasterio import features
    from rasterio.transform import from_origin

    rows, cols = grid.shape
    minx, miny, maxx, maxy = gdf.total_bounds
    col0 = max(0, int(np.floor((minx - west) / LON_STEP)))
    col1 = min(cols, int(np.ceil((maxx - west) / LON_STEP)))
    row0 = max(0, int(np.floor((north - maxy) / LAT_STEP)))
    row1 = min(rows, int(np.ceil((north - miny) / LAT_STEP)))
    if col1 <= col0 or row1 <= row0:
        print("  グリッドの範囲外のためスキップ", file=sys.stderr)
        return

    geoms = gdf.geometry.values
    sindex = gdf.sindex
    ss = SUPERSAMPLE
    painted = 0
    for r in range(row0, row1, chunk_rows):
        r_end = min(row1, r + chunk_rows)
        c_north = north - r * LAT_STEP
        c_south = north - r_end * LAT_STEP
        west_c = west + col0 * LON_STEP
        east_c = west + col1 * LON_STEP
        from shapely.geometry import box

        idx = sindex.query(box(west_c, c_south, east_c, c_north), predicate="intersects")
        if len(idx) == 0:
            continue
        shapes = []
        for i in idx:
            c = int(classes[i])
            value = 1 + (CLASS_NONE if c < 0 else c)  # 0=被覆なし、1+クラスコード
            shapes.append((geoms[i], value))
        R, C = r_end - r, col1 - col0
        transform = from_origin(west_c, c_north, LON_STEP / ss, LAT_STEP / ss)
        fine = features.rasterize(
            shapes, out_shape=(R * ss, C * ss), transform=transform, fill=0, dtype="uint8", all_touched=False
        )
        blocks = fine.reshape(R, ss, C, ss)
        counts = np.zeros((10, R, C), dtype=np.uint8)
        for v in range(1, 10):
            counts[v] = (blocks == v).sum(axis=(1, 3))
        cell = aggregate_cell(counts)
        sub = grid[r:r_end, col0:col1]
        mask = cell != CLASS_UNKNOWN
        sub[mask] = cell[mask]
        painted += int(mask.sum())
    print(f"  {painted:,} メッシュに反映")


def crop_to_data(grid: np.ndarray, west: float, north: float):
    covered = grid != CLASS_UNKNOWN
    if not covered.any():
        raise SystemExit("植生が1メッシュも得られませんでした(座標系・範囲・ファイルを確認してください)")
    rows_any = np.where(covered.any(axis=1))[0]
    cols_any = np.where(covered.any(axis=0))[0]
    r0, r1 = rows_any[0], rows_any[-1] + 1
    c0, c1 = cols_any[0], cols_any[-1] + 1
    return grid[r0:r1, c0:c1], west + c0 * LON_STEP, north - r0 * LAT_STEP


# ---------------------------------------------------------------------------
# メイン
# ---------------------------------------------------------------------------


def print_class_table(title: str, area_by_class: Counter):
    total = sum(area_by_class.values()) or 1
    print(f"\n{title}")
    for cls in sorted(area_by_class):
        label = CLASS_LABEL.get(cls, "未分類(森林以外扱い)" if cls == -1 else str(cls))
        print(f"  {label:<20} {area_by_class[cls]:>12,.0f}  {100 * area_by_class[cls] / total:5.1f}%")


def approx_area_km2(gdf) -> np.ndarray:
    """WGS84のポリゴンのおおよその面積(km²)。度²に緯度ごとの縮尺(cos緯度)をかけた概算(集計表示用)"""
    import shapely

    deg2 = shapely.area(gdf.geometry.values)
    b = gdf.geometry.bounds
    lat_mid = ((b["miny"].values + b["maxy"].values) / 2).astype(float)
    return deg2 * 111.32 * 111.2 * np.cos(np.radians(lat_mid))


def process_file(path: Path, args, rules, grid, unmatched: Counter, class_area: Counter):
    print(f"\n読み込み: {path}")
    gdf = read_vector(path, args.encoding)
    gdf = to_wgs84(gdf)
    if mojibake_hint(gdf):
        print("  ⚠ 文字化けの可能性があります。--encoding cp932 を付けて試してください", file=sys.stderr)
    gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty].copy()
    invalid = ~gdf.geometry.is_valid
    if invalid.any():
        import shapely

        gdf.loc[invalid, gdf.geometry.name] = shapely.make_valid(gdf.geometry[invalid].values)
    name_cols = [c.strip() for c in args.name_cols.split(",")] if args.name_cols else text_columns(gdf)
    missing = [c for c in name_cols if c not in gdf.columns]
    if missing:
        raise SystemExit(f"列が見つかりません: {missing}(列名: {list(gdf.columns)})")
    if not name_cols:
        raise SystemExit(f"凡例名の列が見つかりません。--name-cols で指定してください(列名: {list(gdf.columns)})")
    print(f"  凡例名の列(優先順): {name_cols} / ポリゴン数: {len(gdf):,}")
    classes, used = label_polygons(gdf, name_cols, rules)
    area = approx_area_km2(gdf)
    for c, a, name in zip(classes, area, used):
        class_area[int(c)] += a
        if c < 0:
            unmatched[name] += a
    if not args.inspect:
        rasterize_into(grid, gdf, classes, JAPAN_WEST, JAPAN_NORTH)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="植生図 → 紅葉マップ用の植生グリッド(public/data/koyoVegetation.*)")
    ap.add_argument("inputs", nargs="+", help="植生図のファイル、またはそれを含むフォルダ(再帰的に探す)")
    ap.add_argument("--inspect", action="store_true", help="列名・凡例名・分類結果だけ表示して終わる(ファイルは書かない)")
    ap.add_argument("--name-cols", help="凡例名の列(カンマ区切り、細かい方を先に)。省略時は日本語を含む文字列の列を自動選択")
    ap.add_argument("--encoding", help="Shapefileの文字コード(文字化けするとき cp932)")
    ap.add_argument("--extra-rules", help='分類ルールのJSON: [["正規表現","maple"], ...](組み込みより優先)')
    ap.add_argument("--out", default="public/data", help="出力先フォルダ(既定: public/data)")
    ap.add_argument(
        "--source",
        default="環境省 自然環境保全基礎調査 植生図(1/25,000)を加工して作成",
        help="meta に書く出典の文言",
    )
    ap.add_argument("--max-unmatched-share", type=float, default=0.3, help="未分類の面積がこれを超えたら警告(既定 0.3)")
    ap.add_argument(
        "--cell-scale",
        type=int,
        choices=(1, 2),
        default=2,
        help="メッシュの細かさ。2=約250m(既定。解像度2倍。ファイルは約3〜4倍で、作業に約1GBのメモリ)、1=従来の約500m",
    )
    args = ap.parse_args(argv)
    global LAT_STEP, LON_STEP, SUPERSAMPLE
    LAT_STEP = 1 / (240 * args.cell_scale)
    LON_STEP = 1 / (160 * args.cell_scale)
    SUPERSAMPLE = 3 if args.cell_scale == 2 else 4

    extra = None
    if args.extra_rules:
        extra = [tuple(x) for x in json.loads(Path(args.extra_rules).read_text(encoding="utf-8"))]
    rules = build_rules(extra)

    files = list_inputs(args.inputs)
    rows = int(round((JAPAN_NORTH - JAPAN_SOUTH) / LAT_STEP))
    cols = int(round((JAPAN_EAST - JAPAN_WEST) / LON_STEP))
    grid = np.full((rows, cols), CLASS_UNKNOWN, dtype=np.uint8)
    unmatched: Counter = Counter()
    class_area: Counter = Counter()

    for f in files:
        process_file(f, args, rules, grid, unmatched, class_area)

    print_class_table("ポリゴン面積の分類結果(km²)", class_area)
    total_area = sum(class_area.values()) or 1
    unmatched_total = sum(unmatched.values())
    if unmatched:
        print("\n未分類の凡例名(面積の大きい順。--extra-rules で分類を足せます):")
        for name, a in unmatched.most_common(40):
            print(f"  {100 * a / total_area:5.2f}%  {name}")
    if unmatched_total / total_area > args.max_unmatched_share:
        print(
            f"\n⚠ 未分類が全体の {100 * unmatched_total / total_area:.0f}% あります。"
            "凡例名の列(--name-cols)が合っていない可能性があります。",
            file=sys.stderr,
        )

    if args.inspect:
        print("\n(--inspect のためファイルは書き出しません)")
        return 0

    sub, west, north = crop_to_data(grid, JAPAN_WEST, JAPAN_NORTH)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    meta = {
        "version": 1,
        "west": west,
        "north": north,
        "lonStep": LON_STEP,
        "latStep": LAT_STEP,
        "cols": int(sub.shape[1]),
        "rows": int(sub.shape[0]),
        "source": args.source,
        "generatedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    (out_dir / "koyoVegetation.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with gzip.GzipFile(out_dir / "koyoVegetation.bin.gz", "wb", compresslevel=9, mtime=0) as gz:
        gz.write(np.ascontiguousarray(sub).tobytes())

    hist = Counter(sub.ravel().tolist())
    print(f"\n書き出し: {out_dir / 'koyoVegetation.json'} / koyoVegetation.bin.gz  ({meta['cols']}×{meta['rows']} メッシュ)")
    for cls in sorted(hist):
        label = CLASS_LABEL.get(cls, "植生図なし(255)" if cls == CLASS_UNKNOWN else str(cls))
        print(f"  {label:<18} {hist[cls]:>10,} メッシュ")
    return 0


if __name__ == "__main__":
    sys.exit(main())
