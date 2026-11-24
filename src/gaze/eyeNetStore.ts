/**
 * Where the eye-picture network a reader loaded is kept: in this browser's storage, next to the
 * calibration made on it. The app ships without a network (the one this project trains is fitted
 * on recordings whose licence does not allow that, see docs/REAL_DATA.md), so there is one only
 * after the reader loaded a file in Settings.
 */
import { readJSON, removeKey, writeJSON } from '../core/storage';
import { resolveEyeNet } from './eyeNet';
import type { EyeNetShape } from './eyeNetRunner';

export const EYE_NET_KEY = 'eyeNet';
/** A network file larger than this is not read: the one this project trains is half a megabyte. */
export const EYE_NET_MAX_BYTES = 4 * 1024 * 1024;

export interface StoredEyeNet {
  /** The file's contents, as the worker is given them. */
  weights: unknown;
  shape: EyeNetShape;
}

/** What the file describes, or null when it is not a network this version can run. */
export function checkEyeNet(weights: unknown): StoredEyeNet | null {
  const net = resolveEyeNet(weights);
  return net ? { weights, shape: { id: net.id, width: net.width, height: net.height, span: net.span, extras: net.extras } } : null;
}

/** The network kept in this browser, or null. One that no longer reads (another version wrote it) counts as none. */
export function loadStoredEyeNet(): StoredEyeNet | null {
  const raw = readJSON<unknown>(EYE_NET_KEY, null);
  return raw === null ? null : checkEyeNet(raw);
}

export type StoreEyeNetResult = { ok: true; net: StoredEyeNet } | { ok: false; problem: string };

/** Reads a network file's text and keeps it. Nothing is kept unless it reads as a network. */
export function storeEyeNet(text: string): StoreEyeNetResult {
  if (text.length > EYE_NET_MAX_BYTES) return { ok: false, problem: 'That file is too large to be an eye-picture network.' };
  let weights: unknown;
  try {
    weights = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'That file is not an eye-picture network (it is not JSON).' };
  }
  const net = checkEyeNet(weights);
  if (!net) return { ok: false, problem: 'That file is not an eye-picture network this version can read.' };
  if (!writeJSON(EYE_NET_KEY, weights)) return { ok: false, problem: 'This browser has no room to keep the network (its storage is full or blocked).' };
  return { ok: true, net };
}

export function forgetStoredEyeNet(): void {
  removeKey(EYE_NET_KEY);
}
