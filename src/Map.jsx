import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import { supabase } from './supabase';
import ServiceAlertLayer from './ServiceAlertLayer';

const meIcon   = L.divIcon({ className: 'me-dot',   iconSize: [14, 14] });
const peerIcon = L.divIcon({ className: 'peer-dot', iconSize: [10, 10] });

function wktToLatLng(wkt) {
  const m = /POINT\(([-\d.]+)\s+([-\d.]+)\)/i.exec(wkt ?? '');
  if (!m) return null;
  return [Number(m[2]), Number(m[1])];
}

export default function Map({ myPosition, mySessionId, locationChannel, alerts }) {
  const [peers, setPeers]         = useState({});
  const [stopsById, setStopsById] = useState(new Map());

  // Load stop coords for alert layer
  useEffect(() => {
    if (!alerts?.length) return;
    const ids = [...new Set(alerts.flatMap(a => a.stop_ids ?? []))];
    if (!ids.length) return;

    supabase
      .from('gtfs_stops')
      .select('stop_id, stop_name, stop_location')
      .in('stop_id', ids)
      .then(({ data }) => {
        const m = new Map();
        for (const s of data ?? []) {
          const center = wktToLatLng(s.stop_location);
          if (center) m.set(s.stop_id, { stop_id: s.stop_id, stop_name: s.stop_name, center });
        }
        setStopsById(m);
      });
  }, [alerts]);

  // Peer positions via broadcast
  useEffect(() => {
    if (!locationChannel) return;
    const handler = ({ payload }) => {
      if (payload.session_id === mySessionId) return;
      setPeers(p => ({ ...p, [payload.session_id]: payload }));
    };
    locationChannel.on('broadcast', { event: 'position' }, handler);
    return () => { locationChannel.off('broadcast', { event: 'position' }, handler); };
  }, [locationChannel, mySessionId]);

  return (
    <MapContainer center={[46.948, 7.4474]} zoom={12} style={{ height: '100%', width: '100%' }}>
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="&copy; OpenStreetMap contributors"
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