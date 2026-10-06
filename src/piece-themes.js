// Original vector artwork. All themes share the board's 45 × 45 view box.
export const PIECE_THEMES = Object.freeze([
  { id: 'club', label: '클럽', description: '넓은 받침과 굵은 윤곽의 경기용 기물' },
  { id: 'pixel', label: '픽셀', description: '계단 모양으로 그린 레트로 픽셀 기물' },
  { id: 'royal', label: '로열', description: '금빛 장식과 문장을 더한 왕실 기물' },
  { id: 'paper', label: '페이퍼', description: '접힌 면이 드러나는 종이 조각 기물' },
  { id: 'arcade', label: '라운드', description: '통통한 곡선의 장난감 같은 기물' },
  { id: 'classic', label: '클래식', description: '익숙한 전통 체스 기물' },
  { id: 'modern', label: '모던', description: '선명한 각과 단순한 기하학 모양' },
  { id: 'wood', label: '우드', description: '둥글게 깎은 따뜻한 나무 기물' },
  { id: 'outline', label: '라인', description: '가벼운 윤곽과 길쭉한 실루엣' },
  { id: 'badge', label: '심볼', description: '둥근 토큰 위의 또렷한 기물 문양' },
]);

const classic = {
  p: '<circle cx="22.5" cy="12" r="5.7"/><path d="M18 17c1 7-1 10-4 13h17c-3-3-5-6-4-13M13 31h19v5H13zM11 36h23v3H11z"/>',
  r: '<path d="M11 7h6v6h4V7h4v6h4V7h6v12l-5 3v10H15V22l-4-3zM13 32h19v4H13zM10 36h25v3H10z"/><path d="M15 20h15M17 24h11" fill="none"/>',
  n: '<path d="M12 34c1-8 5-11 12-16l-9 4-6-4 5-8 5-3 1-4 5 3c11 1 14 13 9 28zM11 34h24v5H11z"/><path d="M17 10l-3 7M25 12c7 4 5 12 2 18" fill="none"/><circle cx="20" cy="11" r="1.2" fill="currentColor" stroke="none"/>',
  b: '<path d="M22.5 7c-10 7-12 15-3 19l-3 7h13l-3-7c9-4 7-12-4-19zM13 33h19v3H13zM10 36h25v3H10z"/><circle cx="22.5" cy="5" r="2.3"/><path d="M24 12l-5 8M17 27h11" fill="none"/>',
  q: '<path d="M10 13l5 18h15l5-18-9 9-3.5-13-4 13zM14 31h17v5H14zM11 36h23v3H11z"/><circle cx="9" cy="11" r="2.7"/><circle cx="22.5" cy="7" r="2.7"/><circle cx="36" cy="11" r="2.7"/><path d="M16 27h13" fill="none"/>',
  k: '<path d="M20 4h5v4h4v4h-4v6h-5v-6h-4V8h4zM15 31c0-7-8-9-6-15 2-5 10-4 13.5 2C26 12 34 11 36 16c2 6-6 8-6 15zM14 31h17v5H14zM11 36h23v3H11z"/><path d="M16 27h13M22.5 19v8" fill="none"/>',
};

const modern = {
  p: '<circle cx="22.5" cy="11" r="6"/><path d="M19 19h7l4 15H15zM12 35h21v4H12z"/>',
  r: '<path d="M10 6h6v6h4V6h5v6h4V6h6v14H10zM15 21h15v13H15zM11 35h23v4H11z"/><path d="M20 23v8M25 23v8" fill="none"/>',
  n: '<path d="M11 33l5-10 10-5-11 2-6-5 9-9 3 2 4-4 10 11-4 18zM11 35h23v4H11z"/><path d="M26 12l4 5-4 10" fill="none"/><circle cx="20" cy="13" r="1.3" fill="currentColor" stroke="none"/>',
  b: '<path d="M22.5 4L32 16l-6 9 4 8H15l4-8-6-9zM11 35h23v4H11z"/><path d="M25 11l-6 10M18 28h9" fill="none"/>',
  q: '<path d="M8 10l9 7 5.5-12 5.5 12 9-7-7 23H15zM11 35h23v4H11z"/><path d="M16 28h13" fill="none"/><circle cx="8" cy="8" r="2"/><circle cx="22.5" cy="4" r="2"/><circle cx="37" cy="8" r="2"/>',
  k: '<path d="M20 4h5v5h5v5h-5v5h8l-5 14H17l-5-14h8v-5h-5V9h5zM11 35h23v4H11z"/><path d="M18 28h9" fill="none"/>',
};

