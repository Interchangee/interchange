export default function TripStatusBanner({ state }) {
  if (!state) return null;
  if (state.cancelled) {
    return <div className="banner banner-cancelled">⚠ Trip cancelled</div>;
  }
  const d = state.delay_seconds ?? 0;
  if (d >= 60)  return <div className="banner banner-late">Running {Math.round(d / 60)} min late</div>;
  if (d <= -60) return <div className="banner banner-early">Running {Math.round(-d / 60)} min early</div>;
  return <div className="banner banner-ontime">On time</div>;
}