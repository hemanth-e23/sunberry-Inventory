// Scanner audio + format helpers.
//
// Tones are generated with Web Audio API so we ship no audio assets.
//   Success: 1000Hz sine, 100ms — "grocery scanner" beep.
//   Error  : 600Hz → 300Hz square, 120ms each — descending two-tone "nope".
//
// Mute preference persists in localStorage under MUTE_KEY.

const MUTE_KEY = 'sunberry-scanner-muted';

const isBrowser = () => typeof window !== 'undefined';

let muted = (() => {
  if (!isBrowser()) return false;
  try {
    return window.localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
})();

const muteListeners = new Set();

export const isScannerMuted = () => muted;

export const setScannerMuted = (val) => {
  muted = !!val;
  if (isBrowser()) {
    try {
      window.localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    } catch {
      // localStorage disabled — keep value in memory only
    }
  }
  muteListeners.forEach((cb) => {
    try { cb(muted); } catch { /* listener errors are not actionable here */ }
  });
};

export const subscribeScannerMuted = (cb) => {
  muteListeners.add(cb);
  return () => muteListeners.delete(cb);
};

let audioCtx = null;
const getAudioContext = () => {
  if (!isBrowser()) return null;
  if (audioCtx) return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  audioCtx = new Ctx();
  return audioCtx;
};

// Browsers (especially iOS Safari) won't let an AudioContext produce sound
// until it's been touched inside a user gesture. Warm-up creates the context
// and resumes it if suspended, so the first real scan beep isn't silent.
export const warmUpAudio = () => {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => { /* ignore */ });
};

// Auto-warmup on the very first user interaction anywhere on the page.
// One-shot listener — removed after firing, no ongoing cost.
if (isBrowser()) {
  const onFirstGesture = () => {
    warmUpAudio();
    window.removeEventListener('pointerdown', onFirstGesture, true);
    window.removeEventListener('keydown', onFirstGesture, true);
    window.removeEventListener('touchstart', onFirstGesture, true);
  };
  window.addEventListener('pointerdown', onFirstGesture, true);
  window.addEventListener('keydown', onFirstGesture, true);
  window.addEventListener('touchstart', onFirstGesture, true);
}

const playTone = ({ frequency, durationMs, type = 'sine', volume = 0.25, startOffsetMs = 0 }) => {
  if (muted) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => { /* iOS requires user gesture; ignore */ });
  }
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = frequency;
  osc.connect(gain).connect(ctx.destination);

  const start = ctx.currentTime + startOffsetMs / 1000;
  const dur = durationMs / 1000;
  // Tiny envelope avoids click on start/stop
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(volume, start + 0.005);
  gain.gain.setValueAtTime(volume, start + dur - 0.01);
  gain.gain.linearRampToValueAtTime(0, start + dur);
  osc.start(start);
  osc.stop(start + dur + 0.02);
};

export const playSuccessTone = () => {
  playTone({ frequency: 1000, durationMs: 140, type: 'sine', volume: 0.7 });
};

export const playErrorTone = () => {
  playTone({ frequency: 600, durationMs: 160, type: 'square', volume: 0.55 });
  playTone({ frequency: 300, durationMs: 180, type: 'square', volume: 0.55, startOffsetMs: 170 });
};

// ---------------------------------------------------------------------------
// Licence format check — mirrors backend parse_licence_number().
// Format: {LOT}-{PRODUCT_CODE}-{NNN}  (lot may itself contain hyphens)
// ---------------------------------------------------------------------------
export const isValidLicenceFormat = (input) => {
  if (!input) return false;
  const parts = String(input).trim().split('-');
  if (parts.length < 3) return false;
  const seq = parts[parts.length - 1];
  if (!/^\d{3}$/.test(seq)) return false;
  const productCode = parts[parts.length - 2];
  if (!productCode) return false;
  const lot = parts.slice(0, -2).join('-');
  if (!lot) return false;
  return true;
};

// Strip stray characters that the operator typed before the barcode scanner
// fired. When the request's lot number is known, find it inside the scanned
// string and trim everything before it — anything before the lot is junk
// keystrokes from a focus-race. Without a known lot we can't disambiguate
// safely, so return the trimmed input and let server-side validation reject
// it if the format is bad.
export const cleanScannedLicence = (input, knownLotNumber) => {
  if (input == null) return '';
  const trimmed = String(input).trim();
  if (!knownLotNumber) return trimmed;
  const marker = `${knownLotNumber}-`;
  const idx = trimmed.indexOf(marker);
  if (idx > 0) return trimmed.slice(idx);
  return trimmed;
};

// Split a licence into a left "prefix" (lot + product) and a right "suffix"
// ("-NNN" pallet sequence), so the list row can keep the start of the lot
// AND the pallet number visible while letting the middle ellipsis when the
// column is narrow. Falls back to {prefix: whole string, suffix: ''} on
// anything that doesn't match the expected format — caller renders that as
// plain text with normal right-side ellipsis (i.e. old behavior).
export const splitLicenceForDisplay = (input) => {
  const value = input == null ? '' : String(input);
  if (!isValidLicenceFormat(value)) return { prefix: value, suffix: '' };
  const idx = value.lastIndexOf('-');
  return { prefix: value.slice(0, idx), suffix: value.slice(idx) };
};