const wood = {
  p: '<circle cx="22.5" cy="10" r="6"/><path d="M17 16h11v4H17zM19 20c1 5-1 8-5 12h17c-4-4-6-7-5-12M11 33q11.5-4 23 0v5H11z"/><path d="M14 35h17" fill="none"/>',
  r: '<path d="M10 6h6v6h4V7h5v5h4V6h6v12q-3 3-6 3H16q-3 0-6-3zM17 21c2 5 1 8-3 11h17c-4-3-5-6-3-11M11 33q11.5-4 23 0v5H11z"/><path d="M15 18h15M14 35h17" fill="none"/>',
  n: '<path d="M13 31c1-6 5-10 12-14-4-1-7 4-11 4l-5-5 7-9 5 1 2-5 4 4c9 3 11 13 6 24zM11 33q11.5-4 23 0v5H11z"/><path d="M25 12c6 4 5 11 3 15M14 35h17" fill="none"/><circle cx="20" cy="13" r="1.4" fill="currentColor" stroke="none"/>',
  b: '<circle cx="22.5" cy="5" r="2.2"/><path d="M22.5 8c-5 4-10 8-8 13 1 3 5 4 5 4l-2 6h11l-2-6s4-1 5-4c2-5-3-9-8.5-13zM11 33q11.5-4 23 0v5H11z"/><path d="M25 12l-5 8M18 26h9M14 35h17" fill="none"/>',
  q: '<path d="M10 12l6 11c2 2 3 5 1 8h11c-2-3-1-6 1-8l6-11-8 6-4.5-10L18 18zM11 33q11.5-4 23 0v5H11z"/><circle cx="10" cy="10" r="3"/><circle cx="22.5" cy="6" r="3"/><circle cx="35" cy="10" r="3"/><path d="M16 24h13M14 35h17" fill="none"/>',
  k: '<path d="M20 3h5v5h4v4h-4v5h-5v-5h-4V8h4zM22.5 19c-7-9-16-4-11 4 3 4 7 3 6 8h11c-1-5 3-4 6-8 5-8-4-13-11.5-4zM11 33q11.5-4 23 0v5H11z"/><path d="M17 26h11M14 35h17" fill="none"/>',
};

const outline = {
  p: '<circle cx="22.5" cy="10" r="5"/><path d="M19 17h7l-1 10 5 9H15l5-9z"/><path d="M11 39h23M19 20h7" fill="none"/>',
  r: '<path d="M12 6h5v6h3V6h5v6h3V6h5v12l-5 3 1 15H16l1-15-5-3z"/><path d="M12 39h21M17 21h11M17 31h11" fill="none"/>',
  n: '<path d="M13 36c-1-9 3-14 13-20l-11 5-5-5 7-8 4 1 3-5 7 7c6 7 3 16 0 25z"/><path d="M12 39h22M28 14c3 7 1 12-3 18" fill="none"/><circle cx="20" cy="13" r="1.2" fill="currentColor" stroke="none"/>',
  b: '<circle cx="22.5" cy="4.5" r="1.8"/><path d="M22.5 8c-10 10-10 15-1.5 18l-5 10h13l-5-10c8.5-3 8.5-8-1.5-18z"/><path d="M25 12l-6 9M12 39h21M19 30h7" fill="none"/>',
  q: '<path d="M10 12l5 10 4-7 3.5-9 3.5 9 4 7 5-10-7 24H17z"/><circle cx="10" cy="10" r="2"/><circle cx="22.5" cy="4" r="2"/><circle cx="35" cy="10" r="2"/><path d="M18 29h9M12 39h21" fill="none"/>',
  k: '<path d="M20 3h5v5h5v4h-5v6h-5v-6h-5V8h5zM13 20q4-3 9.5 0Q28 17 32 20l-6 7 3 9H16l3-9z"/><path d="M19 28h7M12 39h21" fill="none"/>',
};

