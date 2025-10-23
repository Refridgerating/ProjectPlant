import { useCallback, useState } from "react";

type Coordinates = {
  lat: number;
  lon: number;
  accuracy: number | null;
};

type GeolocationStatus = "idle" | "pending" | "granted" | "denied" | "unsupported" | "error";

type GeolocationState = {
  status: GeolocationStatus;
  coords: Coordinates | null;
  error: string | null;
};

export function useGeolocation() {
  const [state, setState] = useState<GeolocationState>({
    status: typeof navigator !== "undefined" && "geolocation" in navigator ? "idle" : "unsupported",
    coords: null,
    error: null,
  });

  const requestPermission = useCallback(() => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setState({ status: "unsupported", coords: null, error: "Geolocation is not supported in this environment." });
      return;
    }

    setState((prev) => ({ ...prev, status: "pending", error: null }));

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        const parsedAccuracy =
          typeof accuracy === "number" && Number.isFinite(accuracy) ? accuracy : null;
        setState({
          status: "granted",
          coords: { lat: latitude, lon: longitude, accuracy: parsedAccuracy },
          error: null,
        });
      },
      (err) => {
        const message = err.message || "Unable to retrieve location.";
        const status = err.code === err.PERMISSION_DENIED ? "denied" : "error";
        setState({ status, coords: null, error: message });
      },
      {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 5 * 60 * 1000,
      }
    );
  }, []);

  return {
    status: state.status,
    coords: state.coords,
    error: state.error,
    requestPermission,
  };
}
