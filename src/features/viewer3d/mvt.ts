/**
 * Mapbox Vector Tile(.pbf)の読み取り(必要な分だけ)。国土地理院の「最適化ベクトルタイル」
 * (optimal_bvmap-v1)から、水面・河川・建物を読むために使う。外部のライブラリは使わない
 * (依存を増やすとPC側で`npm install`が要るようになり、アプリが起動しなくなる危険があるため)。
 *
 * 形式: タイル = レイヤーの並び(フィールド3)。レイヤー = 名前(1)・地物(2)・キー(3)・値(4)・範囲(5)。
 * 地物 = タグ(2。キーと値の番号の組)・種類(3。1=点 2=線 3=面)・ジオメトリ(4。コマンドの列)。
 * ジオメトリのコマンド: MoveTo(1)・LineTo(2)・ClosePath(7)。座標は差分で、符号はジグザグ符号化。
 */

export type MvtValue = string | number | boolean | null;

export interface MvtPath {
  /** x0,y0,x1,y1,…(タイルの座標。0〜extent。y は下向き) */
  pts: number[];
  /** 面のとき、輪の符号付き面積(shoelace)。外側の輪は正(時計回り)、穴は負 */
  area: number;
}

export interface MvtFeature {
  /** 1=点 2=線 3=面 */
  type: number;
  props: Record<string, MvtValue>;
  paths: MvtPath[];
}

export interface MvtLayer {
  name: string;
  extent: number;
  features: MvtFeature[];
}

class Reader {
  p = 0;
  readonly u8: Uint8Array;
  constructor(u8: Uint8Array) {
    this.u8 = u8;
  }

  varint(): number {
    let r = 0;
    let mul = 1;
    for (;;) {
      const b = this.u8[this.p++];
      r += (b & 127) * mul;
      if (b < 128) return r;
      mul *= 128;
      if (mul > 2 ** 56) return r;
    }
  }

  skip(wireType: number): void {
    if (wireType === 0) this.varint();
    else if (wireType === 1) this.p += 8;
    else if (wireType === 2) {
      // (`this.p += this.varint()` と書くと、varint()が進めた分が失われるので、長さを先に読む)
      const len = this.varint();
      this.p += len;
    }
    else if (wireType === 5) this.p += 4;
    else throw new Error("不明なワイヤータイプ");
  }
}

const textDecoder = new TextDecoder();

function decodeGeometry(type: number, cmds: number[]): MvtPath[] {
  const paths: MvtPath[] = [];
  let x = 0;
  let y = 0;
  let cur: number[] | null = null;
  const flush = () => {
    if (!cur) return;
    let area = 0;
    if (type === 3) {
      const n = cur.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        area += cur[i * 2] * cur[j * 2 + 1] - cur[j * 2] * cur[i * 2 + 1];
      }
      area /= 2;
    }
    paths.push({ pts: cur, area });
    cur = null;
  };
  let i = 0;
  while (i < cmds.length) {
    const head = cmds[i++];
    const cmd = head & 7;
    const count = head >>> 3;
    if (cmd === 7) {
      // ClosePath: 輪は暗黙に閉じる(最初の点を繰り返さない)
      flush();
      continue;
    }
    for (let k = 0; k < count; k++) {
      const dx = cmds[i++];
      const dy = cmds[i++];
      x += (dx >>> 1) ^ -(dx & 1);
      y += (dy >>> 1) ^ -(dy & 1);
      if (cmd === 1) {
        // MoveTo: 点はそのまま1つの地物、線・面は新しい線・輪の始まり
        flush();
        cur = [x, y];
        if (type === 1) flush();
      } else if (cur) {
        cur.push(x, y);
      }
    }
  }
  flush();
  return paths;
}

/** レイヤーの名前(フィールド1)を、位置を動かさずに探す */
function peekLayerName(r: Reader, start: number, end: number): string {
  const save = r.p;
  r.p = start;
  let name = "";
  while (r.p < end) {
    const t = r.varint();
    if (t >>> 3 === 1 && (t & 7) === 2) {
      const l = r.varint();
      name = textDecoder.decode(r.u8.subarray(r.p, r.p + l));
      break;
    }
    r.skip(t & 7);
  }
  r.p = save;
  return name;
}