// The symbol theme uses compact, independently drawn icons rather than a
// scaled copy of another theme, so the token remains readable at small sizes.
const badge = {
  p: '<circle cx="22.5" cy="15" r="4"/><path d="M20 20h5l1 6 4 5H15l4-5z"/>',
  r: '<path d="M13 12h5v5h3v-5h3v5h3v-5h5v9l-4 2v5l3 3H14l3-3v-5l-4-2z"/>',
  n: '<path d="M15 31c0-6 4-10 10-13l-8 2-4-4 6-6 3 2 3-4 6 7c3 5 0 11-1 16z"/><circle cx="22" cy="16" r="1.2" fill="var(--theme-cutout)"/>',
  b: '<path d="M22.5 9c-9 8-9 12-2 16l-5 6h15l-5-6c7-4 7-8-2.5-16z"/><path d="M25 14l-5 6" stroke="var(--theme-cutout)" stroke-width="2" fill="none"/>',
  q: '<path d="M11 13l7 8 4.5-11 4.5 11 7-8-4 18H15z"/><circle cx="11" cy="12" r="2"/><circle cx="22.5" cy="9" r="2"/><circle cx="34" cy="12" r="2"/>',
  k: '<path d="M20 9h5v4h4v4h-4v5h7l-4 9H17l-4-9h7v-5h-4v-4h4z"/>',
};

// Broad club silhouettes use inset details that remain visible on dark pieces.
const club = {
  p: '<circle cx="22.5" cy="11" r="7"/><path d="M16 18h13v4H16zM18 22h9c0 5 2 7 5 10H13c3-3 5-5 5-10zM12 32h21l3 7H9z"/><path d="M15 35h15" fill="none" stroke="var(--theme-detail)"/>',
  r: '<path d="M9 5h7v7h4V5h5v7h4V5h7v14l-5 4 1 9 4 7H9l4-7 1-9-5-4z"/><path d="M14 19h17M16 24h13M14 34h17" fill="none" stroke="var(--theme-detail)"/>',
  n: '<path d="M11 32c0-7 3-12 11-16l-7 3-6-3 6-9 5 1 3-5 6 5c7 4 8 14 3 24l4 7H9z"/><path d="M27 12c4 5 3 11-1 16M14 34h17" fill="none" stroke="var(--theme-detail)"/><circle cx="20" cy="12" r="1.6" fill="var(--theme-detail)" stroke="none"/>',
  b: '<path d="M22.5 5c-6 5-11 9-11 14 0 5 5 7 8 8l-4 5h15l-4-5c3-1 8-3 8-8 0-5-5-9-11.5-14zM12 32h21l3 7H9z"/><circle cx="22.5" cy="4" r="2"/><path d="M26 11l-7 10M18 28h9M14 35h17" fill="none" stroke="var(--theme-detail)" stroke-width="2.2"/>',
  q: '<path d="M8 12l8 7 6.5-12L29 19l8-7-7 20H15zM12 32h21l3 7H9z"/><circle cx="8" cy="10" r="3"/><circle cx="22.5" cy="5" r="3"/><circle cx="37" cy="10" r="3"/><path d="M16 26h13M14 35h17" fill="none" stroke="var(--theme-detail)"/>',
  k: '<path d="M20 3h5v5h5v5h-5v5h-5v-5h-5V8h5zM14 32l-4-11c-2-7 6-9 12.5-3C29 12 37 14 35 21l-4 11zM12 32h21l3 7H9z"/><path d="M22.5 19v9M16 28h13M14 35h17" fill="none" stroke="var(--theme-detail)"/>',
};

