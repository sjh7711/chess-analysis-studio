// Apply the saved appearance before the first paint on either page.
(() => {
  const key = 'chessreview.theme';
  const paletteKey = 'chessreview.palette';
  const palettes = [
    { id: 'green', label: '그린', hue: 138, saturation: 34 },
    { id: 'blue', label: '블루', hue: 215, saturation: 58 },
    { id: 'purple', label: '퍼플', hue: 270, saturation: 40 },
    { id: 'rose', label: '로즈', hue: 342, saturation: 46 },
    { id: 'amber', label: '앰버', hue: 36, saturation: 56 },
    { id: 'gray', label: '그레이', hue: 220, saturation: 0 },
  ];
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const valid = value => value === 'light' || value === 'dark';
  let preference = null;
  let palette = 'green';
  const read = name => { try { return localStorage.getItem(name); } catch { return null; } };
  const save = (name, value) => { try { localStorage.setItem(name, value); } catch { /* Still apply on this page. */ } };
  preference = read(key);
  palette = read(paletteKey);

  function apply() {
    const dark = valid(preference) ? preference === 'dark' : system.matches;
    const color = palettes.find(item => item.id === palette) || palettes[0];
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.palette = color.id;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', `hsl(${color.hue} ${dark ? Math.min(color.saturation, 12) : color.saturation}% ${dark ? 12 : 30}%)`);
    document.querySelectorAll('[data-palette-choice]').forEach(option => option.setAttribute('aria-pressed', String(option.dataset.paletteChoice === color.id)));
    document.querySelectorAll('[data-appearance-mode]').forEach(option => option.setAttribute('aria-pressed', String(option.dataset.appearanceMode === root.dataset.theme)));
    const label = document.getElementById('palette-status');
    if (label) label.textContent = `${color.label} · ${dark ? '다크' : '화이트'} 모드`;
    const opener = document.getElementById('palette-open');
    if (opener) opener.title = `화면 색상 선택 · ${color.label}`;
  }

  function setMode(mode) {
    preference = mode;
    save(key, mode);
    apply();
  }

  function mountPalette() {
    const opener = document.getElementById('palette-open');
    if (!opener) return;
    const dialog = document.createElement('dialog');
    dialog.id = 'palette-dialog';
    dialog.className = 'palette-dialog';
    dialog.setAttribute('aria-labelledby', 'palette-title');
    dialog.innerHTML = `<div class="palette-heading"><h2 id="palette-title">화면 색상</h2><button type="button" id="palette-close" aria-label="색상 선택 닫기"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>
      <p class="palette-description">원하는 색을 고르면 화면과 체스판에 바로 적용됩니다.</p>
      <div class="palette-modes" role="group" aria-label="화면 밝기"><button type="button" data-appearance-mode="light" aria-pressed="false">화이트 모드</button><button type="button" data-appearance-mode="dark" aria-pressed="false">다크 모드</button></div>
      <div class="palette-options" role="group" aria-label="화면 색상 선택">${palettes.map(color => `<button type="button" class="palette-option" data-palette="${color.id}" data-palette-choice="${color.id}" aria-pressed="false"><span class="palette-option-heading"><strong>${color.label}</strong><span class="palette-check" aria-hidden="true">✓</span></span><span class="palette-previews" aria-hidden="true">${['light', 'dark'].map(mode => `<span class="palette-preview ${mode}"><span class="palette-preview-bar"></span><span class="palette-preview-content"><span class="palette-preview-board"><i></i><i></i><i></i><i></i></span><span class="palette-preview-lines"><i></i><i></i><i></i></span></span><span class="palette-preview-label">${mode === 'light' ? '화이트' : '다크'}</span></span>`).join('')}</span></button>`).join('')}</div>
      <div class="palette-footer"><span id="palette-status" role="status" aria-live="polite"></span><span>이 브라우저에 자동 저장</span></div>`;
    document.body.append(dialog);
    opener.addEventListener('click', () => { apply(); dialog.showModal(); });
    document.getElementById('palette-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
      const option = event.target.closest('[data-palette-choice]');
      const mode = event.target.closest('[data-appearance-mode]');
      if (option) { palette = option.dataset.paletteChoice; save(paletteKey, palette); apply(); }
      else if (mode) setMode(mode.dataset.appearanceMode);
    });
  }

  apply();
  document.addEventListener('DOMContentLoaded', () => {
    mountPalette();
    apply();
  }, { once: true });
  system.addEventListener('change', () => { if (!valid(preference)) apply(); });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === paletteKey || event.key === null) {
      if (event.key === key || event.key === null) preference = event.newValue;
      if (event.key === paletteKey || event.key === null) palette = event.newValue;
      apply();
    }
  });
})();
