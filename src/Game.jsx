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
  const [channel, setChannel]       = useState(null);

  const [activeEvent, setActiveEvt] = useState(null);
  const [rtState, setRtState]       = useState(null);
  const [alerts, setAlerts]         = useState([]);
  const [score, setScore]           = useState(0);
  const [rank, setRank]             = useState(null);
  const [inferred, setInferred]     = useState(null);

  const lastPersist = useRef(0);

  // ── 1. Ensure player + session exist ──────────────────────────────────────
  useEffect(() => {
    if (!authUser) return;
    let cancelled = false;

    (async () => {
      const displayName =
        authUser.user_metadata?.full_name ||
        authUser.user_metadata?.name ||
        authUser.email?.split('@')[0] ||
        'Player';

      // best-effort — players table may not exist depending on schema
      try {
        await supabase.from('players').upsert(
          { id: authUser.id, display_name: displayName },
          { onConflict: 'id' }
        );
      } catch (_e) { /* ignore */ }

      const { data: existing } = await supabase
        .from('player_sessions')
        .select('id')
        .eq('player_id', authUser.id)
        .eq('game_id', game.id)
        .maybeSingle();

      if (cancelled) return;
      if (existing) { setSessionId(existing.id); return; }

      const { data: created, error } = await supabase
        .from('player_sessions')
        .insert({ player_id: authUser.id, game_id: game.id })
        .select('id')
        .single();

      if (!cancelled && !error) setSessionId(created.id);
      if (error) console.error('session create', error);
    })();

    return () => { cancelled = true; };
  }, [authUser, game.id]);

  // ── 2. GPS → Broadcast + 30s persist ──────────────────────────────────────
  useEffect(() => {
    if (!sessionId) return;

    const ch = supabase.channel(`game:${game.id}:locations`, {
      config: { broadcast: { self: false } },
    });
    ch.subscribe();
    setChannel(ch);

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
          await supabase
            .from('player_sessions')
            .update({
              last_known_location: `SRID=4326;POINT(${lng} ${lat})`,
              last_location_at: new Date().toISOString(),
            })
            .eq('id', sessionId);
        }
      },
      (err) => console.error('geo', err),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
      ch.unsubscribe();
      setChannel(null);
    };
  }, [sessionId, game.id]);

  // ── 3. Service alerts realtime ────────────────────────────────────────────
  useEffect(() => {
    supabase.from('service_alerts').select('*').then(({ data }) => setAlerts(data ?? []));

    const ch = supabase
      .channel('alerts')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'service_alerts' },
        ({ new: row }) =>
          setAlerts(prev => {
            const i = prev.findIndex(a => a.id === row.id);
            if (i === -1) return [...prev, row];
            const copy = prev.slice();
            copy[i] = row;
            return copy;
          })
      )
      .subscribe();

    return () => ch.unsubscribe();
  }, []);

  // ── 4. Score + rank (via leaderboard view) ────────────────────────────────
  useEffect(() => {
    if (!sessionId) return;

    const load = async () => {
      const { data: board } = await supabase
        .from('leaderboard')
        .select('player_session_id, score')
        .eq('game_id', game.id)
        .order('score', { ascending: false });
      const list = board ?? [];
      const idx = list.findIndex(b => b.player_session_id === sessionId);
      setScore(list[idx]?.score ?? 0);
      setRank(idx >= 0 ? idx + 1 : null);
    };
    load();

    const ch = supabase
      .channel(`lb:${game.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'score_ledger', filter: `game_id=eq.${game.id}` },
        load
      )
      .subscribe();

    return () => ch.unsubscribe();
  }, [sessionId, game.id]);

  // ── 5. Active trip event realtime ─────────────────────────────────────────
  useEffect(() => {
    if (!sessionId) return;

    const load = async () => {
      const { data } = await supabase
        .from('trip_events')
        .select('*')
        .eq('player_session_id', sessionId)
        .is('alight_at', null)
        .order('board_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      setActiveEvt(data ?? null);
    };
    load();

    const ch = supabase
      .channel(`evt:${sessionId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'trip_events', filter: `player_session_id=eq.${sessionId}` },
        () => load()
      )
      .subscribe();

    return () => ch.unsubscribe();
  }, [sessionId]);

  // ── 6. Live RT state of the active trip ───────────────────────────────────
  useEffect(() => {
    if (!activeEvent?.trip_id) { setRtState(null); return; }

    supabase
      .from('trip_realtime_state')
      .select('*')
      .eq('trip_id', activeEvent.trip_id)
      .maybeSingle()
      .then(({ data }) => setRtState(data));

    const ch = supabase
      .channel(`rt:${activeEvent.trip_id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'trip_realtime_state',
          filter: `trip_id=eq.${activeEvent.trip_id}`,
        },
        ({ new: row }) => setRtState(row)
      )
      .subscribe();

    return () => ch.unsubscribe();
  }, [activeEvent?.trip_id]);

  // ── 7. Cancellation → resolve inferred alight stop ────────────────────────
  useEffect(() => {
    if (!activeEvent?.cancellation_detected || !activeEvent.inferred_alight_stop_id) {
      setInferred(null);
      return;
    }
    supabase
      .from('gtfs_stops')
      .select('stop_id, stop_name')
      .eq('stop_id', activeEvent.inferred_alight_stop_id)
      .maybeSingle()
      .then(({ data }) => setInferred(data ?? null));
  }, [activeEvent?.cancellation_detected, activeEvent?.inferred_alight_stop_id]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const declareBoarding = async ({ tripId, stopId }) => {
    if (!sessionId) return;
    const { data, error } = await supabase
      .from('trip_events')
      .insert({
        player_session_id: sessionId,
        trip_id: tripId,
        board_stop_id: stopId,
        board_at: new Date().toISOString(),
      })
      .select('*')
      .single();
    if (error) { console.error(error); return; }
    setActiveEvt(data);
  };

  const declareAlight = async (stopId) => {
    if (!activeEvent || !stopId) return;
    const { error } = await supabase
      .from('trip_events')
      .update({
        declared_alight_stop_id: stopId,
        alight_at: new Date().toISOString(),
        confirmed_by_player: true,
      })
      .eq('id', activeEvent.id);

    if (error) { console.error(error); return; }

    await supabase.functions.invoke('award-score', {
      body: { trip_event_id: activeEvent.id },
    });

    setActiveEvt(null);
    setInferred(null);
  };

  const confirmInferred = () => declareAlight(inferred?.stop_id);

  const correctInferred = () => {
    const stopId = window.prompt('Enter the stop_id you actually alighted at:');
    if (stopId) declareAlight(stopId);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="game-shell">
      <header className="topbar">
        <span className="topbar-game">{game.name}</span>
        <span className="topbar-timer">
          {game.starts_at?.slice(11, 16)} – {game.ends_at?.slice(11, 16)}
        </span>
        <span className="topbar-score">{score} pts</span>
        <span className="topbar-rank">#{rank ?? '–'}</span>
        <button className="topbar-exit" onClick={onExit}>Exit</button>
      </header>

      <div className="game-body">
        <div className="map-wrap">
          <Map
            myPosition={myPos}
            mySessionId={sessionId}
            locationChannel={channel}
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
              <button
                onClick={() => {
                  const tripId = window.prompt('Trip ID:');
                  const stopId = window.prompt('Boarding stop ID:');
                  if (tripId && stopId) declareBoarding({ tripId, stopId });
                }}
              >
                Declare boarding
              </button>
            ) : (
              <button
                onClick={() => {
                  const stopId = window.prompt('Alighting stop ID:');
                  if (stopId) declareAlight(stopId);
                }}
              >
                Declare alight
              </button>
            )}
          </div>
        </aside>
      </div>

      {inferred && (
        <AlightPrompt
          inferredStop={inferred}
          onConfirm={confirmInferred}
          onCorrect={correctInferred}
        />
      )}
    </div>
  );
}