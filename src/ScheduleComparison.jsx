export default function ScheduleComparison({ scheduled, actual, delaySeconds }) {
  if (!scheduled) return null;
  const mins = Math.round((delaySeconds ?? 0) / 60);
  return (
    <div className="schedule-comparison">
      <span>Scheduled: {new Date(scheduled).toLocaleTimeString()}</span>
      <span>Actual: {actual ? new Date(actual).toLocaleTimeString() : '—'}</span>
      <span className={mins >= 0 ? 'delay-late' : 'delay-early'}>
        {mins >= 0 ? `+${mins} min` : `${mins} min`}
      </span>
    </div>
  );
}