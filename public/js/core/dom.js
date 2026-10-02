// core/dom.js — DOM 取用：$ 與唯一的 <audio> 元素

export const $ = (id) => document.getElementById(id);

export const audio = $('audio');
