// Friendly wording for SDK validation and error codes.
// Numeric values mirror ValidationCode / SmartSpectraErrorCode in the SDK's
// index.d.ts so this module stays dependency-free and testable.

const VALIDATION = {
  0: { ok: true, text: 'Looking good. Hold still and breathe naturally.' },
  1: { ok: false, text: "I can't see your face. Move into the frame." },
  2: { ok: false, text: 'More than one face is in view. Only one person should be visible.' },
  3: { ok: false, text: 'Center your face in the frame.' },
  4: { ok: false, text: 'Adjust your distance from the camera.' },
  5: { ok: false, text: "It's too dark. Face a window or turn on a light." },
  6: { ok: false, text: "It's too bright. Reduce glare or backlighting." },
  7: { ok: false, text: 'Your upper chest and shoulders need to be in view.' },
  10: { ok: false, text: 'Camera is adjusting. One moment…' },
  11: { ok: false, text: 'The camera frame rate is too low. Close other apps using the camera.' },
  12: { ok: false, text: 'Too much movement. Sit still for a moment.' },
  13: { ok: false, text: "You're too close. Sit back a little." },
  14: { ok: false, text: "You're too far away. Move closer." },
  15: { ok: false, text: 'Your face is too high in the frame.' },
  16: { ok: false, text: 'Your face is too low in the frame.' },
  17: { ok: false, text: 'Face the camera directly.' },
};

export function validationInfo(code, sdkHint) {
  const known = VALIDATION[code];
  if (known) return known;
  return { ok: false, text: sdkHint ? String(sdkHint) : 'Getting ready…' };
}

const ERRORS = {
  2: 'The API key was rejected. Check SMARTSPECTRA_API_KEY in your .env file.',
  4: 'The free trial credits for this key are used up. Ask on the Presage Discord.',
  5: "Couldn't reach the SmartSpectra service. Check your internet connection.",
  6: 'The SmartSpectra service reported a problem. Try again in a moment.',
  7: 'No camera is available. Connect one and try again.',
  8: 'Processing failed to start. Try again.',
};

export function errorInfo(code, message) {
  const text = ERRORS[code] || (message ? String(message) : 'Something went wrong.');
  // Auth and credit problems won't fix themselves, so don't offer a retry loop.
  const retryable = code !== 2 && code !== 4;
  return { text, retryable };
}

/** Camera permission / hardware failures from getUserMedia, surfaced by start(). */
export function startFailureInfo(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return { text: 'Camera access was blocked. Allow it in your system privacy settings, then try again.', retryable: true };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return { text: 'No camera was found. Connect one and try again.', retryable: true };
  }
  if (name === 'NotReadableError') {
    return { text: 'The camera is busy in another app. Close it and try again.', retryable: true };
  }
  if (err && typeof err.code === 'number') return errorInfo(err.code, err.message);
  return { text: (err && err.message) || 'Could not start the camera.', retryable: true };
}
