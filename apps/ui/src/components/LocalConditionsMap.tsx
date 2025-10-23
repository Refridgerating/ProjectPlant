import { useEffect, useMemo } from "react";
import {
  Circle,
  CircleMarker,
  LayerGroup,
  LayersControl,
  MapContainer,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";
import type { LatLngBoundsExpression, LatLngExpression } from "leaflet";
import { GlobeAltIcon } from "@heroicons/react/24/outline";
import "leaflet/dist/leaflet.css";
import { CollapsibleTile } from "./CollapsibleTile";
import type { WeatherStation } from "../api/hubClient";

const AREA_SQ_MILES = 25;
const MILES_TO_METERS = 1609.344;
const COVERAGE_RADIUS_METERS = Math.sqrt(AREA_SQ_MILES / Math.PI) * MILES_TO_METERS;
const DEFAULT_ACCURACY_RADIUS_METERS = 800;
const MIN_ACCURACY_RADIUS_METERS = 20;
const METERS_PER_DEGREE_LAT = 111_132;
const DEFAULT_ZOOM = 13;
const MIN_ZOOM = 3;
const MAX_ZOOM = 18;

function metersToLatDelta(meters: number): number {
  return meters / METERS_PER_DEGREE_LAT;
}

function metersToLonDelta(meters: number, latitude: number): number {
  const metersPerDegreeLon = Math.max(Math.cos((latitude * Math.PI) / 180), 0.0001) * 111_320;
  return meters / metersPerDegreeLon;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radius = 6371_000; // meters
  const lat1Rad = (lat1 * Math.PI) / 180;
  const lat2Rad = (lat2 * Math.PI) / 180;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return radius * c;
}

function MapAnimator({ center }: { center: LatLngExpression }) {
  const map = useMap();
  useEffect(() => {
    const mapCenter = map.getCenter();
    const target =
      Array.isArray(center) && center.length >= 2
        ? { lat: Number(center[0]), lng: Number(center[1]) }
        : (center as { lat: number; lng: number });
    if (!target || Number.isNaN(target.lat) || Number.isNaN(target.lng)) {
      return;
    }
    if (mapCenter.lat === target.lat && mapCenter.lng === target.lng) {
      return;
    }
    map.flyTo(target, map.getZoom(), { duration: 0.6, easeLinearity: 0.25 });
  }, [center, map]);
  return null;
}

function BoundsController({ bounds }: { bounds: LatLngBoundsExpression }) {
  const map = useMap();
  useEffect(() => {
    map.fitBounds(bounds, { padding: [32, 32] });
  }, [bounds, map]);
  return null;
}

export function LocalConditionsMap({
  lat,
  lon,
  accuracy,
  station,
}: {
  lat: number;
  lon: number;
  accuracy?: number | null;
  station?: WeatherStation | null;
}) {
  const isInteractive =
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    typeof navigator !== "undefined" &&
    !navigator.userAgent?.toLowerCase().includes("jsdom");

  const accuracyRadiusMeters = useMemo(() => {
    if (typeof accuracy === "number" && accuracy > 0) {
      return Math.max(accuracy, MIN_ACCURACY_RADIUS_METERS);
    }
    return DEFAULT_ACCURACY_RADIUS_METERS;
  }, [accuracy]);

  const center = useMemo<LatLngExpression>(() => ({ lat, lng: lon }), [lat, lon]);

  const stationLat = typeof station?.lat === "number" ? station.lat : null;
  const stationLon = typeof station?.lon === "number" ? station.lon : null;
  const stationIdentifier = station?.identifier ?? null;
  const stationName = station?.name ?? null;
  const stationDistanceKm = typeof station?.distanceKm === "number" ? station.distanceKm : null;

  const stationPosition = useMemo<LatLngExpression | null>(() => {
    if (stationLat === null || stationLon === null) {
      return null;
    }
    return { lat: stationLat, lng: stationLon };
  }, [stationLat, stationLon]);

  const stationDistanceMeters = useMemo(() => {
    if (stationDistanceKm !== null) {
      return stationDistanceKm * 1000;
    }
    if (stationLat !== null && stationLon !== null) {
      return haversineMeters(lat, lon, stationLat, stationLon);
    }
    return 0;
  }, [lat, lon, stationDistanceKm, stationLat, stationLon]);

  const bounds = useMemo<LatLngBoundsExpression>(() => {
    const accuracyLatDelta = metersToLatDelta(accuracyRadiusMeters);
    const accuracyLonDelta = metersToLonDelta(accuracyRadiusMeters, lat);
    const coverageLatDelta = metersToLatDelta(COVERAGE_RADIUS_METERS);
    const coverageLonDelta = metersToLonDelta(COVERAGE_RADIUS_METERS, lat);

    const points: Array<{ lat: number; lng: number }> = [
      { lat, lng: lon },
      { lat: lat - accuracyLatDelta, lng: lon - accuracyLonDelta },
      { lat: lat + accuracyLatDelta, lng: lon + accuracyLonDelta },
      { lat: lat - coverageLatDelta, lng: lon - coverageLonDelta },
      { lat: lat + coverageLatDelta, lng: lon + coverageLonDelta },
    ];
    if (stationLat !== null && stationLon !== null) {
      points.push({ lat: stationLat, lng: stationLon });
    }

    const lats = points.map((p) => p.lat);
    const lons = points.map((p) => p.lng);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);

    const latRange = maxLat - minLat || metersToLatDelta(accuracyRadiusMeters);
    const lonRange = maxLon - minLon || metersToLonDelta(accuracyRadiusMeters, lat);
    const latPadding = latRange * 0.15;
    const lonPadding = lonRange * 0.15;

    return [
      [minLat - latPadding, minLon - lonPadding],
      [maxLat + latPadding, maxLon + lonPadding],
    ];
  }, [lat, lon, accuracyRadiusMeters, stationLat, stationLon]);

  const accuracyDisplay = `±${Math.round(accuracyRadiusMeters)} m`;
  const stationLabel = stationName
    ? stationIdentifier
      ? `${stationName} (${stationIdentifier})`
      : stationName
    : stationIdentifier ?? null;
  const stationDistanceDisplay =
    stationDistanceMeters > 0 ? `~${(stationDistanceMeters / 1000).toFixed(1)} km away` : null;

  return (
    <CollapsibleTile
      id="local-conditions-map"
      title="Local Conditions Map"
      subtitle="Approximate coverage around your detected position."
      className="p-4 text-sm text-emerald-100/85"
      bodyClassName="mt-3"
    >
      <div className="relative overflow-hidden rounded-2xl border border-emerald-800/40 bg-[rgba(6,24,16,0.78)] shadow-[0_25px_60px_rgba(4,18,12,0.5)]">
        {isInteractive ? (
          <div className="relative w-full">
            <div className="aspect-square w-full">
              <MapContainer
                center={center}
                zoom={DEFAULT_ZOOM}
                minZoom={MIN_ZOOM}
                maxZoom={MAX_ZOOM}
                scrollWheelZoom
                doubleClickZoom
                zoomSnap={0.25}
                zoomDelta={0.5}
                wheelDebounceTime={16}
                wheelPxPerZoomLevel={160}
                className="absolute inset-0 h-full w-full"
                attributionControl={false}
                preferCanvas={false}
                zoomControl
              >
                <BoundsController bounds={bounds} />
                <MapAnimator center={center} />
                <LayersControl position="topright" collapsed={false}>
                  <LayersControl.BaseLayer checked name="Satellite Hybrid">
                    <LayerGroup>
                      <TileLayer
                        url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                        attribution='&copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, Maxar, Earthstar Geographics, and the GIS User Community'
                        minZoom={MIN_ZOOM}
                        maxZoom={MAX_ZOOM}
                      />
                      <TileLayer
                        url="https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
                        attribution='&copy; <a href="https://www.esri.com/">Esri</a>'
                        opacity={0.8}
                        minZoom={MIN_ZOOM}
                        maxZoom={MAX_ZOOM}
                      />
                    </LayerGroup>
                  </LayersControl.BaseLayer>
                  <LayersControl.BaseLayer name="Terrain">
                    <TileLayer
                      url="https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png"
                      attribution='Map data: &copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a>'
                      minZoom={MIN_ZOOM}
                      maxZoom={17}
                    />
                  </LayersControl.BaseLayer>
                  <LayersControl.BaseLayer name="Street Map">
                    <TileLayer
                      url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                      attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                      minZoom={MIN_ZOOM}
                      maxZoom={19}
                    />
                  </LayersControl.BaseLayer>
                </LayersControl>
                <Circle
                  center={center}
                  radius={COVERAGE_RADIUS_METERS}
                  pathOptions={{
                    color: "#38bdf8",
                    fillColor: "#38bdf8",
                    fillOpacity: 0.06,
                    weight: 1,
                    dashArray: "6 6",
                  }}
                />
                <Circle
                  center={center}
                  radius={accuracyRadiusMeters}
                  pathOptions={{ color: "#0ea5e9", fillColor: "#0ea5e9", fillOpacity: 0.2, weight: 1.5 }}
                />
                <CircleMarker
                  center={center}
                  radius={6}
                  pathOptions={{ color: "#075985", fillColor: "#38bdf8", fillOpacity: 0.95, weight: 2 }}
                >
                  <Tooltip direction="top" offset={[0, -6]}>
                    {`Your location (${accuracyDisplay})`}
                  </Tooltip>
                </CircleMarker>
                {stationPosition ? (
                  <CircleMarker
                    center={stationPosition}
                    radius={7}
                    pathOptions={{ color: "#f97316", fillColor: "#fb923c", fillOpacity: 0.95, weight: 2 }}
                  >
                    <Tooltip direction="top" offset={[0, -6]}>
                      {`Reporting station${stationLabel ? `: ${stationLabel}` : ""}${
                        stationDistanceDisplay ? ` • ${stationDistanceDisplay}` : ""
                      }`}
                    </Tooltip>
                  </CircleMarker>
                ) : null}
              </MapContainer>
            </div>
          </div>
        ) : (
          <div className="flex h-80 w-full items-center justify-center bg-gradient-to-br from-[#03150d] via-[#0b2f1e] to-[#164f30] text-center text-xs text-emerald-100/70">
            Interactive map available in browser runtime.
          </div>
        )}
        <div className="pointer-events-none absolute left-4 top-4 flex items-center gap-3 rounded-xl border border-emerald-700/40 bg-[rgba(4,18,12,0.85)] px-3 py-2 text-xs font-semibold text-emerald-100 shadow-lg shadow-emerald-950/40">
          <GlobeAltIcon className="h-4 w-4 text-emerald-300" aria-hidden="true" />
          <div className="flex flex-col text-left">
            <span>Accuracy {accuracyDisplay}</span>
            {stationLabel ? (
              <span className="text-[11px] font-medium text-emerald-200/70">
                Station: {stationLabel}
                {stationDistanceDisplay ? ` • ${stationDistanceDisplay}` : ""}
              </span>
            ) : null}
            <span className="text-[11px] font-medium text-emerald-200/70">Coverage ring ≈ 25 mi²</span>
          </div>
        </div>
      </div>
    </CollapsibleTile>
  );
}
