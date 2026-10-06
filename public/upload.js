'use strict';

(() => {
  const form = document.getElementById('uploadForm');
  const fileInput = document.getElementById('file');
  const titleInput = document.getElementById('titleInput');
  const folderInput = document.getElementById('folder');
  const submit = document.getElementById('submit');
  const status = document.getElementById('status');
  const bar = document.getElementById('bar');
  const setStatus = (text, kind = '') => {
    status.textContent = text;
    status.className = 'status ' + kind;
  };

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file && !titleInput.value.trim()) titleInput.value = file.name.replace(/\.[^.]+$/, '');
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const file = fileInput.files[0];
    if (!file) return;

    submit.disabled = true;
    bar.style.width = '0%';
    setStatus('正在上傳…');

    const req = new XMLHttpRequest();
    req.open('POST', '/web/api/upload?upload=1');
    // HTTP header 僅可靠傳遞 ASCII；URL 編碼可保留中文曲名及資料夾名稱。
    req.setRequestHeader('x-upload-filename', encodeURIComponent(file.name));
    req.setRequestHeader('x-upload-title', encodeURIComponent(titleInput.value.trim() || file.name));
    req.setRequestHeader('x-upload-folder', encodeURIComponent(folderInput.value.trim()));
    req.upload.onprogress = (progress) => {
      if (progress.lengthComputable) bar.style.width = Math.round(progress.loaded / progress.total * 100) + '%';
    };
    req.upload.onload = () => {
      bar.style.width = '100%';
      setStatus('正在壓縮與正規化，請稍候…');
    };
    req.onerror = () => {
      submit.disabled = false;
      setStatus('連線失敗，請重試。', 'error');
    };
    req.onloadend = () => {
      if (req.status === 201) {
        let result = {};
        try { result = JSON.parse(req.responseText); } catch {}
        setStatus('完成：' + (result.filename || '音檔已儲存'), 'success');
        form.reset();
        submit.disabled = false;
      } else if (req.status && req.status !== 201) {
        let result = {};
        try { result = JSON.parse(req.responseText); } catch {}
        setStatus(result.error || '上傳失敗，請確認音檔格式後重試。', 'error');
        submit.disabled = false;
      }
    };
    req.send(file);
  });
})();