# 1.20.2 · 기본 확장 / MissAV 확장 / Windows 통합 앱

사용자의 세 가지 빌드·릴리즈 요청에 따라 `v1.20.2`를 새 정식 릴리즈로 준비한다. 이전의 게시 금지 지시는 검증 단계에 적용됐으며, 이 릴리즈 게시 자체는 이후 사용자가 명시적으로 요청했다. 작업 환경을 게시하는 작업은 포함하지 않는다.

| 파일 | 범위 |
| --- | --- |
| `my-video-app-extension-standard.zip` | 기존 원본 수집기·백그라운드 코드를 유지한 1.20.2 기본판 새 빌드 |
| `my-video-app-extension-missav.zip` | MissAV 원본 탭·최신 주소 복원과 CDN 요청 정보 보완을 포함한 1.20.2 새 빌드 |
| `my-video-app-desktop-windows-x64.zip` | 일반 직접 미디어·YouTube와 MissAV를 한 앱에서 지원하는 1.20.2 Windows x64 앱 |

소스는 실제 61분 전체 다운로드와 Windows 검사를 통과한 `17791fccfd28ff5675d00a3e06dce6c05a45de63`의 기능 수정을 포함한다. 앱·확장·의존성 잠금의 제품 버전만 1.20.2로 맞추고 런타임 버전은 유지했다. 기본판 수집기·백그라운드의 원본 소스 바이트는 변경하지 않았다. 선택적 백신 도우미도 기존 SHA-256과 현재 원본 소스의 일치를 확인해 제공한다.

릴리즈 작업은 수동 실행한다. Windows 빌드·검증 작업은 저장소 읽기 권한으로 실행하고, 검사를 통과한 설치 ZIP·검증 JSON·소스 ZIP·SHA-256만 게시 작업으로 넘긴다. 게시 작업은 새 체크아웃에서 ZIP 내부 파일 해시, 버전, 변형별 실제 진입점, Windows 앱의 현재 소스와 고정 런타임, 실제 설치 확장의 UI 검사, 전체 실영상 다운로드 결과를 다시 확인한다. 새 태그의 정식 릴리즈를 최신으로 지정하며 기존 공개 릴리즈와 태그는 수정하지 않는다.

이번 릴리즈 ZIP을 검사한 상세 결과는 릴리즈에 첨부되는 `WINDOWS-VALIDATION.json`, `WINDOWS-GUI-VALIDATION.json`, `STANDARD-UI-VALIDATION.json`, `MISSAV-UI-VALIDATION.json`, `INSTALLED-EXTENSION-VALIDATION.json`, `LIVE-VALIDATION.json`, `RELEASE-CONTENTS.json`에 기록된다. `SHA256SUMS-RELEASE.txt`는 게시 파일별 확인값이다.

실제 영상 검사에서는 원본 MissAV 탭에서 제공된 m3u8를 실제 요청해 감지한 뒤 주소 입력 폼으로 다운로드한다. 원본 페이지를 여는 것만으로 자동 감지가 됐거나 Cloudflare 인증을 해제했다고 확대하지 않는다. 백신 도우미가 없는 검사 프로필의 ‘보안 확인 필요’는 파일 저장 실패와 구분한다. 실제 영상과 프레임은 릴리즈에 포함하지 않는다. 실제 YouTube 사이트·사용자 PC·백신 연동 전체를 새로 검사했다는 의미도 아니다.

[앞선 Windows 및 61분 전체 다운로드 검증](WINDOWS_VERIFICATION_PLAN.ko.md) · [1.20.2 릴리즈](https://github.com/P-JSL/myapps/releases/tag/v1.20.2)
