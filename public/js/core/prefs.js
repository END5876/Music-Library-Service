// core/prefs.js — 讀寫使用者偏好（音量／隨機／循環）
import { audio } from './dom.js';
import { REPEATS } from './constants.js';
import { S } from './state.js';

try {
  const s = JSON.parse(localStorage.getItem('ml_prefs') || '{}');
  if (typeof s.volume === 'number') audio.volume = Math.min(1, Math.max(0, s.volume));
  S.shuffle = !!s.shuffle;
  if (REPEATS.includes(s.repeat)) S.repeat = s.repeat;
} catch {}

export function savePrefs() {
  try { localStorage.setItem('ml_prefs', JSON.stringify({ volume: audio.volume, shuffle: S.shuffle, repeat: S.repeat })); } catch {}
}
