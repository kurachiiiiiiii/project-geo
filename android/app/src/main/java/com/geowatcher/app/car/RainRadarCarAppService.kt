package com.geowatcher.app.car

import androidx.car.app.CarAppService
import androidx.car.app.Session
import androidx.car.app.validation.HostValidator

/**
 * Android Auto(Android for Cars App Library)のエントリーポイント。
 * 車のディスプレイに接続してきたホスト(Android Autoアプリ本体 / Android Automotive OS)ごとに
 * [RainRadarSession] を1つ生成する。
 *
 * このアプリはGoogle Playには配布せず、自分の端末に直接インストールして使う個人利用アプリ
 * (詳しくは [capacitor.config.ts] のコメント参照)。そのため接続元ホストの署名検証は行わず、
 * 検証が不要な場合の標準的な選択肢である [HostValidator.ALLOW_ALL_HOSTS_VALIDATOR] を使う。
 */
class RainRadarCarAppService : CarAppService() {
    override fun createHostValidator(): HostValidator = HostValidator.ALLOW_ALL_HOSTS_VALIDATOR

    override fun onCreateSession(): Session = RainRadarSession()
}
