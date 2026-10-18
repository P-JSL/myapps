# My Video App · 개인용 로컬 버전

My Video App 1.4.0은 **앱 계정·구독·활성화 서버가 없는 독립 TypeScript 확장**입니다.
미디어 감지, 일반 파일 다운로드, 비암호화 HLS/DASH VOD 저장, 로컬 기록과
다운로드 후 선택적 2x/4x 업스케일링을 제공합니다. 파일과 기록은 브라우저에 저장합니다.
1.2.0에서는 **최고화질·해상도 선택, MP3/M4A 오디오 다운로드, 영상/음성 변환,
별도 영상·음성 병합**을 추가했습니다. 과금에 따른 사용 횟수·대기시간 제한은 없습니다.
1.3.0은 HTTP/3 연결 관측, 다운로드 준비 대기열, 조각 병렬 전송, 일시 오류 재시도와 진행 표시를 제공합니다.
1.4.0은 **로컬 백신 자동 검사와 위험·미검사 파일 확인창**, Chrome 다운로드 경고 연동을 추가했습니다.
백신 도우미와 로컬 백신을 한 번 설치하고 앱에서 연결 권한을 허용해야 합니다.

- [설치용 ZIP](artifacts/my-video-app-extension.zip)
- [전체 소스 ZIP](artifacts/my-video-app-source.zip)
- [로컬 백신 도우미 ZIP](artifacts/my-video-app-antivirus-helper.zip) · [설치·검사 안내](reports/SECURITY_DOWNLOADS.ko.md)
- [지원 범위와 한계](reports/LOCAL_MODE.ko.md)
- [새 로컬 기능과 사용법](reports/FEATURES.ko.md)
- [다운로드 개선·HTTP/3 사용 및 검증](reports/DOWNLOADS_HTTP3.ko.md)
- [검증 결과](reports/VALIDATION.ko.md) · [보안 검토](reports/SECURITY.ko.md)

## 설치

1. 설치용 ZIP을 내려받아 압축을 해제합니다.
2. Chrome의 `chrome://extensions`에서 개발자 모드를 켭니다.
3. **압축 해제된 확장 프로그램 로드**를 누르고 `manifest.json`이 있는 `my-video-app` 폴더를 선택합니다.
4. 영상 페이지를 새로고침한 뒤 재생하고 확장 아이콘을 누릅니다.
5. [백신 연결 안내](reports/SECURITY_DOWNLOADS.ko.md)에 따라 도우미·백신을 설치하고 앱에서 **로컬 백신 연결**을 누릅니다.

소스에서 빌드했다면 `dist` 폴더를 선택합니다. 기존 원본 확장의 공개 key를 사용하지
않으므로 이전 버전과 확장 ID·저장소가 다르며 기록이 새로 시작됩니다.
`vdh-typescript-upscale-*.zip` 경로는 같은 최신 파일을 제공하는 호환 별칭입니다.

## 사용

- **미디어**에서 현재 탭의 영상/오디오를 선택하고 **다운로드**를 누릅니다.
- 직접 MP4/WebM 등의 주소나 지원하는 HLS/DASH VOD 목록을 입력할 수도 있습니다.
- **스트림 화질**에서 최고/2160/1080/720/480을, **저장 형식**에서 영상·음성 또는
  MP3/M4A 오디오만 저장을 선택합니다. 화질은 목록에 제공된 실제 트랙을 선택합니다.
- **기록**에서 진행 상태·취소·저장 폴더를 확인합니다. 기록 삭제는 저장 파일을 삭제하지 않습니다.
  실패/취소 항목의 **다시 시도**로 같은 주소·옵션을 다시 요청할 수 있습니다.
- HTTPS는 Chrome이 HTTP/3·HTTP/2 등을 자동 협상합니다. 실제 관측값이 있으면
  **페이지 연결/준비 연결**에 표시합니다. 서버·UDP·프록시·브라우저 설정이 HTTP/3를 허용해야 합니다.
- 전송 완료 후 로컬 백신으로 검사합니다. 위협 탐지·검사 실패 시 삭제·재검사·유지 여부를 묻습니다.
  파일은 디스크에 먼저 저장되며 검사 전 열지 마세요. Chrome 경고는 Chrome 화면에서 검토합니다.
- 완료 알림의 **업스케일링 선택** 또는 상단 **미디어 도구**에서 별도의 확대본을 만듭니다.
- **미디어 도구 → 작업 선택**에서 MP4/WebM/MKV 영상 변환, MP3/M4A/WAV 오디오
  추출·변환, MP4/MKV 영상·음성 병합을 실행합니다. 병합은 별도 음성 파일도 선택합니다.
  결과는 **결과 저장**으로 내려받습니다. 영상 변환은 첫 영상·첫 음성 트랙을 사용합니다.
  병합은 영상 트랙을 복사하고 선택한 음성을 AAC로 변환하여 짧은 트랙 길이까지 저장합니다.
