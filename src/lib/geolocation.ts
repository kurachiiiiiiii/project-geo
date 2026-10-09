/** 「現在地を取得するボタンを追加してください」という指示への対応。ブラウザのGeolocation APIの薄いラッパー */
export interface GeoPoint {
  lat: number;
  lng: number;
}

function geolocationErrorMessage(err: GeolocationPositionError): string {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return "現在地の取得が許可されませんでした(ブラウザの位置情報の許可設定を確認してください)";
    case err.POSITION_UNAVAILABLE:
      return "現在地を取得できませんでした(位置情報が利用できません)";
    case err.TIMEOUT:
      return "現在地の取得がタイムアウトしました";
    default:
      return "現在地の取得に失敗しました";
  }
}

/** 現在地(緯度経度)を1回だけ取得する。HTTPS(またはlocalhost)以外では多くのブラウザがそもそも許可しない */
export function getCurrentPosition(): Promise<GeoPoint> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("このブラウザは現在地取得に対応していません"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error(geolocationErrorMessage(err))),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  });
}
