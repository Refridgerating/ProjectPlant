import { useEffect, useMemo } from "react";
import { Circle, MapContainer, TileLayer, useMap } from "react-leaflet";
import type { LatLngBoundsExpression, LatLngExpression } from "leaflet";
import { GlobeAltIcon } from "@heroicons/react/24/outline";
import "leaflet/dist/leaflet.css";

const AREA_SQ_MILES = 25;
const MILES_TO_METERS = 1609.344;
const COVERAGE_RADIUS_METERS = Math.sqrt(AREA_SQ_MILES / Math.PI) * MILES_TO_METERS;

function BoundsController({ bounds }: { bounds: LatLngBoundsExpression }) {
  const map = useMap();
  useEffect(() => {
    map.fitBounds(bounds, { padding: [32, 32] });
  }, [bounds, map]);
  return null;
}

export function LocalConditionsMap({ lat, lon }: { lat: number; lon: number }) {
  const isInteractive =
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    typeof navigator !== "undefined" &&
    !navigator.userAgent?.toLowerCase().includes("jsdom");

  const center = useMemo<LatLngExpression>(() => ({ lat, lng: lon }), [lat, lon]);

  const bounds = useMemo<LatLngBoundsExpression>(() => {
    const spanMiles = Math.sqrt(AREA_SQ_MILES);
    const latSpan = spanMiles / 69; // ~69 miles per degree latitude
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const lonSpan = spanMiles / (Math.max(Math.abs(cosLat), 0.05) * 69);
    return [
      [lat - latSpan / 2, lon - lonSpan / 2],
      [lat + latSpan / 2, lon + lonSpan / 2],
    ];
  }, [lat, lon]);

  return (
    <div className="relative overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70">
      {isInteractive ? (
        <MapContainer
          center={center}
          zoom={12}
          scrollWheelZoom={false}
          className="h-80 w-full"
          attributionControl={false}
        >
          <BoundsController bounds={bounds} />
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          <Circle
            center={center}
            radius={COVERAGE_RADIUS_METERS}
            pathOptions={{ color: "#22d3ee", fillColor: "#22d3ee", fillOpacity: 0.15, weight: 1.5 }}
          />
        </MapContainer>
      ) : (
        <div className="flex h-80 w-full items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-center text-xs text-slate-300">
          Interactive map available in browser runtime.
        </div>
      )}
      <div className="pointer-events-none absolute left-4 top-4 flex items-center gap-2 rounded-full bg-slate-900/80 px-3 py-1 text-xs font-semibold text-slate-100 shadow-lg">
        <GlobeAltIcon className="h-4 w-4 text-cyan-300" aria-hidden="true" />
        <span>Approx. 25 mi^2 view</span>
      </div>
    </div>
  );
}
