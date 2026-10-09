import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { CameraConfig } from "../types";
import { Ico } from "./Ico";
import { Search, X } from "../lib/lucide";
import { errorMessage } from "../lib/errorMessage";

/**
 * 地図の左上の検索(「検索機能を追加する」への対応)。
 *   ・地名・住所・山・施設 = 国土地理院の地名検索(https://msearch.gsi.go.jp/address-search/AddressSearch。CORS可・キー不要)
 *   ・ライブカメラ = 読み込み済みのカメラの名前(部分一致)
 * 入力をやめて0.35秒たったら検索する(Enterですぐ検索。↑↓で選び、Enterで決定、Escで閉じる)。
 * 選ぶと、地図をその地点へ寄せて、地図をクリックしたときと同じように天文情報(「3Dで見渡す」ボタンつき)を出す。
 */

export interface PlaceHit {
  title: string;
  lat: number;
  lng: number;
  kind: "place" | "camera";
}

interface Props {
  cameras: CameraConfig[];
  onSelect: (hit: PlaceHit) => void;
  /** 「現在地を取得」ボタンが無い(Android版)ときは左端に寄せる */
  atLeft?: boolean;
}

const GSI_SEARCH = "https://msearch.gsi.go.jp/address-search/AddressSearch?q=";
const MAX_PLACES = 8;
const MAX_CAMERAS = 4;
const SEARCH_TIMEOUT_MS = 10_000;

interface GsiFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: { title?: string };
}

async function searchGsi(q: string, signal: AbortSignal): Promise<PlaceHit[]> {
  const res = await fetch(GSI_SEARCH + encodeURIComponent(q), { signal });
  if (!res.ok) throw new Error(`地名検索に失敗しました(${res.status})`);
  const list = (await res.json()) as GsiFeature[];
  const seen = new Set<string>();
  const out: PlaceHit[] = [];
  for (const f of list) {
    const c = f.geometry?.coordinates;
    const title = f.properties?.title?.trim();
    if (!c || !title || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    const key = `${title}|${c[0].toFixed(4)}|${c[1].toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, lat: c[1], lng: c[0], kind: "place" });
    if (out.length >= MAX_PLACES) break;
  }
  return out;
}

function searchCameras(cameras: CameraConfig[], q: string): PlaceHit[] {
  const needle = q.toLowerCase();
  const out: PlaceHit[] = [];
  for (const c of cameras) {
    if (!c.name.toLowerCase().includes(needle)) continue;
    out.push({ title: c.name, lat: c.lat, lng: c.lng, kind: "camera" });
    if (out.length >= MAX_CAMERAS) break;
  }
  return out;
}

export default function PlaceSearch({ cameras, onSelect, atLeft = false }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [active, setActive] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef(0);
  const camerasRef = useRef(cameras);
  useEffect(() => {
    camerasRef.current = cameras;
  }, [cameras]);

  const run = (q: string) => {
    window.clearTimeout(timerRef.current);
    abortRef.current?.abort();
    const text = q.trim();
    setSearched(false);
    if (!text) {
      setHits([]);
      setBusy(false);
      setError(null);
      return;
    }
    const ac = new AbortController();
    abortRef.current = ac;
    const timeout = window.setTimeout(() => ac.abort(), SEARCH_TIMEOUT_MS);
    const cams = searchCameras(camerasRef.current, text);
    setHits(cams);
    setActive(0);
    setOpen(true);
    setBusy(true);
    setError(null);
    searchGsi(text, ac.signal)
      .then((places) => {
        if (ac.signal.aborted) return;
        setHits([...places, ...cams]);
      })
      .catch((e: unknown) => {
        if (abortRef.current !== ac) return;
        setError(ac.signal.aborted ? "地名検索の応答がありませんでした" : errorMessage(e));
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (abortRef.current === ac) {
          setBusy(false);
          setSearched(true);
        }
      });
  };

  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current);
      abortRef.current?.abort();
    },
    [],
  );

  const choose = (h: PlaceHit) => {
    onSelect(h);
    setOpen(false);
  };

  const onChange = (v: string) => {
    setQuery(v);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => run(v), 350);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (open && hits[active]) choose(hits[active]);
      else run(query);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(hits.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const showList = open && query.trim() !== "" && (hits.length > 0 || busy || error !== null || searched);

  return (
    <div className={`place-search${atLeft ? " place-search--left" : ""}`} role="search">
      <div className="place-search__box">
        <Ico icon={Search} />
        <input
          type="search"
          className="place-search__input"
          value={query}
          placeholder="地名・住所・山・カメラを検索"
          aria-label="地名・住所・山・カメラを検索"
          aria-expanded={showList}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => {
            if (hits.length > 0) setOpen(true);
          }}
        />
        {query && (
          <button
            type="button"
            className="place-search__clear"
            aria-label="検索を消す"
            onClick={() => {
              setQuery("");
              run("");
              setOpen(false);
            }}
          >
            <Ico icon={X} />
          </button>
        )}
      </div>
      {showList && (
        <ul className="place-search__list" role="listbox">
          {hits.map((h, i) => (
            <li key={`${h.kind}:${h.title}:${h.lat}:${h.lng}`} role="option" aria-selected={i === active}>
              <button
                type="button"
                className={`place-search__item${i === active ? " place-search__item--active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(h)}
              >
                <span className="place-search__kind">{h.kind === "camera" ? "カメラ" : "地名"}</span>
                <span className="place-search__title">{h.title}</span>
              </button>
            </li>
          ))}
          {busy && <li className="place-search__note">検索中…</li>}
          {!busy && error && <li className="place-search__note">{error}</li>}
          {!busy && !error && hits.length === 0 && <li className="place-search__note">見つかりませんでした</li>}
        </ul>
      )}
    </div>
  );
}
