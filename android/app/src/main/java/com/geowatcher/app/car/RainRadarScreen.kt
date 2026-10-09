package com.geowatcher.app.car

import android.Manifest
import androidx.car.app.AppManager
import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.Header
import androidx.car.app.model.Pane
import androidx.car.app.model.PaneTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.Template
import androidx.car.app.navigation.model.MapController
import androidx.car.app.navigation.model.MapWithContentTemplate
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Android Auto上に表示する雨雲レーダーの画面。
 *
 * 実際の地図描画は [RadarSurfaceRenderer] がSurfaceへ直接行い、このクラスはCar App Libraryの
 * テンプレート(ヘッダー・操作ボタン)の組み立てと、位置情報・定期更新のライフサイクル管理を担当する。
 */
class RainRadarScreen(carContext: CarContext) : Screen(carContext) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val locationProvider = CarLocationProvider(carContext)

    private var latestFrame: RainFrame? = null
    private var latestFrameCount = 0
    private var latestFrameIndex = 0

    private val renderer = RadarSurfaceRenderer(carContext, scope) { frame, frameList, index ->
        latestFrame = frame
        latestFrameCount = frameList.size
        latestFrameIndex = index
        invalidate()
    }

    init {
        lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onCreate(owner: LifecycleOwner) {
                // Surfaceへの描画は、テンプレート(MapWithContentTemplate)ではなくAppManager経由で登録する
                // (MapController自体にはSurfaceCallbackを渡す口が無い。ここが公式の登録ポイント)。
                carContext.getCarService(AppManager::class.java).setSurfaceCallback(renderer)
                renderer.start()
                startLocationUpdates()
                // JMAナウキャストは5分更新なので、その周期に合わせて新しいコマを確認する。
                scope.launch {
                    while (true) {
                        delay(5 * 60 * 1000L)
                        renderer.refreshData()
                    }
                }
            }

            override fun onDestroy(owner: LifecycleOwner) {
                locationProvider.stop()
                renderer.stop()
                scope.cancel()
            }
        })
    }

    private fun startLocationUpdates() {
        if (locationProvider.hasPermission()) {
            locationProvider.lastKnownLocation()?.let { renderer.onLocationUpdate(it) }
            locationProvider.start { renderer.onLocationUpdate(it) }
            return
        }
        carContext.requestPermissions(
            listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
        ) { approved, _ ->
            if (approved.isNotEmpty()) {
                locationProvider.lastKnownLocation()?.let { renderer.onLocationUpdate(it) }
                locationProvider.start { renderer.onLocationUpdate(it) }
            }
        }
    }

    override fun onGetTemplate(): Template {
        val header = Header.Builder()
            .setTitle("雨雲レーダー")
            .setStartHeaderAction(Action.APP_ICON)
            .build()

        // 実際の地図(レーダー画像)はSurface側に自前で描画するため、ここでの「内容」は
        // 現在のコマの時刻など、地図の下に添える簡単な状態表示だけにする。
        val statusRow = Row.Builder()
            .setTitle(statusText())
            .addText("地図をタップで現在地に戻る")
            .build()
        val contentTemplate = PaneTemplate.Builder(Pane.Builder().addRow(statusRow).build())
            .setHeader(header)
            .build()

        val actionStrip = ActionStrip.Builder()
            .addAction(textAction("縮小") { renderer.zoomOut() })
            .addAction(textAction("拡大") { renderer.zoomIn() })
            .addAction(textAction("現在地") { renderer.recenterOnLocation() })
            .addAction(textAction("更新") { renderer.refreshData() })
            .build()

        // MapWithContentTemplate自体にSurfaceCallbackを渡す口は無い(onCreateでAppManager経由で
        // 登録済み)。MapControllerはパン操作の状態通知などに使う付随情報という位置づけ。
        val mapController = MapController.Builder()
            .setPanModeListener { }
            .build()

        return MapWithContentTemplate.Builder()
            .setContentTemplate(contentTemplate)
            .setActionStrip(actionStrip)
            .setMapController(mapController)
            .build()
    }

    private fun statusText(): String {
        val frame = latestFrame ?: return "データ取得中…"
        val time = formatRainValidTime(frame.validtime)
        val kind = if (RainTileRepository.isForecastFrame(frame)) "予測" else "実況"
        val position = if (latestFrameCount > 0) "  (${latestFrameIndex + 1}/$latestFrameCount)" else ""
        return "$time JST・$kind$position"
    }

    private fun textAction(label: String, onClick: () -> Unit): Action =
        Action.Builder()
            .setTitle(label)
            .setOnClickListener(onClick)
            .build()
}
