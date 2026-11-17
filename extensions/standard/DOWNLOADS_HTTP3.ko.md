# My Video App 1.13.0 · 다운로드와 HTTP/3

HTTP/3도 `https://` 주소를 사용한다. 앱의 fetch와 Chrome 다운로드 API는 브라우저의
네트워크 스택을 사용한다. Chrome·서버·인증서·UDP 경로·프록시 정책이 허용하면 HTTP/3로
전송하며, 연결 방식과 HTTP/2·HTTP/1.1 대체 연결은 Chrome이 선택한다. 앱에서 별도의
QUIC 클라이언트를 설치하거나 `h3://` 주소를 만들지 않는다. 모든 사이트의 HTTP/3 사용을
보장하거나 제품에서 강제하지 않는다. 기존 HTTP(S) 권한 외의 새 확장 권한도 없다.

**페이지 연결**은 페이지 Resource Timing의 실제 ALPN 관측값이다. **준비 연결**은 앱이
파일/조각을 가져올 때 관측한 연결 방식이다. 준비한 blob 파일을 브라우저에 저장하는
마지막 작업의 네트워크 프로토콜을 뜻하지는 않는다. 정보가 공개되지 않으면 표시하지
않으며, HTTPS 주소나 Alt-Svc 광고만으로 HTTP/3라고 표시하지 않는다.
Chrome 개발자 도구의 Network → Protocol에서도 `h3`를 확인할 수 있다.

## 다운로드 개선

- 최대 8개 준비 대기열을 두고 무거운 준비 작업은 한 번에 하나로 처리한다. 두 번째
  요청이 즉시 busy 오류로 실패하던 동작을 개선했다. 대기 취소는 파일 요청을 시작하지
  않으며 진행 중 취소는 Worker와 요청을 중단한다.
- 일반 원본 파일은 정확한 206 범위·총길이와 강한 ETag를 확인하면 4MiB 구간을 최대 4개 병렬 전송하고 OPFS의 원래 위치에 기록한다. 구간·크기·ETag·최종 URL이 바뀌면 조각을 합쳐 성공으로 처리하지 않는다. 구간 지원이나 안전한 파일 버전 식별자가 없으면 한 번의 순차 응답을 디스크에 기록한다.
- HLS/DASH 원본은 최대 4개 자산을 병렬 전송하고 OPFS 컨테이너의 위치 색인으로 원래 파일명·트랙 순서를 유지한다. FFmpeg는 디스크 기반 파일 시스템에서 입력을 읽고 MP4를 기록한다. 원본 다운로드의 128MiB·전체 5분 제한은 적용하지 않으며 저장 공간·브라우저 주소 범위·목록 8MiB/100,000개 자산 분석 예산을 적용한다.
- HTTP/2·HTTP/3 다중 스트림도 브라우저가 사용할 수 있다. 병렬 연결 수는 속도 향상 배수가 아니며 서버·네트워크·디스크 조건에 따라 달라진다. 구조·공간·검사 조건은 LARGE_DOWNLOADS.ko.md를 참고한다.
- GET 요청의 일시적 네트워크 오류·시간 초과 및 408/425/429/500/502/503/504는
  최대 3회 요청한다. Retry-After의 초/날짜를 해석하며 5초보다 긴 대기를 요구하면
  조기 재요청하지 않고 나중에 시도하라는 오류를 표시한다. 403/404 등은 반복하지 않는다.
  재시도 대기 중에도 취소할 수 있다. 원본의 네트워크 요청은 응답 정지 시간을 감시하며, 정상적으로 진행 중인 긴 전송을 고정 전체 시간만으로 중단하지 않는다. 실패 시도 데이터는 성공 자산으로 등록하지 않는다.
