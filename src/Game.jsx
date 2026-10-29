import { useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import Map from './Map';
import TripStatusBanner from './TripStatusBanner';
import AlightPrompt from './AlightPrompt';
import ScheduleComparison from './ScheduleComparison';
import Scoreboard from './Scoreboard';

export default function Game({ game, authUser, onExit }) {
  const [sessionId, setSessionId]   = useState(null);
  const [myPos, setMyPos]           = useState(null);
  const [activeEvent, setActiveEvt] = useState(null);   // trip_events row
  const [rtState, setRtState]       = useState(null);
  const [alerts, setAlerts]         = useState([]);
  const [score, setScore]           = useState(0);
  const [rank, setRank]             = useState(null);
  const [inferred, setInferred]     = useState(null);

  const channelRef = useRef(null);
  const lastPersist = useRef(0);

  // ── ensure player profile + session exist ────────────────────────────────
  useEffect(() => {
    (async () => {
      const name = authUser.user_metadata?.full_name ?? authUser.email?.split('@')[0] ?? 'Player';
      await supabase.from('players').upsert(
        { id: authUser.id, display_name: name },
        { onConflict: 'id' }
      );

      const { data: existing } = await supabase
        .from('player_sessions')
        .select('id')
        .eq('player_id', authUser.id)
        .eq('game_id', game.id)
        .maybeSingle();

      if (existing) { setSessionId(existing.id); return; }

      const { data: created, error } = await supabase
        .from('player_sessions')
        .insert({ player_id: authUser.id, game_id: game.id })
        .select('id').single();
      if (error) { console.error(error); return; }
      setSessionId(created.id);
    })();
  }, [authUser.id, game.id]);

  // ── location: watchPosition → Broadcast (no DB writes) + 30s persist ─────
  useEffect(() => {
    if (!sessionId) return;

    const ch = supabase.channel(`game:${game.id}:locations`, {
      config: { broadcast: { self: false } },
    });
    ch.subscribe();
    channelRef.current = ch;

    const watchId = navigator.geolocation.watchPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        setMyPos([lat, lng]);

        ch.send({
          type: 'broadcast',
          event: 'position',
          payload: { session_id: sessionId, lat, lng, accuracy, ts: Date.now() },
        });

        if (Date.now() - lastPersist.current > 30_000) {
          lastPersist.current = Date.now();
          await supabase.from('player_sessions').update({
            last_known_location: `SRID=4326;POINT(${lng} ${lat})`,
            last_location_at: new Date().toISOString(),
          }).eq('id', sessionId);
        }
      },
      (err) => console.error('geo', err),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
      ch.unsubscribe();
    };
  }, [sessionId, game.id]);

  // ── live alerts ──────────────────────────────────────────────────────────
  useEffect(() => {
    supabase.from('service_alerts').select('*').then(({ data }) => setAlerts(data ?? []));
    const ch = supabase.channel('alerts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'service_alerts' },
        ({ new: row }) => setAlerts(prev => {
          const i = prev.findIndex(a => a.id === row.id);
          if (i === -1) return [...prev, row];
          const c = prev.slice(); c[i] = row; return c;
        }))
      .subscribe();
    return () => ch.unsubscribe();
  }, []);

  // ── score + rank ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionId) return;
    const load = async () => {
      const { data: board } = await supabase.from('leaderboard')
        .select('player_session_id, score')
        .eq('game_id', game.id)
        .order('score', { ascending: false });
      const idx = (board ?? []).findIndex(b => b.player_session_id === sessionId);
      setScore(board?.[idx]?.score ?? 0);
      setRank(idx >= 0 ? idx + 1 : null);
    };
    load();
    const ch = supabase.channel(`lb:${game.id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'score_ledger', filter: `game_id=eq.${game.id}` },
        load)
      .subscribe();
    return () => ch.unsubscribe();
  }, [sessionId, game.id]);

  // ── active trip realtime + event stream ──────────────────────────────────
  useEffect(() => {
    if (!sessionId) return;
    const ch = supabase.channel(`evt:${sessionId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'trip_events', filter: `player_session_id=eq.${sessionId}` },
        ({ new: row }) => { if (!row.alight_at) setActiveEvt(row); })
      .subscribe();
    return () => ch.unsubscribe();
  }, [sessionId]);

  useEffect(() => {
    if (!activeEvent?.trip_id) { setRtState(null); return; }
    supabase.from('trip_realtime_state').select('*')
      .eq('trip_id', activeEvent.trip_id).maybeSingle()
      .then(({ data }) => setRtState(data));

    const ch = supabase.channel(`rt:${activeEvent.trip_id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'trip_realtime_state', filter: `trip_id=eq.${activeEvent.trip_id}` },
        ({ new: row }) => setRtState(row))
      .subscribe();
    return () => ch.unsubscribe();
  }, [activeEvent?.trip_id]);

  // ── cancellation → fetch inferred alight ─────────────────────────────────
  useEffect(() => {
    if (!activeEvent?.cancellation_detected || activeEvent.inferred_alight_stop_id == null) return;
    (async () => {
      const { data } = await supabase.from('gtfs_stops')
        .select('stop_id, stop_name').eq('stop_id', activeEvent.inferred_alight_stop_id).single();
      setInferred(data);
    })();
  }, [activeEvent?.cancellation_detected, activeEvent?.inferred_alight_stop_id]);

  // ── handlers ─────────────────────────────────────────────────────────────
  const declareBoarding = async ({ tripId, stopId }) => {
    if (!sessionId) return;
    const { data, error } = await supabase.from('trip_events').insert({
      player_session_id: sessionId,
      trip_id: tripId,
      board_stop_id: stopId,
      board_at: new Date().toISOString(),
    }).select('*').single();
    if (error) { console.error(error); return; }
    setActiveEvt(data);
  };

  const declareAlight = async (stopId) => {
    if (!activeEvent) return;
    await supabase.from('trip_events').update({
      declared_alight_stop_id: stopId,
      alight_at: new Date().toISOString(),
      confirmed_by_player: true,
    }).eq('id', activeEvent.id);

    await supabase.functions.invoke('award-score', { body: { trip_event_id: activeEvent.id } });
    setActiveEvt(null);
    setInferred(null);
  };

  const confirmInferredAlight = () => declareAlight(inferred?.stop_id);
  const correctAlight = () => {
    const stopId = prompt('Enter the stop_id you actually alighted at:');
    if (stopId) declareAlight(stopId);
  };

  return (
    <div className="game-shell">
      <header className="topbar">
        <span className="topbar-game">{game.name}</span>
        <span className="topbar-timer">{game.starts_at?.slice(11, 16)} – {game.ends_at?.slice(11, 16)}</span>
        <span className="topbar-score">{score} pts</span>
        <span className="topbar-rank">#{rank ?? '–'}</span>
        <button className="topbar-exit" onClick={onExit}>Exit</button>
      </header>

      <div className="game-body">
        <div className="map-wrap">
          <Map
            myPosition={myPos}
            mySessionId={sessionId}
            locationChannel={channelRef.current}
            alerts={alerts}
          />
        </div>

        <aside className="side-panel">
          <TripStatusBanner state={rtState} />
          <ScheduleComparison
            scheduled={activeEvent?.board_at}
            actual={rtState?.observed_at}
            delaySeconds={rtState?.delay_seconds ?? 0}
          />
          <Scoreboard gameId={game.id} mySessionId={sessionId} />
          <div className="side-actions">
            {!activeEvent ? (
              <button onClick={() => {
                const tripId = prompt('Trip ID:');
                const stopId = prompt('Boarding stop ID:');
                if (tripId && stopId) declareBoarding({ tripId, stopId });
              }}>
                Declare boarding
              </button>
            ) : (
              <button onClick={() => {
                const stopId = prompt('Alighting stop ID:');
                if (stopId) declareAlight(stopId);
              }}>
                Declare alight
              </button>
            )}
          </div>
        </aside>
      </div>

      {inferred && (
        <AlightPrompt
          inferredStop={inferred}
          onConfirm={confirmInferredAlight}
          onCorrect={correctAlight}
        />
      )}
    </div>
  );
}