"""
天の川の明るさの地図(public/data/milkyway_gal.png)を作る。3Dビューの空のシェーダー(viewerGl.ts の SKY_FS)が、
天の川の形(帯の幅・明るい星の雲・暗黒帯の裂け目)の大まかな形に使う。細かい模様・星は、シェーダーで足す。

元データ: Milky Way Outline Catalog(Jose R. Vieira, http://www.skymap.com/milkyway_cat.htm)を GeoJSON にした
d3-celestial(Olaf Frohn, BSD License)の data/mw.json
  https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/mw.json
明るさの5段階の輪郭(赤道座標)を塗り分けて足し(0〜5段)、銀河座標(経度 -180〜180°・緯度 -45〜45°)の
2048×512画素(約0.18°/画素)の画像にする。R = 段数/5(0〜255。約0.25°ぼかす)。
G = 帯の周りのぼんやりした光の量(Rを半径約2.5°と約7°でぼかして半々に混ぜ、平方根にしたもの。シェーダーで2乗して使う)。
B = Rを半径約1°でぼかしたもの(帯の淡い所の縁をなだらかにする)。

使い方: python3 scripts/build-milkyway-map.py mw.json public/data/milkyway_gal.png
(numpy・Pillow・scipy が要る)
"""
import json, math, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

src, out = sys.argv[1], sys.argv[2]
d = json.load(open(src))
W, H = 3600, 1800  # equatorial plate carree, 0.1 deg/px. x = RA(0..360), y = 90-Dec
def to_px(ra, dec):
    return (ra % 360.0) * W / 360.0, (90.0 - dec) * H / 180.0

acc = np.zeros((H, W), np.float32)
for f in d["features"]:
    level = np.zeros((H, W), np.uint8)
    rings = [r for p in f["geometry"]["coordinates"] for r in p]
    for r in rings:
        # unwrap RA so the ring is continuous
        pts = []
        prev = None
        for ra, dec in r:
            ra = ra % 360.0
            if prev is not None:
                while ra - prev > 180: ra -= 360
                while ra - prev < -180: ra += 360
            pts.append((ra, dec)); prev = ra
        # 天球を一周する輪(天の川の縁は、赤経を一周する)は、南極側を回って閉じる(偶奇で塗ると、2本の縁の間=帯が塗られる)
        wind = round((pts[-1][0] - pts[0][0]) / 360.0)
        poly = pts
        if wind != 0:
            poly = pts + [(pts[-1][0], -90.0), (pts[0][0], -90.0)]
        for k in (-2, -1, 0, 1, 2):
            shift = 360.0 * k
            img = Image.new("L", (W, H), 0)
            ImageDraw.Draw(img).polygon([((ra + shift) * W / 360.0, (90.0 - dec) * H / 180.0) for ra, dec in poly], fill=1)
            a = np.asarray(img, np.uint8)
            if a.any(): level ^= a
    # 輪を閉じる線の1画素の筋を消す
    level = (np.asarray(Image.fromarray(level * 255).filter(ImageFilter.MedianFilter(5)), np.uint8) > 127).astype(np.uint8)
    acc += level
    print(f["id"], "filled px", int(level.sum()))
acc /= 5.0
# equatorial -> galactic map: l in [-180,180) (center l=0 at u=0.5, increasing with u), b in [-45,45] (top=+45)
GW, GH = 2048, 512
# J2000 equatorial->galactic rotation (inverse used: galactic unit vector -> equatorial)
Rg = np.array([[-0.0548755604, -0.8734370902, -0.4838350155],
               [ 0.4941094279, -0.4448296300,  0.7469822445],
               [-0.8676661490, -0.1980763734,  0.4559837762]])  # rows: galactic x,y,z in equatorial coords
u = (np.arange(GW) + 0.5) / GW
v = (np.arange(GH) + 0.5) / GH
L = (u - 0.5) * 2 * math.pi
B = (0.5 - v) * (math.pi / 2)
LL, BB = np.meshgrid(L, B)
g = np.stack([np.cos(BB) * np.cos(LL), np.cos(BB) * np.sin(LL), np.sin(BB)], axis=-1)
e = g @ Rg  # equatorial vector
ra = np.degrees(np.arctan2(e[..., 1], e[..., 0])) % 360.0
dec = np.degrees(np.arcsin(np.clip(e[..., 2], -1, 1)))
# blur the equatorial map slightly (0.25 deg) before sampling
blur = Image.fromarray((acc * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2.5))
A = np.asarray(blur, np.float32) / 255.0
x = np.clip((ra * W / 360.0).astype(int), 0, W - 1)
y = np.clip(((90.0 - dec) * H / 180.0).astype(int), 0, H - 1)
gal = A[y, x]
# G: 天の川の周りの、なだらかに広がるぼんやりした光の量(帯の地図を大きくぼかしたもの)。
# 半径約2.5°と約7°のぼかしを半々に混ぜる(経度方向は一周つなげる)。暗い裾の段差が出ないよう、平方根で入れる(シェーダーで2乗して戻す)
from scipy.ndimage import gaussian_filter
pxdeg = 360.0 / GW
env = 0.5 * gaussian_filter(gal, 2.5 / pxdeg, mode=("constant", "wrap")) + 0.5 * gaussian_filter(gal, 7.0 / pxdeg, mode=("constant", "wrap"))
rgb = np.zeros((GH, GW, 3), np.uint8)
rgb[..., 0] = (np.clip(gal, 0, 1) * 255).round()
rgb[..., 1] = (np.sqrt(np.clip(env, 0, 1)) * 255).round()
# B: Rを半径約1°でぼかしたもの。帯の淡い所(外縁・暗黒帯の中)では、こちらを使って縁をなだらかにする
rgb[..., 2] = (np.clip(gaussian_filter(gal, 1.0 / pxdeg, mode=("constant", "wrap")), 0, 1) * 255).round()
Image.fromarray(rgb, "RGB").save(out, optimize=True)
print("saved", out, gal.shape, "max", gal.max(), "mean", gal.mean(), "env max", env.max())
