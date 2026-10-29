import { CircleMarker, Tooltip } from 'react-leaflet';

export default function ServiceAlertLayer({ alerts, stopsById }) {
  if (!alerts?.length || !stopsById?.size) return null;
  return (
    <>
      {alerts.flatMap(alert =>
        (alert.stop_ids ?? [])
          .map(id => stopsById.get(id))
          .filter(Boolean)
          .map(s => (
            <CircleMarker
              key={`${alert.id}:${s.stop_id}`}
              center={s.center}
              radius={8}
              pathOptions={{ color: '#e11d48', fillColor: '#e11d48', fillOpacity: 0.35 }}
            >
              <Tooltip>{alert.header}</Tooltip>
            </CircleMarker>
          ))
      )}
    </>
  );
}