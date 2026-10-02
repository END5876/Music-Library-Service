// queue/model.js — 佇列項目的建立與可用性判斷
import { S, offlineKeys } from '../core/state.js';

let qid = 0;

export const mkLib = (filename, title) => ({ id: ++qid, kind: 'lib', filename, title });

export const mkOnline = (item) => ({ id: ++qid, kind: 'online', item });

export const libAvailable = (fn) => S.byFile.has(fn) || offlineKeys.has('lib:' + fn);
