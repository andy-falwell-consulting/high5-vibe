import { useEffect, useState } from 'react';
import { subscribeOutbox, drainOutbox, retryFailed } from '../api/outbox';
import './SyncStatus.css';

// Whether the day's work has actually gone in.
//
// A CREW MUST NEVER HAVE TO WONDER. Everything else in the offline work is
// invisible when it succeeds, which is right — but that leaves the one question
// an inspector genuinely needs answered at the end of a day, standing in a car
// park deciding whether it is safe to close the lid, with nothing on screen to
// answer it. So: four states, permanently visible, and nothing else.
//
//   Offline — N changes held      there is no network; the work is on the device
//   Syncing — N of M              it is going in now
//   Synced HH:MM                  everything has gone in, and when
//   N could not sync              the server refused; here is a way to try again
//
// A failed entry is never dropped and never hidden. "Could not sync" stays on
// screen until it either succeeds or someone deliberately discards it.

const clock = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export default function SyncStatus() {
  const [s, setS] = useState({ pending: 0, failed: 0, syncing: false, sent: 0, total: 0, lastSyncAt: null });
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => subscribeOutbox(setS), []);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const held = s.pending - s.failed;

  if (s.syncing) {
    return (
      <div className="sync-status is-working">
        <span className="sync-dot" />
        Syncing {s.sent} of {s.total}
      </div>
    );
  }

  if (s.failed > 0) {
    return (
      <div className="sync-status is-failed">
        <span className="sync-dot" />
        {s.failed} could not sync
        <button className="sync-action" onClick={() => retryFailed()}>Try again</button>
      </div>
    );
  }

  if (!online) {
    return (
      <div className="sync-status is-offline">
        <span className="sync-dot" />
        {held > 0
          ? `Offline — ${held} change${held === 1 ? '' : 's'} held`
          : 'Offline — nothing waiting to send'}
      </div>
    );
  }

  if (held > 0) {
    return (
      <div className="sync-status is-held">
        <span className="sync-dot" />
        {held} waiting to send
        <button className="sync-action" onClick={() => drainOutbox()}>Sync now</button>
      </div>
    );
  }

  // Nothing queued. Say so only if something has actually been sent — a bare
  // "Synced" on a machine that has never queued anything is noise.
  if (s.lastSyncAt) {
    return (
      <div className="sync-status is-synced">
        <span className="sync-dot" />
        Synced {clock(s.lastSyncAt)}
      </div>
    );
  }
  return null;
}
