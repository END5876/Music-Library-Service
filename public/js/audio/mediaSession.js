// audio/mediaSession.js — 手機鎖定畫面的媒體控制
import { audio } from '../core/dom.js';
import { setSession, tryPlay } from './helpers.js';
import { advance, prev } from '../playback/controller.js';
import { S } from '../core/state.js';

if ('mediaSession' in navigator) {
  const setHandler = (name, fn) => { try { navigator.mediaSession.setActionHandler(name, fn); } catch {} };
  setHandler('previoustrack', prev);
  setHandler('nexttrack', advance);
  setHandler('play', () => tryPlay());
  setHandler('pause', () => { S.pendingPlay = false; audio.pause(); setSession('paused'); });
}
