// playlists/picker.js — 「加入播放清單」選擇對話框
import { $ } from '../core/dom.js';
import { setStatus } from '../core/toast.js';
import { makeRow } from '../ui/rows.js';
import { currentEntry } from '../playback/controller.js';
import { onlineItem } from './model.js';
import { askText } from './dialog.js';
import { addToPlaylist, createPlaylist } from './actions.js';
import { renderPlaylists } from './view.js';
import { S } from '../core/state.js';

// ── 「加入播放清單」選單 ──────────────────────────────
let pickItems = null;

const closePick = () => $('pickPl').classList.remove('show');

export function pickPlaylist(items) {
  if (!items || !items.length) return;
  pickItems = items;
  const ul = $('pickList'); ul.textContent = '';
  if (!S.playlists.length) {
    const li = document.createElement('li'); li.className = 'note';
    li.textContent = '還沒有播放清單,先建立一個吧'; ul.appendChild(li);
  }
  for (const p of S.playlists) {
    ul.appendChild(makeRow({
      title: p.name, sub: `${p.items.length} 首`,
      onClick: async () => {
        const its = pickItems; closePick();
        try {
          const j = await addToPlaylist(p.id, its);
          setStatus(j.added ? `已加入「${p.name}」` + (its.length > 1 ? `(${j.added} 首)` : '') : `「${p.name}」已經有這首歌了`);
        } catch (err) { setStatus(err.message); }
      },
    }));
  }
  $('pickPl').classList.add('show');
}

$('pickClose').addEventListener('click', closePick);

$('pickNew').addEventListener('click', async () => {
  const its = pickItems; closePick();
  const name = await askText('新增播放清單');
  if (!name) return;
  try {
    const p = await createPlaylist(name, its);
    renderPlaylists();
    setStatus(`已建立「${p.name}」並加入 ${p.items.length} 首`);
  } catch (err) { setStatus(err.message); }
});

$('fAddPl').addEventListener('click', () => {
  const c = currentEntry();
  if (!c) return setStatus('目前沒有播放中的歌曲');
  pickPlaylist([c.kind === 'lib'
    ? { kind: 'lib', filename: c.filename, title: (S.byFile.get(c.filename) || {}).name }
    : onlineItem(c.item)]);
});
