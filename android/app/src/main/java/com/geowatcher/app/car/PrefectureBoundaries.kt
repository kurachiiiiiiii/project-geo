package com.geowatcher.app.car

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * 都道府県境界(GeoJSON)を読み込み、Android Autoの画面で背景として描く簡易な線に変換する。
 *
 * Web版が使っているデータをそのまま流用する。[public/data/japanPrefectures.geojson] が
 * `npx cap sync` の際に `assets/public/data/...` としてAndroidアセットに複製されるので、
 * それをそのまま読む(二重管理を避けるため、この機能専用のコピーは作らない)。
 *
 * 各リング(輪郭線)は、ズーム0基準のワールドピクセル座標([WebMercator])の配列として保持する。
 * 描画側はズームに応じて定数倍するだけで済む。
 */
object PrefectureBoundaries {
    private const val ASSET_PATH = "public/data/japanPrefectures.geojson"

    /** 失敗した場合は空リストを返す(背景の境界線が無いだけで、レーダー自体の表示は継続できる)。 */
    fun load(context: Context): List<FloatArray> = runCatching {
        val json = context.assets.open(ASSET_PATH).bufferedReader().use { it.readText() }
        val root = JSONObject(json)
        val features = root.optJSONArray("features") ?: JSONArray()
        val rings = mutableListOf<FloatArray>()
        for (i in 0 until features.length()) {
            val geometry = features.optJSONObject(i)?.optJSONObject("geometry") ?: continue
            when (geometry.optString("type")) {
                "Polygon" -> addPolygon(geometry.optJSONArray("coordinates"), rings)
                "MultiPolygon" -> {
                    val polygons = geometry.optJSONArray("coordinates") ?: continue
                    for (p in 0 until polygons.length()) {
                        addPolygon(polygons.optJSONArray(p), rings)
                    }
                }
            }
        }
        rings
    }.getOrDefault(emptyList())

    private fun addPolygon(polygon: JSONArray?, out: MutableList<FloatArray>) {
        polygon ?: return
        for (r in 0 until polygon.length()) {
            val ring = polygon.optJSONArray(r) ?: continue
            val points = FloatArray(ring.length() * 2)
            for (i in 0 until ring.length()) {
                val coord = ring.optJSONArray(i) ?: continue
                val world = WebMercator.lngLatToWorldPixel(coord.optDouble(0), coord.optDouble(1))
                points[i * 2] = world[0].toFloat()
                points[i * 2 + 1] = world[1].toFloat()
            }
            out.add(points)
        }
    }
}
