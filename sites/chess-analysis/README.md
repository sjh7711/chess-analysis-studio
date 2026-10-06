# 체스 분석

Stockfish 19 체스 분석과 친구 간 1대1 대국을 지원하는 앱입니다.

`.openai/hosting.json`의 기존 Site ID와 D1 `DB` 바인딩을 유지하세요. Vinext Worker의 `/api/play/`에서 로그인, 친구 목록, 대국 상태와 경기 기록을 처리합니다. 인증은 Sites의 ChatGPT 로그인 헤더를 사용합니다. 친구 목록과 기보는 계정에 저장됩니다.

원본 작업 폴더에서 `node scripts/package-static.mjs`로 화면과 모듈을 `public` 및 라우트용 HTML에 동기화한 다음, Sites 빌드 도구로 배포 결과를 생성합니다. 서버 스키마는 `db/schema.ts`, 스키마 변경 이력은 `drizzle/`에 있습니다. 로컬 분석 라이브러리와 분석 캐시는 각 브라우저에 저장됩니다.

오픈소스 라이선스와 엔진 소스 주소는 `public/licenses/`에 있습니다. 임시 보드 표기는 서버나 기보에 저장되지 않습니다.
