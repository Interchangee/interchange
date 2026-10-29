import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import ServiceAlertLayer from './ServiceAlertLayer';

const meIcon  = L.divIcon({ className: 'me-dot',      iconSize: [14, 14] });
const peerIcon = L.divIcon({ className: 'peer-dot',   iconSize: [10, 10] });

export default function Map({ myPosition, mySessionId, locationChannel, alerts }) {
  const [peers, setPeers] = useState({});
  const [stopsById, setStopsById] = useState(new Map());

  // Load stop coords for alert overlay
  useEffect(() => {
    if (!alerts?.length) return;
    const ids = [...new Set(alerts.flatMap(a => a.stop_ids ?? []))];
    if (!ids.length) return;
    supabase_stops(ids);
  }, [alerts]);

  async function supabase_stops(ids) {
    const { supabase } = await import('./supabase');
    const { data } = await supabase.from('gtfs_stops')
      .select('stop_id, stop_name, stop_location').in('stop_id', ids);
    const m = new Map();
    for (const s of data ?? []) {
      const match = /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(s.stop_location);
      if (!match) continue;
      const [lng, lat] = [Number(match[1]), Number(match[2])];
      m.set(s.stop_id, { stop_id: s.stop_id, stop_name: s.stop_name, center: [lat, lng] });
    }
    setStopsById(m);
  }

  // Listen for peer positions on broadcast channel
  useEffect(() => {
    if (!locationChannel) return;
    const handler = ({ payload }) => {
      if (payload.session_id === mySessionId) return;
      setPeers(p => ({ ...p, [payload.session_id]: payload }));
    };
    locationChannel.on('broadcast', { event: 'position' }, handler);
    return () => locationChannel.off('broadcast', { event: 'position' }, handler);
  }, [locationChannel, mySessionId]);

  return (
    <MapContainer center={[46.948, 7.4474]} zoom={12} style={{ height: '100%', width: '100%' }}>
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; OpenStreetMap'
      />
      <ServiceAlertLayer alerts={alerts} stopsById={stopsById} />
      {Object.values(peers).map(p => (
        <Marker key={p.session_id} position={[p.lat, p.lng]} icon={peerIcon}>
          <Tooltip>Player</Tooltip>
        </Marker>
      ))}
      {myPosition && (
        <Marker position={myPosition} icon={meIcon}>
          <Tooltip>You</Tooltip>
        </Marker>
      )}
    </MapContainer>
  );
}