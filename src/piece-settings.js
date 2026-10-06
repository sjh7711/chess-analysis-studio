import {PIECE_THEMES,renderThemedPiece} from './piece-themes.js';
import {getPieceTheme,setPieceTheme,PIECE_THEME_KEY} from './pieces.js';

function mount(){
  const open=document.getElementById('piece-settings-open');if(!open)return;
  const dialog=document.createElement('dialog');dialog.className='piece-settings-dialog';dialog.id='piece-settings-dialog';
  dialog.setAttribute('aria-labelledby','piece-settings-title');
  dialog.innerHTML=`<div class="piece-settings-heading"><h2 id="piece-settings-title">기물 모양</h2><button type="button" class="piece-settings-close" aria-label="기물 모양 선택 닫기">닫기</button></div><p>${PIECE_THEMES.length}가지 디자인의 백·흑 기물을 비교해 보세요. 선택하면 바로 적용됩니다.</p><div class="piece-theme-list" role="group" aria-label="기물 디자인">${PIECE_THEMES.map(item=>`<button type="button" class="piece-theme-option" data-theme="${item.id}" aria-pressed="false"><span class="piece-theme-info"><strong>${item.label}</strong><span class="piece-theme-check" aria-hidden="true">✓</span></span><span class="piece-theme-samples">${['w','b'].map(color=>`<span class="piece-theme-preview-row"><span class="piece-theme-side">${color==='w'?'백':'흑'}</span><span class="piece-theme-sample">${['k','q','b','n','r','p'].map(type=>`<span>${renderThemedPiece(type,color,item.id).replace('<svg ','<svg data-theme-preview="true" ')}</span>`).join('')}</span></span>`).join('')}</span><span class="piece-theme-description">${item.description}</span></button>`).join('')}</div><p class="piece-settings-note" role="status">분석·대국 화면에 함께 적용되며, 이 브라우저에 저장됩니다.</p>`;
  document.body.append(dialog);
  function sync(){
    const theme=getPieceTheme();
    for(const option of dialog.querySelectorAll('[data-theme]'))option.setAttribute('aria-pressed',String(option.dataset.theme===theme));
    for(const svg of document.querySelectorAll('svg[data-piece-type]:not([data-theme-preview])')){
      const template=document.createElement('template');template.innerHTML=renderThemedPiece(svg.dataset.pieceType,svg.dataset.pieceColor,theme);
      const replacement=template.content.firstElementChild;
      svg.style.color=replacement.style.color;
      const rendering=replacement.getAttribute('shape-rendering');
      if(rendering)svg.setAttribute('shape-rendering',rendering);else svg.removeAttribute('shape-rendering');
      svg.replaceChildren(...replacement.childNodes);svg.dataset.pieceTheme=theme;
    }
  }
  open.onclick=()=>{sync();dialog.showModal();};
  dialog.querySelector('.piece-settings-close').onclick=()=>dialog.close();
  dialog.addEventListener('click',event=>{const option=event.target.closest('[data-theme]');if(!option)return;setPieceTheme(option.dataset.theme);sync();});
  window.addEventListener('storage',event=>{if(event.key===PIECE_THEME_KEY){setPieceTheme(event.newValue,{persist:false});sync();}});
  sync();
}
if(typeof document!=='undefined')mount();
