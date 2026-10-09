package com.geowatcher.app.car

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Looper
import androidx.core.content.ContextCompat

/**
 * 現在地(緯度経度)を取得する薄いラッパー。役割は [src/lib/geolocation.ts] (Web版)と同じだが、
 * Android Autoの画面はブラウザを介さずネイティブに動くため、素の [LocationManager] を直接使う
 * (Google Play Servicesの位置情報APIは新たな依存関係を増やすため、既存アプリが使っていない
 * このAPIをこの機能のためだけに追加することは避けた)。
 */
class CarLocationProvider(private val context: Context) {
    private val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private var listener: LocationListener? = null

    fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
                PackageManager.PERMISSION_GRANTED

    private fun enabledProviders(): List<String> =
        listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)
            .filter { runCatching { locationManager.isProviderEnabled(it) }.getOrDefault(false) }

    /** 直近の位置がわかればすぐ返す(GPSの初回測位を待たずに、とりあえずの表示に使う)。 */
    fun lastKnownLocation(): Location? {
        if (!hasPermission()) return null
        return enabledProviders()
            .mapNotNull { runCatching { locationManager.getLastKnownLocation(it) }.getOrNull() }
            .maxByOrNull { it.time }
    }

    /** 位置が更新されるたびに [onLocation] を呼ぶ。呼び出し側は不要になったら必ず [stop] すること。 */
    fun start(onLocation: (Location) -> Unit) {
        if (!hasPermission()) return
        stop()
        val provider = when {
            runCatching { locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER) }.getOrDefault(false) ->
                LocationManager.GPS_PROVIDER
            runCatching { locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER) }.getOrDefault(false) ->
                LocationManager.NETWORK_PROVIDER
            else -> return
        }
        val newListener = object : LocationListener {
            override fun onLocationChanged(location: Location) = onLocation(location)
        }
        listener = newListener
        // 走行中に少しずつ地図がずれるのを避けたいので、間隔は短め・距離は50m刻みで更新する。
        runCatching {
            locationManager.requestLocationUpdates(provider, 15_000L, 50f, newListener, Looper.getMainLooper())
        }
    }

    fun stop() {
        listener?.let { runCatching { locationManager.removeUpdates(it) } }
        listener = null
    }
}
