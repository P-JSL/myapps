# 1.20.3 · 기본판과 MissAV판 설치 폴더 분리

사용자의 추가 요청에 따라 기본 확장은 `extensions/standard/`, MissAV 확장은 `extensions/missav/`에 실제 설치 파일을 따로 보관하고 커밋한다. `dist/`는 Git에 포함하지 않는 빌드 중간 폴더로 사용한다.

`npm run build:extensions`는 두 버전을 순서대로 새로 빌드한다. 각 폴더에는 자체 `manifest.json`과 필요한 실행 파일이 모두 들어 있다. Chrome에서 사용할 버전 하나의 폴더를 선택하면 된다. ZIP 안의 루트 폴더도 각각 `my-video-app-standard/`, `my-video-app-missav/`로 구분해 같은 위치에 풀어도 서로 덮어쓰지 않는다. Windows 프로그램은 일반 미디어·YouTube와 MissAV를 지원하는 통합판 하나로 제공한다.

이미 게시한 `v1.20.2`는 수정하지 않고, 폴더 구분은 새 정식 릴리즈 `v1.20.3`으로 제공한다. 앱과 확장의 제품 버전 표기만 함께 맞추며, 원본 수집기·다운로드 로직과 런타임 버전은 유지한다. 실제 설치 폴더에서 두 확장 UI를 실행하고 해당 폴더 내용과 각 ZIP의 파일 해시가 일치하는지 확인한다. 두 ZIP의 루트 폴더를 혼동하지 않는 별도 포장 검사도 추가했다.

게시 작업은 Windows 앱 실행·다운로드, 각 확장 UI, 실제 61분 영상의 전체 다운로드, ZIP 내부 해시·버전·소스 일치 검사가 모두 통과한 결과만 받는다. 기본 브랜치 반영 시 과거 통합 릴리즈가 자동 재게시되지 않도록 1.19 통합 워크플로는 수동 실행으로 유지한다. 작업 환경 자체는 게시하지 않는다.

검증 조건과 범위는 [Windows 검증 보고서](WINDOWS_VERIFICATION_PLAN.ko.md)를 참고한다. 새 빌드의 결과는 릴리즈에 첨부하는 검증 JSON과 `RELEASE-CONTENTS.json`, `SHA256SUMS-RELEASE.txt`에 기록된다. 실제 영상은 릴리즈에 포함하지 않는다.

[1.20.3 릴리즈](https://github.com/P-JSL/myapps/releases/tag/v1.20.3)
