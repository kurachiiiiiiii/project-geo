package com.geowatcher.app.car

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import java.net.HttpURLConnection
import java.net.URL
import java.util.Calendar
import java.util.TimeZone
import kotlin.math.abs

/** 1コマ分(実況 or 予測)の情報。[src/features/rain/rainService.ts] の `RainFrame` に対応。 */
data class RainFrame(val basetime: String, val validtime: String)

/**
 * 気象庁 高解像度降水ナウキャストのタイル配信を、Android Autoの画面向けにネイティブ(Kotlin)から
 * 直接取得する。URLや絞り込み条件は [src/features/rain/rainService.ts] と同じにしてあり、
 * Web版と表示内容がずれないようにしている(非公式エンドポイントなので、高頻度なポーリングは
 * 避け、既定では5分間隔での確認を想定)。
 */
object RainTileRepository {
    private val TARGET_TIMES_URLS = listOf(
        "https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N1.json", // 実況・過去
        "https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N2.json", // 予測(今後60分)
    )

    /** タイルが実際に配信されているズームレベル([src/lib/rainTileLayer.ts] 参照)。 */
    val NATIVE_ZOOMS = intArrayOf(4, 6, 8, 10)

    fun nearestNativeZoom(zoom: Int): Int = NATIVE_ZOOMS.minByOrNull { abs(it - zoom) } ?: NATIVE_ZOOMS.last()

    private val tileCache = LruCache<String, Bitmap>(48)

    suspend fun fetchFrames(): List<RainFrame> = withContext(Dispatchers.IO) {
        val merged = TARGET_TIMES_URLS.flatMap { fetchTargetTimes(it) }
        val byValidTime = LinkedHashMap<String, RainFrame>()
        for (frame in merged) {
            val existing = byValidTime[frame.validtime]
            // 同じvalidtimeが重複する場合はbasetimeが新しい方(=より最近の観測に基づく予測)を優先する。
            if (existing == null || frame.basetime > existing.basetime) {
                byValidTime[frame.validtime] = frame
            }
        }
        byValidTime.values.sortedBy { it.validtime }
    }

    private fun fetchTargetTimes(urlString: String): List<RainFrame> {
        val json = httpGetString(urlString) ?: return emptyList()
        val array = runCatching { JSONArray(json) }.getOrNull() ?: return emptyList()
        val result = mutableListOf<RainFrame>()
        for (i in 0 until array.length()) {
            val obj = array.optJSONObject(i) ?: continue
            val basetime = obj.optString("basetime", "")
            val validtime = obj.optString("validtime", "")
            if (basetime.isEmpty() || validtime.isEmpty()) continue
            val elements = obj.optJSONArray("elements")
            val includesHrpns = elements == null || (0 until elements.length()).any { elements.optString(it) == "hrpns" }
            if (includesHrpns) result.add(RainFrame(basetime, validtime))
        }
        return result
    }

    /** そのフレームが「現況」ではなく「予測(未来のコマ)」かどうか。 */
    fun isForecastFrame(frame: RainFrame): Boolean = frame.validtime > frame.basetime

    fun tileUrl(frame: RainFrame, z: Int, x: Int, y: Int): String =
        "https://www.jma.go.jp/bosai/jmatile/data/nowc/${frame.basetime}/none/${frame.validtime}/surf/hrpns/$z/$x/$y.png"

    suspend fun fetchTile(frame: RainFrame, nativeZoom: Int, x: Int, y: Int): Bitmap? {
        val url = tileUrl(frame, nativeZoom, x, y)
        tileCache.get(url)?.let { return it }
        return withContext(Dispatchers.IO) {
            httpGetBitmap(url)?.also { tileCache.put(url, it) }
        }
    }

    private fun httpGetString(urlString: String): String? = runCatching {
        val connection = URL(urlString).openConnection() as HttpURLConnection
        connection.connectTimeout = 10_000
        connection.readTimeout = 10_000
        try {
            if (connection.responseCode != HttpURLConnection.HTTP_OK) return null
            connection.inputStream.bufferedReader().use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }.getOrNull()

    private fun httpGetBitmap(urlString: String): Bitmap? = runCatching {
        val connection = URL(urlString).openConnection() as HttpURLConnection
        connection.connectTimeout = 10_000
        connection.readTimeout = 10_000
        try {
            if (connection.responseCode != HttpURLConnection.HTTP_OK) return null
            connection.inputStream.use { BitmapFactory.decodeStream(it) }
        } finally {
            connection.disconnect()
        }
    }.getOrNull()
}

/**
 * validtime (YYYYMMDDHHmmss, UTC基準) を日本時間の短い表示文字列に変換する。
 * [src/features/rain/rainService.ts] の `formatValidTime` と同じ解釈(UTCとして読み、JSTへ変換)。
 */
fun formatRainValidTime(validtime: String): String {
    if (validtime.length < 12) return validtime
    return runCatching {
        val utc = Calendar.getInstance(TimeZone.getTimeZone("UTC"))
        utc.clear()
        utc.set(
            validtime.substring(0, 4).toInt(),
            validtime.substring(4, 6).toInt() - 1,
            validtime.substring(6, 8).toInt(),
            validtime.substring(8, 10).toInt(),
            validtime.substring(10, 12).toInt(),
        )
        val jst = Calendar.getInstance(TimeZone.getTimeZone("Asia/Tokyo"))
        jst.timeInMillis = utc.timeInMillis
        "%02d:%02d".format(jst.get(Calendar.HOUR_OF_DAY), jst.get(Calendar.MINUTE))
    }.getOrDefault(validtime)
}
