package com.geowatcher.app.car

import kotlin.math.PI
import kotlin.math.atan
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sinh
import kotlin.math.tan

/**
 * 標準的なWeb Mercator投影(JMAのタイル配信を含め、多くの地図タイルが使う投影法)の座標変換。
 *
 * 「ズームレベル0のとき256pxの正方形になる世界地図」上のピクセル座標を基準にする(いわゆる
 * slippy map タイルの標準的な定義)。ズームzでの実際のピクセル座標は、この値に `2^z` を
 * 掛けるだけで求まるので、呼び出し側でズームごとに使い分ける。
 */
object WebMercator {
    const val TILE_SIZE = 256.0

    /** Web Mercatorで表現できる緯度の限界(これを超えると投影できない)。 */
    private const val MAX_LATITUDE = 85.05112878

    /** 緯度経度 → ズーム0基準のワールドピクセル座標 [x, y]。 */
    fun lngLatToWorldPixel(lng: Double, lat: Double): DoubleArray {
        val clampedLat = max(-MAX_LATITUDE, min(MAX_LATITUDE, lat))
        val x = (lng + 180.0) / 360.0 * TILE_SIZE
        val latRad = Math.toRadians(clampedLat)
        val y = (1.0 - ln(tan(latRad) + 1.0 / cos(latRad)) / PI) / 2.0 * TILE_SIZE
        return doubleArrayOf(x, y)
    }

    /** ズーム0基準のワールドピクセル座標 → 緯度経度 [lng, lat]。 */
    fun worldPixelToLngLat(x: Double, y: Double): DoubleArray {
        val lng = x / TILE_SIZE * 360.0 - 180.0
        val n = PI - 2.0 * PI * y / TILE_SIZE
        val lat = Math.toDegrees(atan(sinh(n)))
        return doubleArrayOf(lng, lat)
    }
}
