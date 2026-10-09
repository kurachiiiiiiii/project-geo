const EARTH_RADIUS_KM = 6371;

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * 出発点から方位角(度, 北=0/東=90)の向きへ、大圏コースで distanceKm 進んだ地点を求める。
 * 地図上に「方角の線」を引くための終点計算に使う(src/components/AstroPointPopup.tsx)。
 */
export function destinationPoint(origin: LatLng, azimuthDeg: number, distanceKm: number): LatLng {
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;
  const phi1 = origin.lat * rad;
  const lambda1 = origin.lng * rad;
  const theta = azimuthDeg * rad;
  const delta = distanceKm / EARTH_RADIUS_KM;

  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta),
  );
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
    );

  return { lat: phi2 * deg, lng: lambda2 * deg };
}