// Every contour and detail sits on a three-unit pixel grid; there are no curves.
const pixel = {
  p: '<path d="M18 6h9v3h3v9h-3v3h-9v-3h-3V9h3zM18 21h9v9h3v3h6v6H9v-6h6v-3h3z"/><path d="M18 9h6v3h-3v3h-3zM12 33h9v3h-9z" fill="var(--theme-detail)" stroke="none"/>',
  r: '<path d="M9 6h6v6h6V6h3v6h6V6h6v15h-6v12h6v6H9v-6h6V21H9z"/><path d="M15 18h15v3H15zM18 24h3v6h-3zM12 33h9v3h-9z" fill="var(--theme-detail)" stroke="none"/>',
  n: '<path d="M21 3h6v3h3v3h3v6h3v18h3v6H9v-6h3v-6h3v-3h6v-3h3v-3h-3v3H12v-3H6v-6h3V9h6V6h6z"/><path d="M18 9h3v3h-3zM27 15h3v15h-3zM12 33h9v3h-9z" fill="var(--theme-detail)" stroke="none"/>',
  b: '<path d="M21 3h3v6h3v3h3v3h3v9h-6v6h3v3h6v6H9v-6h6v-3h3v-6h-6v-9h3v-3h3V9h3z"/><path d="M24 12h3v6h-3v3h-3v-6h3zM12 33h9v3h-9z" fill="var(--theme-detail)" stroke="none"/>',
  q: '<path d="M6 9h6v6h6v-3h3V3h3v9h3v3h6V9h6v12h-3v6h-3v6h3v6H9v-6h3v-6H9v-6H6z"/><path d="M15 24h15v3H15zM21 15h3v6h-3zM12 33h9v3h-9z" fill="var(--theme-detail)" stroke="none"/>',
  k: '<path d="M21 3h3v6h6v6h-6v6h9v9h-3v3h6v6H9v-6h6v-3h-3v-9h9v-6h-6V9h6z"/><path d="M18 24h9v3h-9zM12 33h9v3h-9z" fill="var(--theme-detail)" stroke="none"/>',
};

// Heraldic carvings combine pointed feet, fine gold bands, and inset jewels.
const royal = {
  p: '<path d="M22.5 4l6 4v7l-6 5-6-5V8zM18 20h9l-2 8 7 5 4 7H9l4-7 7-5z"/><path d="M22.5 7l3 4-3 4-3-4zM16 34h13M13 37h19" fill="none" stroke="var(--theme-detail)"/>',
  r: '<path d="M8 5h7v7h5V5h5v7h5V5h7v15l-6 3 2 9 4 8H8l4-8 2-9-6-3z"/><path d="M13 17h19M13 33h19M11 37h23M19 29v-5a3.5 3.5 0 0 1 7 0v5z" fill="none" stroke="var(--theme-detail)"/>',
  n: '<path d="M12 32c0-5 4-10 13-15l-9 3-7-5 6-7 4-1 1-4 6 4 5-2 4 6-3 2c6 5 5 13 0 19l5 8H8z"/><path d="M27 13c6 5 5 10 1 15M15 34h15M12 37h21M28 8l4 3" fill="none" stroke="var(--theme-detail)"/><path d="M20 11l2 2-2 2-2-2z" fill="var(--theme-detail)" stroke="none"/>',
  b: '<path d="M22.5 3l3 4-3 3-3-3zM22.5 10c-5 4-10 8-9 12 1 4 7 5 7 5l-6 6-5 7h27l-5-7-6-6s6-1 7-5c1-4-4-8-9.5-12z"/><path d="M25 14l-5 8M18 28h9M16 34h13M13 37h19" fill="none" stroke="var(--theme-detail)"/>',
  q: '<path d="M7 10l8 9-1-12 8.5 12L31 7l-1 12 8-9-7 22 6 8H8l6-8z"/><path d="M14 26h17M16 32h13M12 37h21M22.5 23l3 4-3 4-3-4z" fill="none" stroke="var(--theme-detail)"/><circle cx="7" cy="8" r="2"/><circle cx="14" cy="5" r="2"/><circle cx="31" cy="5" r="2"/><circle cx="38" cy="8" r="2"/>',
  k: '<path d="M22.5 2l3 3-1 3h5v5h-5v4h-4v-4h-5V8h5l-1-3zM12 18l6 3 4.5-4 4.5 4 6-3-3 13 7 9H8l7-9z"/><path d="M17 27h11M16 32h13M12 37h21M22.5 21v7" fill="none" stroke="var(--theme-detail)"/>',
};

