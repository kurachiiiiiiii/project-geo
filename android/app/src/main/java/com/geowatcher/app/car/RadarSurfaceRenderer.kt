package com.geowatcher.app.car

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.location.Location
import androidx.car.app.CarContext
import androidx.car.app.SurfaceCallback
import androidx.car.app.SurfaceContainer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * Android Autoの画面(Surface)へ、雨雲レーダー(JMA高解像度降水ナウキャスト)を直接Canvas描画する。
 *
 * 通常のCar App Libraryのテンプレートは決められた部品(リスト・グリッド等)しか描画できないが、
 * MapWithContentTemplate + SurfaceCallback を使うと地図に相当する領域だけは自由に描画できる。
 * Web版がLeaflet(タイルレイヤー)で行っていることを、ここではCanvas上で自前のタイル合成・
 * Web Mercator投影として作り直している([WebMercator] 参照)。
 *
 * タイルの配信ズーム(4/6/8/10)以外は表示しない(=ズーム操作はこの4段階のみを行き来する)。
 * 中間ズームを補間表示しようとすると投影計算が複雑になるうえ、そもそもJMA側にそれ以外の
 * 解像度のデータが存在しないため、素直に「配信されている解像度をそのまま出す」設計にした。
 */
class RadarSurfaceRenderer(
    private val carContext: CarContext,
    private val scope: CoroutineScope,
    private val onFrameInfoChanged: (RainFrame?, List<RainFrame>, Int) -> Unit,
) : SurfaceCallback {

    private var surfaceContainer: SurfaceContainer? = null
    private var visibleArea: Rect? = null

    // 初期値は現在地が取れるまでの仮の中心(長野県庁付近)。このアプリ自体が信州エリアの
    // 運転向け情報を扱う想定のため、フォールバックもこのあたりにしている。
    private var centerLng = 137.9720
    private var centerLat = 36.6513
    private var zoomIndex = 2 // NATIVE_ZOOMS = [4,6,8,10] のインデックス。既定は8。

    private var currentLocation: Location? = null
    private var followLocation = true
    private var pinchAccumulator = 1.0

    private var frames: List<RainFrame> = emptyList()
    private var frameIndex = 0
    private val currentFrame: RainFrame? get() = frames.getOrNull(frameIndex)
    private val zoom: Int get() = RainTileRepository.NATIVE_ZOOMS[zoomIndex]

    private var prefectureBoundaries: List<FloatArray> = emptyList()
    private val tileBitmaps = HashMap<String, Bitmap>()
    private val pendingTileFetches = HashSet<String>()
    private var renderJob: Job? = null
    private var dataJob: Job? = null

    private val bgPaint = Paint().apply { color = Color.parseColor("#10151c") }
    private val boundaryPaint = Paint().apply {
        color = Color.parseColor("#8fa3b8")
        style = Paint.Style.STROKE
        strokeWidth = 2f
        isAntiAlias = true
    }
    private val locationDotPaint = Paint().apply {
        color = Color.parseColor("#4fa8ff")
        style = Paint.Style.FILL
        isAntiAlias = true
    }
    private val locationRingPaint = Paint().apply {
        color = Color.WHITE
        style = Paint.Style.STROKE
        strokeWidth = 3f
        isAntiAlias = true
    }
    private val labelPaint = Paint().apply {
        color = Color.WHITE
        textSize = 32f
        isAntiAlias = true
        setShadowLayer(6f, 0f, 0f, Color.BLACK)
    }

    fun start() {
        scope.launch {
            prefectureBoundaries = withContext(Dispatchers.IO) { PrefectureBoundaries.load(carContext) }
            requestRender()
        }
        refreshData()
    }

    fun stop() {
        renderJob?.cancel()
        dataJob?.cancel()
        tileBitmaps.clear()
        pendingTileFetches.clear()
    }

    fun onLocationUpdate(location: Location) {
        currentLocation = location
        if (followLocation) {
            centerLat = location.latitude
            centerLng = location.longitude
            loadVisibleTiles()
        }
        requestRender()
    }

    fun refreshData() {
        dataJob?.cancel()
        dataJob = scope.launch {
            val fetched = runCatching { RainTileRepository.fetchFrames() }.getOrNull().orEmpty()
            if (fetched.isEmpty()) return@launch
            frames = fetched
            // 「実況」の最新コマ(=予測ではない最後のコマ)を既定表示にする。
            frameIndex = fetched.indexOfLast { !RainTileRepository.isForecastFrame(it) }
                .let { if (it >= 0) it else fetched.size - 1 }
            tileBitmaps.clear()
            pendingTileFetches.clear()
            onFrameInfoChanged(currentFrame, frames, frameIndex)
            loadVisibleTiles()
        }
    }

    fun stepFrame(delta: Int) {
        if (frames.isEmpty()) return
        val next = (frameIndex + delta).coerceIn(0, frames.size - 1)
        if (next == frameIndex) return
        frameIndex = next
        loadVisibleTiles()
        onFrameInfoChanged(currentFrame, frames, frameIndex)
        requestRender()
    }

    fun zoomIn() = changeZoom(1)
    fun zoomOut() = changeZoom(-1)

    private fun changeZoom(delta: Int) {
        val next = (zoomIndex + delta).coerceIn(0, RainTileRepository.NATIVE_ZOOMS.size - 1)
        if (next == zoomIndex) return
        zoomIndex = next
        loadVisibleTiles()
        requestRender()
    }

    fun recenterOnLocation() {
        followLocation = true
        currentLocation?.let {
            centerLat = it.latitude
            centerLng = it.longitude
        }
        loadVisibleTiles()
        requestRender()
    }

    // --- SurfaceCallback ---

    override fun onSurfaceAvailable(surfaceContainer: SurfaceContainer) {
        this.surfaceContainer = surfaceContainer
        loadVisibleTiles()
        requestRender()
    }

    override fun onSurfaceDestroyed(surfaceContainer: SurfaceContainer) {
        this.surfaceContainer = null
    }

    override fun onVisibleAreaChanged(visibleArea: Rect) {
        this.visibleArea = visibleArea
        requestRender()
    }

    override fun onScroll(distanceX: Float, distanceY: Float) {
        followLocation = false
        val scale = scaleFor(zoom)
        val centerWorld = WebMercator.lngLatToWorldPixel(centerLng, centerLat)
        // SurfaceCallback#onScrollのdistanceX/Yは、Android標準のGestureDetectorと同じ規約
        // ((直前の指位置 - 今の指位置)、つまり指の移動方向と符号が逆)だという前提で計算している。
        // 指を右へドラッグ(=distanceXが負)すると地図が指に追従して右へ動く(=中心の world 座標は
        // 左=小さい方へ動く)ようにするには、中心座標に distance をそのまま加える。
        val newWorld = doubleArrayOf(
            centerWorld[0] * scale + distanceX,
            centerWorld[1] * scale + distanceY,
        )
        val newLngLat = WebMercator.worldPixelToLngLat(newWorld[0] / scale, newWorld[1] / scale)
        centerLng = newLngLat[0]
        centerLat = newLngLat[1]
        loadVisibleTiles()
        requestRender()
    }

    override fun onScale(focusX: Float, focusY: Float, scaleFactor: Float) {
        followLocation = false
        pinchAccumulator *= scaleFactor
        if (pinchAccumulator > 1.35) {
            pinchAccumulator = 1.0
            changeZoom(1)
        } else if (pinchAccumulator < 1.0 / 1.35) {
            pinchAccumulator = 1.0
            changeZoom(-1)
        }
    }

    override fun onClick(x: Float, y: Float) {
        recenterOnLocation()
    }

    // --- 描画本体 ---

    private fun scaleFor(z: Int): Double = (1 shl z).toDouble()

    private fun requestRender() {
        renderJob?.cancel()
        renderJob = scope.launch(Dispatchers.Main) { drawFrame() }
    }

    private fun drawFrame() {
        val container = surfaceContainer ?: return
        val surface = container.surface
        if (surface == null || !surface.isValid) return
        val canvas: Canvas = try {
            surface.lockCanvas(null)
        } catch (e: Exception) {
            return
        }
        try {
            renderTo(canvas, container.width, container.height)
        } finally {
            runCatching { surface.unlockCanvasAndPost(canvas) }
        }
    }

    private fun renderTo(canvas: Canvas, width: Int, height: Int) {
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), bgPaint)
        if (width <= 0 || height <= 0) return

        val scale = scaleFor(zoom)
        val centerWorld = WebMercator.lngLatToWorldPixel(centerLng, centerLat)
        val originX = centerWorld[0] * scale - width / 2.0
        val originY = centerWorld[1] * scale - height / 2.0

        if (prefectureBoundaries.isNotEmpty()) {
            val path = Path()
            for (ring in prefectureBoundaries) {
                var i = 0
                while (i < ring.size) {
                    val px = (ring[i] * scale - originX).toFloat()
                    val py = (ring[i + 1] * scale - originY).toFloat()
                    if (i == 0) path.moveTo(px, py) else path.lineTo(px, py)
                    i += 2
                }
                path.close()
            }
            canvas.drawPath(path, boundaryPaint)
        }

        val frame = currentFrame
        if (frame != null) {
            val range = visibleTileRange(width, height)
            for (tileY in range.minY..range.maxY) {
                for (tileXRaw in range.minX..range.maxX) {
                    val tileX = wrapTileX(tileXRaw, range.tileCount)
                    val bitmap = tileBitmaps[tileKey(frame, zoom, tileX, tileY)] ?: continue
                    val left = (tileXRaw * WebMercator.TILE_SIZE - originX).toFloat()
                    val top = (tileY * WebMercator.TILE_SIZE - originY).toFloat()
                    val size = WebMercator.TILE_SIZE.toFloat()
                    canvas.drawBitmap(bitmap, null, RectF(left, top, left + size, top + size), null)
                }
            }
        }

        currentLocation?.let { location ->
            val world = WebMercator.lngLatToWorldPixel(location.longitude, location.latitude)
            val x = (world[0] * scale - originX).toFloat()
            val y = (world[1] * scale - originY).toFloat()
            canvas.drawCircle(x, y, 11f, locationDotPaint)
            canvas.drawCircle(x, y, 11f, locationRingPaint)
        }

        val inset = visibleArea
        val textX = (inset?.left ?: 0).toFloat() + 24f
        val textY = (inset?.top ?: 0).toFloat() + 52f
        val label = when {
            frame == null -> "データ取得中…"
            RainTileRepository.isForecastFrame(frame) -> "${formatRainValidTime(frame.validtime)} JST(予測)"
            else -> "${formatRainValidTime(frame.validtime)} JST"
        }
        canvas.drawText(label, textX, textY, labelPaint)
    }

    private class TileRange(val minX: Int, val maxX: Int, val minY: Int, val maxY: Int, val tileCount: Int)

    private fun visibleTileRange(width: Int, height: Int): TileRange {
        val scale = scaleFor(zoom)
        val tileCount = 1 shl zoom
        val centerWorld = WebMercator.lngLatToWorldPixel(centerLng, centerLat)
        val originX = centerWorld[0] * scale - width / 2.0
        val originY = centerWorld[1] * scale - height / 2.0
        val minX = floor(originX / WebMercator.TILE_SIZE).toInt() - 1
        val maxX = ceil((originX + width) / WebMercator.TILE_SIZE).toInt() + 1
        val minY = max(0, floor(originY / WebMercator.TILE_SIZE).toInt() - 1)
        val maxY = min(tileCount - 1, ceil((originY + height) / WebMercator.TILE_SIZE).toInt() + 1)
        return TileRange(minX, maxX, minY, maxY, tileCount)
    }

    private fun wrapTileX(x: Int, tileCount: Int): Int = ((x % tileCount) + tileCount) % tileCount

    private fun tileKey(frame: RainFrame, z: Int, x: Int, y: Int) = "${frame.validtime}_${z}_${x}_$y"

    private fun loadVisibleTiles() {
        val frame = currentFrame ?: return
        val container = surfaceContainer ?: return
        if (container.width <= 0 || container.height <= 0) return
        val range = visibleTileRange(container.width, container.height)
        for (tileY in range.minY..range.maxY) {
            for (tileXRaw in range.minX..range.maxX) {
                val tileX = wrapTileX(tileXRaw, range.tileCount)
                val key = tileKey(frame, zoom, tileX, tileY)
                if (tileBitmaps.containsKey(key) || !pendingTileFetches.add(key)) continue
                scope.launch {
                    val bitmap = runCatching { RainTileRepository.fetchTile(frame, zoom, tileX, tileY) }.getOrNull()
                    pendingTileFetches.remove(key)
                    if (bitmap != null && frame == currentFrame) {
                        tileBitmaps[key] = bitmap
                        requestRender()
                    }
                }
            }
        }
    }
}