/**
 * タイルを読む。`want`にレイヤー名を渡すと、その名前のレイヤーだけを読む(それ以外は読み飛ばす)。
 */
export function decodeMvt(buf: ArrayBuffer, want?: ReadonlySet<string>): MvtLayer[] {
  const r = new Reader(new Uint8Array(buf));
  const u8 = r.u8;
  const layers: MvtLayer[] = [];
  while (r.p < u8.length) {
    const tag = r.varint();
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn !== 3 || wt !== 2) {
      r.skip(wt);
      continue;
    }
    const len = r.varint();
    const end = r.p + len;
    const start = r.p;
    const name = peekLayerName(r, start, end);
    if (want && !want.has(name)) {
      r.p = end;
      continue;
    }
    r.p = start;
    const layer: MvtLayer = { name, extent: 4096, features: [] };
    const keys: string[] = [];
    const values: MvtValue[] = [];
    const rawFeatures: { tags: number[]; type: number; geom: number[] }[] = [];
    while (r.p < end) {
      const t = r.varint();
      const f = t >>> 3;
      const w = t & 7;
      if (f === 1 && w === 2) {
        const nameLen = r.varint(); // 名前(読み済み)
        r.p += nameLen;
      } else if (f === 2 && w === 2) {
        const l = r.varint();
        const e2 = r.p + l;
        const feat = { tags: [] as number[], type: 0, geom: [] as number[] };
        while (r.p < e2) {
          const t2 = r.varint();
          const f2 = t2 >>> 3;
          const w2 = t2 & 7;
          if (f2 === 2 && w2 === 2) {
            const l2 = r.varint();
            const e3 = r.p + l2;
            while (r.p < e3) feat.tags.push(r.varint());
          } else if (f2 === 3 && w2 === 0) {
            feat.type = r.varint();
          } else if (f2 === 4 && w2 === 2) {
            const l2 = r.varint();
            const e3 = r.p + l2;
            while (r.p < e3) feat.geom.push(r.varint());
          } else {
            r.skip(w2);
          }
        }
        rawFeatures.push(feat);
      } else if (f === 3 && w === 2) {
        const l = r.varint();
        keys.push(textDecoder.decode(u8.subarray(r.p, r.p + l)));
        r.p += l;
      } else if (f === 4 && w === 2) {
        const l = r.varint();
        const e2 = r.p + l;
        let val: MvtValue = null;
        while (r.p < e2) {
          const t2 = r.varint();
          const f2 = t2 >>> 3;
          const w2 = t2 & 7;
          if (f2 === 1 && w2 === 2) {
            const l2 = r.varint();
            val = textDecoder.decode(u8.subarray(r.p, r.p + l2));
            r.p += l2;
          } else if (f2 === 2 && w2 === 5) {
            val = new DataView(u8.buffer, u8.byteOffset + r.p, 4).getFloat32(0, true);
            r.p += 4;
          } else if (f2 === 3 && w2 === 1) {
            val = new DataView(u8.buffer, u8.byteOffset + r.p, 8).getFloat64(0, true);
            r.p += 8;
          } else if ((f2 === 4 || f2 === 5) && w2 === 0) {
            val = r.varint();
          } else if (f2 === 6 && w2 === 0) {
            const z = r.varint();
            val = z % 2 === 0 ? z / 2 : -(z + 1) / 2;
          } else if (f2 === 7 && w2 === 0) {
            val = r.varint() !== 0;
          } else {
            r.skip(w2);
          }
        }
        values.push(val);
      } else if (f === 5 && w === 0) {
        layer.extent = r.varint();
      } else {
        r.skip(w);
      }
    }
    for (const rf of rawFeatures) {
      const props: Record<string, MvtValue> = {};
      for (let i = 0; i + 1 < rf.tags.length; i += 2) props[keys[rf.tags[i]]] = values[rf.tags[i + 1]] ?? null;
      layer.features.push({ type: rf.type, props, paths: decodeGeometry(rf.type, rf.geom) });
    }
    layers.push(layer);
    r.p = end;
  }
  return layers;
}
