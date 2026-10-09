package com.geowatcher.app.car

import android.content.Intent
import androidx.car.app.Screen
import androidx.car.app.Session

/** 車の画面1つ分のライフサイクル。最初の画面として [RainRadarScreen] を返す。 */
class RainRadarSession : Session() {
    override fun onCreateScreen(intent: Intent): Screen = RainRadarScreen(carContext)
}
