import {PIECE_THEMES,renderThemedPiece} from './piece-themes.js';
import {getPieceTheme,setPieceTheme,PIECE_THEME_KEY} from './pieces.js';

function mount(){
  const panel=document.getElementById('appearance-pieces');if(!panel)return;
  panel.innerHTML=`<p class="palette-description">${PIECE_THEMES.length}가지 디자인의 백·흑 기물을 비교해 보세요. 선택하면 바로 적용됩니다.</p><div class="piece-theme-list" role="group" aria-label="기물 디자인">${PIECE_THEMES.map(item=>`<button type="button" class="piece-theme-option" data-theme="${item.id}" aria-pressed="false"><span class="piece-theme-info"><strong>${item.label}</strong><span class="piece-theme-check" aria-hidden="true">✓</span></span><span class="piece-theme-samples">${['w','b'].map(color=>`<span class="piece-theme-preview-row"><span class="piece-theme-side">${color==='w'?'백':'흑'}</span><span class="piece-theme-sample">${['k','q','b','n','r','p'].map(type=>`<span>${renderThemedPiece(type,color,item.id).replace('<svg ','<svg data-theme-preview="true" ')}</span>`).join('')}</span></span>`).join('')}</span><span class="piece-theme-description">${item.description}</span></button>`).join('')}</div><p class="piece-settings-note" role="status" aria-live="polite"></p>`;
  function sync(){
    const theme=getPieceTheme();
    for(const option of panel.querySelectorAll('[data-theme]'))option.setAttribute('aria-pressed',String(option.dataset.theme===theme));
    panel.querySelector('.piece-settings-note').textContent=`${PIECE_THEMES.find(item=>item.id===theme).label} 선택됨 · 분석·대국 화면에 함께 적용됩니다.`;
    for(const svg of document.querySelectorAll('svg[data-piece-type]:not([data-theme-preview])')){
      const template=document.createElement('template');template.innerHTML=renderThemedPiece(svg.dataset.pieceType,svg.dataset.pieceColor,theme);
      const replacement=template.content.firstElementChild;
      svg.style.color=replacement.style.color;
      const rendering=replacement.getAttribute('shape-rendering');
      if(rendering)svg.setAttribute('shape-rendering',rendering);else svg.removeAttribute('shape-rendering');
      svg.replaceChildren(...replacement.childNodes);svg.dataset.pieceTheme=theme;
    }
  }
  panel.addEventListener('click',event=>{const option=event.target.closest('.piece-theme-option');if(!option)return;setPieceTheme(option.dataset.theme);sync();});
  window.addEventListener('storage',event=>{if(event.key===PIECE_THEME_KEY){setPieceTheme(event.newValue,{persist:false});sync();}});
  sync();
}
if(typeof document!=='undefined'){
  // The shared appearance dialog mounts in theme.js at DOMContentLoaded.
  if(document.readyState==='complete')mount();
  else document.addEventListener('DOMContentLoaded',mount,{once:true});
}