// Angular folded-paper silhouettes include explicit differently colored facets.
const paper = {
  p: '<path d="M22 4l8 5v9l-8 5-8-5V9zM18 22h8l3 9 7 8H9l7-8z"/><path d="M22 4v19l-8-5V9zM22 23l7 8 7 8H22z" fill="var(--theme-facet)" stroke="none"/><path d="M14 9l8 5 8-5M22 14v9M16 31l6 4 7-4" fill="none" stroke="var(--theme-detail)"/>',
  r: '<path d="M9 5h7v7h4V5h5v7h4V5h7v13l-7 5 2 9 6 7H8l6-7 2-9-7-5z"/><path d="M9 18l13 6 14-6-7 5 2 9 6 7H22V24l-6-1z" fill="var(--theme-facet)" stroke="none"/><path d="M9 18h27M16 23l6 1 7-1M14 32l8 4 9-4" fill="none" stroke="var(--theme-detail)"/>',
  n: '<path d="M10 32l6-10 10-6-10 3-8-5L19 6l4 3 4-6 9 14-5 15 6 7H8z"/><path d="M27 3l9 14-5 15 6 7H23l3-23zM19 6l4 3-7 10-8-5z" fill="var(--theme-facet)" stroke="none"/><path d="M26 16l5 8-8 15M10 32h21" fill="none" stroke="var(--theme-detail)"/><path d="M19 11l3 1-2 2z" fill="var(--theme-detail)" stroke="none"/>',
  b: '<path d="M22 3l12 16-9 9 5 5 6 6H9l6-6 5-5-9-9z"/><path d="M22 3v25l12-9zM22 28l8 5 6 6H22z" fill="var(--theme-facet)" stroke="none"/><path d="M26 9l-8 12M11 19l11 9 12-9M15 33l7 3 8-3" fill="none" stroke="var(--theme-detail)"/>',
  q: '<path d="M7 8l10 10 5-14 6 14L38 8l-8 24 7 7H8l7-7z"/><path d="M22 4v28l6-14zM38 8L22 32h8zM22 32l15 7H22z" fill="var(--theme-facet)" stroke="none"/><path d="M7 8l15 24L38 8M15 32h15" fill="none" stroke="var(--theme-detail)"/>',
  k: '<path d="M20 3h5v6h6v5h-6v6l9 3-7 9 10 7H8l10-7-7-9 9-3v-6h-6V9h6z"/><path d="M25 3v17l-3 5-2-5V3zM22 25l12-2-7 9 10 7H22z" fill="var(--theme-facet)" stroke="none"/><path d="M11 23l11 2 12-2M22 25v14M18 32h9" fill="none" stroke="var(--theme-detail)"/>',
};

// Chunky toy forms use broad curves, oversized heads, and pill-shaped feet.
const arcade = {
  p: '<path d="M17 22c-5-2-7-6-7-10a12.5 10 0 0 1 25 0c0 4-2 8-7 10v8H17z"/><rect x="10" y="29" width="25" height="11" rx="5.5"/><path d="M16 10q0-3 4-4M16 34h8" fill="none" stroke="var(--theme-detail)" stroke-width="2.7"/>',
  r: '<path d="M8 9a4 4 0 0 1 8 0v5h3V8a3.5 3.5 0 0 1 7 0v6h3V9a4 4 0 0 1 8 0v10c0 4-4 5-7 5v6H15v-6c-3 0-7-1-7-5z"/><rect x="9" y="29" width="27" height="11" rx="5.5"/><path d="M15 19h15M15 34h9" fill="none" stroke="var(--theme-detail)" stroke-width="2.7"/>',
  n: '<path d="M14 30c0-4 3-7 8-10l-7 2c-6 2-10-3-7-7l7-8c2-2 5-1 7 0l2-3c2-2 5 0 5 3 10 3 11 13 5 23z"/><rect x="9" y="29" width="28" height="11" rx="5.5"/><circle cx="19" cy="13" r="2" fill="var(--theme-detail)" stroke="none"/><path d="M28 13q5 5 0 12M15 34h9" fill="none" stroke="var(--theme-detail)" stroke-width="2.7"/>',
  b: '<path d="M22.5 4C18 4 10 14 10 20c0 5 5 8 10 8l-4 4h13l-4-4c5 0 10-3 10-8 0-6-8-16-12.5-16z"/><rect x="9" y="29" width="27" height="11" rx="5.5"/><path d="M26 11l-7 9M15 34h9" fill="none" stroke="var(--theme-detail)" stroke-width="3"/>',
  q: '<path d="M11 29L7 14c-2-6 4-8 7-4l4 7 1-10c0-5 7-5 7 0l1 10 4-7c3-4 9-2 7 4l-4 15z"/><rect x="8" y="29" width="29" height="11" rx="5.5"/><path d="M16 25h13M14 34h10" fill="none" stroke="var(--theme-detail)" stroke-width="2.7"/>',
  k: '<path d="M19 7a3.5 3.5 0 0 1 7 0v2h3a3 3 0 0 1 0 6h-3v4h-7v-4h-3a3 3 0 0 1 0-6h3zM22.5 22c-5-8-15-5-14 1 1 4 5 7 8 9h12c3-2 7-5 8-9 1-6-9-9-14 0z"/><rect x="8" y="29" width="29" height="11" rx="5.5"/><path d="M22.5 22v4M14 34h10" fill="none" stroke="var(--theme-detail)" stroke-width="2.7"/>',
};

