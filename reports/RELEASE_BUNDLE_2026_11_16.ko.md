# 세 가지 설치 파일 통합 릴리즈 점검

확인일: 2026-11-16, 한국 시간 기준. 통합 릴리즈 태그: `v1.19.4-bundle.1`.

**MissAV 감지 추가판, MissAV 미추가 일반판 확장, Windows 앱을 한 릴리즈에서 각각 제공합니다.** 앱 코드는 기존 원격 `main`의 `748c332c1eb40a94b653f01fbad363631ec22857`을 유지합니다. 이 변경은 점검 근거와 다운로드 안내를 추가합니다.

## 파일과 원본

| 파일 | 원본과 동작 |
| --- | --- |
| `my-video-app-extension-missav.zip` | `v1.19.4-missav.2`에서 게시·검증한 파일. 플레이어 스크립트와 실제 CDN 요청으로 HLS 주소를 추가 감지. **실제 사이트 다운로드는 미검증인 실험판** |
| `my-video-app-extension-standard.zip` | 같은 릴리즈의 일반판 파일. MissAV 전용 코드를 포함하지 않으며 원래 수집기·백그라운드 파일과 바이트가 일치하는 소스로 빌드됨 |
| `my-video-app-desktop-windows-x64.zip` | 정식 `v1.19.4`의 기존 파일. v1.18 다운로드 흐름과 실행 로그 유지. **Windows 앱에 MissAV 사이트 페이지 지원은 추가하지 않음** |
| `my-video-app-source.zip` | 이번 커밋의 소스와 문서. 설치 ZIP·캐시·Git 내부 데이터는 제외 |
| `my-video-app-antivirus-helper.zip` | 기존 선택적 백신 도우미. 양쪽 원본 릴리즈에서 동일한 파일 |

두 확장 ZIP 중 하나만 설치합니다. Windows 앱은 별도로 사용할 수 있습니다. 통합 릴리즈는 사전 배포로 표시하며, 기존 정식 Windows 릴리즈와 태그는 그대로 둡니다.

설치 파일은 재빌드하지 않고 기존 게시 파일을 재사용합니다. 이는 이번 작업에서 Windows 앱이나 다운로드 알고리즘을 바꾸지 않았기 때문입니다. 출처·파일별 해시·현재 소스 커밋은 통합 릴리즈의 `RELEASE-CONTENTS.json`에 기록합니다. `WINDOWS-VALIDATION.json`은 원래 Windows 빌드의 검사 기록이며 이번에 Windows 검사를 다시 수행한 기록이 아닙니다.

## 실제 대상 페이지 접속

사용자가 제공한 `missav123.com`의 개별 영상 페이지를 HTTP 클라이언트와 실제 Chromium으로 확인했습니다. [정확한 대상과 원시 결과](missav-site-access-2026-11-16.json)를 함께 보관합니다.

- TLS 검증을 유지한 상태에서 인증서 오류가 해소됐습니다. 최초 브라우저 오류는 읽기 전용 NSS 저장소의 초기화 실패(`SEC_ERROR_READ_ONLY`) 때문이었습니다.
- 지정한 페이지도 **Cloudflare HTTP 403 / 사람 확인 화면**을 반환했습니다. 정상 자동 확인을 추가로 30초 기다린 뒤에도 같은 상태였습니다.
- 영상 요소 0개, 관측된 미디어 응답 0개입니다. 실제 영상 감지·파일 다운로드의 성공 여부를 판단할 응답을 확보하지 못했습니다.
- CAPTCHA·접근 제한·DRM을 우회하지 않았고, 검증 성공으로 표시하지 않았습니다. 내부 클라우드 인증서 점검에 대한 사용자 승인은 받았으며 로컬 PC의 인증서 설정은 변경하지 않았습니다.

## 이번 검사

- `npm run typecheck`: 통과.
- `node --experimental-strip-types --test tests/missav.test.ts tests/missav-collector.test.ts tests/missav-build.test.ts`: **12개 통과**.
- 일반판 환경변수를 지정한 `tests/missav-build.test.ts`: **2개 통과**. 일반판 파일의 원본 바이트 일치와 빌드 진입점 분리를 확인했습니다.
- 두 확장 ZIP, Windows ZIP, 백신 도우미를 원본 릴리즈에서 재다운로드하여 원본 체크섬·GitHub 자산 SHA-256·파일 크기·ZIP CRC·경로·중복 항목을 확인했습니다.
- 두 확장의 수집 스크립트 해시가 서로 다른 것을 확인했습니다.
- Windows ZIP의 모든 파일을 `APPMANIFEST.json`과 대조하고, manifest의 소스 해시를 현재 체크아웃과 대조했습니다. 기존 Windows 검사 기록의 버전·원래 빌드 커밋·ZIP 해시도 일치합니다.
- 기존 전체 회귀 검사와 Windows 실행 검사는 반복하지 않았습니다. 확장 실설치는 클라우드 관리자 정책으로 수행하지 못했습니다.

## 재사용 설치 파일의 SHA-256

```text
27661e0176009248ec61263df25f17400c513395269a4981835d903975a43d6a  my-video-app-extension-missav.zip
70ebcc3a49788d8fd1c61263914b386b612e9253bd3d937c9d3dec3b6e776942  my-video-app-extension-standard.zip
2fb6e36bfc04068a3fe29ccaa6f08518de47ab1e67cd5be5448e419115d83768  my-video-app-desktop-windows-x64.zip
88818c9cc0ea443be213ac0c2c20cbeebf3796444026824ac3f9306aef55c959  my-video-app-antivirus-helper.zip
```

현재 소스 ZIP 및 기타 증거 파일의 해시는 릴리즈에 첨부하는 `SHA256SUMS-RELEASE.txt`를 기준으로 합니다. 환경 설정의 게시 작업은 수행하지 않습니다.