- 전체 파일 요청에 뜻하지 않은 206이 오거나, 범위·길이가 잘못되거나, 빈 응답·용량
  초과가 발생하면 거부한다. 압축된 바이트 범위도 거부한다. 원본 일반 파일의 첫 Range를 무시한 200 응답은 순차 저장으로 사용하며, 이미 시작한 병렬 구간·스트림 바이트 범위에 잘못된 200 응답이 오면 성공 조각으로 사용하지 않는다. 오디오 변환의 기존 메모리 경로는 한도 안에서 부분 추출 동작을 유지한다.
- 기록에 대기/받기/합치기/저장 단계와 제공되는 진행률·브라우저 수신량을 표시한다.
  실패·취소의 **다시 시도**는 같은 주소와 옵션으로 새 다운로드를 시작한다.
- DOM 관측이 기존 HLS/DASH 판정을 일반 파일로 바꾸지 않도록 병합하고,
  206 응답의 조각 크기를 전체 파일 크기로 오인하지 않도록 총길이를 사용한다.

오디오 다운로드 변환은 기존 128MiB/4,096조각/5분 준비 경로를 사용한다. 별도의 로컬 업스케일링·변환·병합 자원/시간 한도도 유지한다.
만료된 주소·사이트 로그인·암호화/DRM·라이브 등의 지원 한계도 동일하다.

## 검증과 재실행

`npm run verify`는 단위 검사와 실제 Chromium/미디어/Wasm/OPFS 하네스를 실행한다. 현재 통과 수·빌드 식별자는 `browser.json`, `release-validation.json`, 대용량 시나리오의 범위는 `large-download.json`을 기준으로 확인한다. 과거 1.3.0의 검사 수를 현재 결과로 사용하지 않는다.
Chrome 확장 API는 테스트 대역이며 관리자 정책 때문에 실제 unpacked 확장 설치는 미검증이다.

별도 `npm run test:http3`는 실제 HTTP/3로 다음 4개 검사를 수행한다.

1. 신뢰 설정 전 시험 CA가 Chrome의 정상 인증서 검증에서 거부된다.
2. 시험 CA 설정 후 실제 h3 연결로 받은 MP4의 SHA-256이 원본과 같다.
3. 실제 HTTP/3 Range 응답의 바이트가 정확하다.
4. 실제 HTTP/3 HLS 조각을 앱의 로컬 Wasm으로 저장하고 영상·음성을 전체 디코드한다.

HTTP/3 시험은 루프백 경로를 확정적으로 선택하기 위해 **시험 브라우저에만**
`--origin-to-force-quic-on=127.0.0.1:<임시 포트>`를 지정한다. 제품에는 이 플래그가 없다.
이 검사는 HTTP/3 전송 경로의 동작을 확인하며 공개 사이트의 자동 협상 전체를 검증한
것은 아니다. TLS 오류 무시는 사용하지 않는다. 생성한 1일 시험 CA는 폐기할 프로필의
사용자 신뢰 DB에만 설정하고 서버·프로필·개인키는 검사 후 정리한다. OS나 기존 사용자
프로필은 바꾸지 않는다. 시험 신뢰 DB는 Linux Chromium 154의 CertificateMetadata
형식에 맞추며 다른 스키마에서는 실패한다. 결과/빌드 해시는 `reports/http3.json`에 있다.

```sh
python3 -m venv /workspace/.cache/my-video-app-http3
/workspace/.cache/my-video-app-http3/bin/python -m pip install -r tests/requirements-http3.txt
npm run verify
HTTP3_PYTHON=/workspace/.cache/my-video-app-http3/bin/python npm run test:http3
npm run package
```

추가 시험에는 OpenSSL, Python venv, `aioquic==1.3.0`이 필요하다. 브라우저와 HTTP/3
보고서가 현재 설치 빌드의 해시와 일치해야 패키지를 만들 수 있다.

참고: [nextHopProtocol](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming/nextHopProtocol),
[Chrome downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads),
[Chromium 시험 프로필 메타데이터](https://github.com/chromium/chromium/blob/main/components/server_certificate_database/server_certificate_database.proto).
