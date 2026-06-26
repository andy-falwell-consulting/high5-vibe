// Tiny Web Audio chime for reminder toasts. Synthesizes a short, pleasant tone
// (no asset to bundle). Respects a localStorage mute preference and only plays
// once the AudioContext is unlocked by a user gesture (browser autoplay policy).
const SOUND_PREF = 'h5_reminder_sound' // '0' = muted, anything else = on

let ctx = null
function audio() {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return null
    ctx = new AC()
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  return ctx
}

// Unlock the context on the first user gesture so a later programmatic play is
// allowed even when it fires without an immediately-preceding interaction.
if (typeof window !== 'undefined') {
  const unlock = () => { audio(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock) }
  window.addEventListener('pointerdown', unlock)
  window.addEventListener('keydown', unlock)
}

export function isReminderSoundOn() {
  try { return localStorage.getItem(SOUND_PREF) !== '0' } catch { return true }
}
export function setReminderSoundOn(on) {
  try { localStorage.setItem(SOUND_PREF, on ? '1' : '0') } catch { /* ignore */ }
}

function tone(ac, freq, startAt, dur, peak = 0.18) {
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0, startAt)
  gain.gain.linearRampToValueAtTime(peak, startAt + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + dur)
  osc.connect(gain).connect(ac.destination)
  osc.start(startAt)
  osc.stop(startAt + dur + 0.02)
}

// Play a chime. 'now' = two ascending notes (more attention-getting); 'lead' =
// a single soft note for the heads-up. No-op when muted or context unavailable.
export function playReminderChime(kind = 'now') {
  if (!isReminderSoundOn()) return
  const ac = audio()
  if (!ac) return
  const t = ac.currentTime
  if (kind === 'now') {
    tone(ac, 660, t, 0.18)
    tone(ac, 880, t + 0.16, 0.22)
  } else {
    tone(ac, 740, t, 0.2, 0.12)
  }
}