- PNG/JPEG/WebP와 지원 영상은 Lanczos 2x/4x 보간으로 확대합니다. AI 복원은 아닙니다.
  결과는 PNG 또는 MP4(H.264/AAC)이며 원본 다운로드 파일은 그대로 유지합니다.

앱 로그인이나 구독 인증은 없습니다. 다운로드할 미디어 사이트 자체의 정상적인 접근
권한과 브라우저 세션은 필요할 수 있습니다. 사용자 선택 전의 미디어 수집은 추가
파일 요청을 하지 않습니다. 제품 계정·광고·분석·원격 규칙 서버와 통신하지 않습니다.

## 호환 범위

일반 HTTP(S) 미디어와 **암호화되지 않은 완료형 HLS/정적 단일 Period DASH**를 지원합니다.
HLS의 외부 오디오·초기화 조각·바이트 범위와 DASH의 일반적인
SegmentTemplate/SegmentTimeline/SegmentList/BaseURL을 처리합니다.
스트림은 로컬 FFmpeg Wasm에서 코덱 복사 방식으로 MP4로 합칩니다.

이 버전은 기존 배포 엔진의 모든 사이트 동작을 복제한 제품이 아닙니다.
사이트별 전용 추출기, YouTube 전용 서명 처리, DRM/암호화 스트림, 라이브 녹화,
여러 Period DASH, 자막·첨부·모든 메타데이터 보존은 지원하지 않습니다.
기존 유료 기능을 활성화하거나 라이선스 검증을 성공으로 위조하지 않습니다.

스트림은 총 입력 128MiB·출력 약 128MiB 미만·4,096조각·5분 준비 한도가 있습니다.
일반 대용량 파일은 브라우저 직접 다운로드를 사용합니다. 오디오 다운로드는 128MiB
입력 한도가 있으며 실패 시 영상 파일로 대체 저장하지 않습니다. 준비/다운로드는 동시에
최대 8개이며 진행 중인 같은 주소의 중복 요청을 방지합니다.
파일 준비에 실패하거나 파일이 크면 일반 파일은 직접 다운로드로 전환합니다.
이 경우 자동 확대용 복사본이 없을 수 있으며 저장 파일을 직접 선택하면 됩니다.

확대용 임시 복사본은 파일당 256MiB·총 512MiB·4개·24시간(다음 사용 시 정리)입니다.
시크릿 다운로드는 확대 큐와 지속 기록에 보관하지 않습니다. 옵션에서 복사본을 삭제하거나
완료 알림 기능을 끌 수 있습니다. 영상 확대는 최대 10분, 결과 16,777,216픽셀·한 변
8,192픽셀, 처리 최대 5분이며 실행 중에는 작업 탭을 열어 두어야 합니다.
영상/오디오 변환·병합도 최대 10분·5분 처리, 입력/출력 각각 256MiB 한도를 적용합니다.
병합 입력은 두 파일 크기를 합산합니다. WebM 출력은 VP8/Opus입니다.

## 개발

Node.js 24 이상, npm, 브라우저 검증용 Chromium·FFmpeg/ffprobe가 필요합니다.

```sh
npm ci --ignore-scripts --cache /tmp/my-video-app-npm-cache
npm run verify
python3 -m venv /workspace/.cache/my-video-app-http3
/workspace/.cache/my-video-app-http3/bin/python -m pip install -r tests/requirements-http3.txt
HTTP3_PYTHON=/workspace/.cache/my-video-app-http3/bin/python npm run test:http3
npm run package
```

`CHROMIUM_PATH`로 Chromium 경로를 지정할 수 있습니다.
HTTP/3 검사는 Linux Chromium 154·OpenSSL·Python venv/aioquic를 사용하며 별도 임시
프로필과 로컬 서버를 만들고 정리합니다. 제품의 자동 협상과 구분되는 시험 조건은 위 문서를 참고하세요.
`src/local`은 감지·다운로드·기록·목록 파서, `src/upscale`은 확대와 큐,
`src/security`는 공통 입력 검증입니다. `src/ui`는 업스케일링 화면입니다.
원본의 계정/구독 엔진과 불필요한 사이트 전용 코드는 현재 프로젝트에서 제거했습니다.
이전 버전과 원본 자료는 Git 이력 `806ef92`에 남아 있습니다.

클라우드 Chromium의 관리자 정책은 unpacked 확장 설치를 거부합니다. 이를 우회하지
않았습니다. 브라우저 하네스는 실제 Chromium·Worker·Wasm·OPFS·다운로드 결과를
검증하고 Chrome 확장 API 부분만 테스트 대역을 사용합니다. 설치 후 실제 알림·서비스
워커 수명·사이트별 접근 검증은 정책이 허용된 Chrome 프로필에서 추가로 필요합니다.

사용 라이브러리와 제공된 이미지의 저작권 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 있습니다.