const shapes = { classic, modern, wood, outline, badge, club, pixel, royal, paper, arcade };

/** Return an inline SVG without external assets, references, or shared IDs. */
export function renderThemedPiece(type, color, theme = 'classic') {
  const selected = Object.hasOwn(shapes, theme) ? theme : 'classic';
  const side = color === 'b' ? 'b' : 'w';
  const piece = Object.hasOwn(classic, type) ? type : 'p';
  const light = side === 'w';
  let fill = light ? '#fffdf5' : '#263d34';
  let stroke = light ? '#45544b' : '#162b23';
  let width = 1.5;
  let linecap = 'round';
  let linejoin = 'round';
  let groupStyle = '';
  let rendering = '';
  let artwork = shapes[selected][piece];
  if (selected === 'modern') {
    fill = light ? '#f9fcff' : '#283947';
    stroke = light ? '#3c4f5c' : '#101e28';
    width = 1.7;
  } else if (selected === 'wood') {
    fill = light ? '#f4d5a2' : '#75432b';
    stroke = light ? '#705138' : '#362014';
    width = 1.7;
  } else if (selected === 'outline') {
    fill = light ? '#ffffff' : '#253640';
    stroke = light ? '#334952' : '#0c202b';
    width = 1.9;
  } else if (selected === 'badge') {
    const token = light ? '#fff9eb' : '#273c47';
    const ink = light ? '#364d58' : '#f8efd8';
    // Explicit CSS variables are local to this SVG and need no unique IDs.
    artwork = `<circle cx="22.5" cy="22.5" r="18.5" fill="${token}" stroke="${light ? '#5a6e70' : '#142630'}" stroke-width="1.6"/><g fill="${ink}" stroke="none" style="--theme-cutout:${token}">${artwork}</g>`;
  } else if (selected === 'club') {
    fill = light ? '#fff8e8' : '#25272c';
    stroke = light ? '#373a40' : '#111318';
    width = 1.8;
    groupStyle = ` style="--theme-detail:${light ? '#6d6b65' : '#ddd9cb'}"`;
  } else if (selected === 'pixel') {
    fill = light ? '#fff2bf' : '#28314b';
    stroke = light ? '#4e452e' : '#131a30';
    width = 1.4;
    linecap = 'butt';
    linejoin = 'miter';
    rendering = ' shape-rendering="crispEdges"';
    groupStyle = ` style="--theme-detail:${light ? '#d6b35e' : '#8ba5d5'}"`;
  } else if (selected === 'royal') {
    fill = light ? '#fff5da' : '#473045';
    stroke = light ? '#715a35' : '#291d2b';
    width = 1.5;
    groupStyle = ` style="--theme-detail:${light ? '#a07632' : '#edc978'}"`;
  } else if (selected === 'paper') {
    fill = light ? '#fff7ef' : '#385573';
    stroke = light ? '#715e57' : '#1c324b';
    width = 1.3;
    linecap = 'square';
    linejoin = 'miter';
    groupStyle = ` style="--theme-detail:${light ? '#b58472' : '#9bbad7'};--theme-facet:${light ? '#e8bba4' : '#23415f'}"`;
  } else if (selected === 'arcade') {
    fill = light ? '#fff9de' : '#39405f';
    stroke = light ? '#646076' : '#202640';
    width = 1.8;
    groupStyle = ` style="--theme-detail:${light ? '#d4b371' : '#99acd7'}"`;
  }
  return `<svg viewBox="0 0 45 45" aria-hidden="true" class="piece ${light ? 'white-piece' : 'black-piece'}" data-piece-type="${piece}" data-piece-color="${side}" data-piece-theme="${selected}" style="color:${stroke}"${rendering}><g fill="${fill}" stroke="${stroke}" stroke-width="${width}" stroke-linecap="${linecap}" stroke-linejoin="${linejoin}"${groupStyle}>${artwork}</g></svg>`;
}
