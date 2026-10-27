# 데스크톱 HTTP/3·병렬 전송 조사

기준일: **2026-10-27 (KST)**. 대상은 Windows x64 데스크톱의 직접 HTTP(S) 미디어 전송이다. HTTP/3를 시도하되 HTTP/2·HTTP/1.1로 연결할 수 있는 네이티브 전송 계층과, 검증 가능한 파일에만 적용하는 제한된 Range 병렬 전송을 선택했다. HTTP/3 지원 여부, 실제 사용한 프로토콜, 여러 구간의 병렬 처리는 서로 다른 기능이다. 어느 조합도 모든 서버에서 더 빠르다는 실측 결과를 의미하지 않는다.

## 1. 실제 배포 파일과 HTTP/3 지원

공식 PyPI의 [curl_cffi 0.17.0 메타데이터](https://pypi.org/pypi/curl_cffi/0.17.0/json), [cffi 2.1.1](https://pypi.org/pypi/cffi/2.1.1/json), [certifi 2026.10.23](https://pypi.org/pypi/certifi/2026.10.23/json), [pycparser 3.12](https://pypi.org/pypi/pycparser/3.12/json)를 읽고 선택한 wheel의 실제 바이트·크기·SHA-256을 대조했다. Python 3.13 Windows x64용 선택은 다음과 같다.

| 패키지 | 선택한 배포 태그 | 압축 파일 크기 | 라이선스 메타데이터 |
| --- | --- | ---: | --- |
| curl_cffi 0.17.0 | `cp310-abi3-win_amd64` | 2,108,164 bytes | MIT |
| cffi 2.1.1 | `cp313-cp313-win_amd64` | 185,688 bytes | MIT-0 |
| certifi 2026.10.23 | `py3-none-any` | 135,082 bytes | MPL-2.0 |
| pycparser 3.12 | `py3-none-any` | 62,600 bytes | BSD-3-Clause |

이는 다운로드 압축 크기이며 설치 후 디스크·프로세스 메모리 증가량은 아니다. `curl_cffi`의 기본 의존성은 `cffi>=2.1.1`, `certifi>=2026.10.19`이며, CPython의 cffi는 pycparser를 요구한다. CLI·브라우저 지문·문서 변환용 extra는 필요하지 않다.

공식 [curl_cffi v0.17.0 빌드 소스](https://github.com/lexiforest/curl_cffi/blob/v0.17.0/scripts/build.py)는 upstream `curl-impersonate`를 **2.3.1**로 지정한다. wheel 안의 `curl_cffi.libs/libcurl-impersonate-ae864b926b0a86bfa3b18a664407a1ab.dll`과 공식 [v2.3.1 Windows x64 릴리스](https://github.com/lexiforest/curl-impersonate/releases/download/v2.3.1/libcurl-impersonate-v2.3.1.x86_64-win32.tar.gz)의 `lib/libcurl-impersonate.dll`을 비교해 **4,113,920 bytes 전체가 동일**함을 확인했다. DLL SHA-256은 `ae864b926b0a86bfa3b18a664407a1abb71c31a30c317d938f8c88537d044e45`다. 인접 버전 2.3.0으로 추정하지 않았다.

이 Windows DLL의 PE export·기계어·feature table을 읽었다. `curl_version_info` export RVA는 `0x818b0`, feature table RVA는 `0x305980`이다. `HTTP3` 항목은 `CURL_VERSION_HTTP3 = 0x02000000`이며 별도 조건 함수 없이 feature에 합쳐진다. 이는 **선택한 Windows 파일에 HTTP/3가 컴파일되어 있다는 정적 증거**다. Windows에서 DLL을 실행하거나 인터넷 HTTP/3 서버와 통신한 결과는 아니다. Linux wheel의 네이티브 버전 문자열에서도 `libcurl/8.23.0-IMPERSONATE`, ngtcp2·nghttp3를 확인했지만, Linux 결과를 Windows 실행 결과로 대체하지 않는다.

공식 [curl-impersonate v2.3.1 CMakeLists](https://github.com/lexiforest/curl-impersonate/blob/v2.3.1/CMakeLists.txt)는 curl 8.23.0, ngtcp2 1.20.0, nghttp3 1.15.0, nghttp2 1.63.0, Brotli 1.2.1, c-ares 1.34.9, zlib 1.3.1, zstd 1.5.7과 고정 BoringSSL 커밋을 지정한다. 이 출처는 바이너리와 일치하는 릴리스의 구성 근거이며 모든 플랫폼의 런타임 상태를 보장하지 않는다.

## 2. HTTP/3 시도·fallback·실제 프로토콜 표시

다음 세 원문을 함께 읽었다.

- [curl_cffi v0.17.0 `const.py`](https://github.com/lexiforest/curl_cffi/blob/v0.17.0/curl_cffi/const.py): `CurlHttpVersion.V3 = 30`은 “explicit HTTP/3 with fallback”, `V3ONLY = 31`은 “No fallback”이다.
- [curl_cffi 요청 옵션 구현](https://github.com/lexiforest/curl_cffi/blob/v0.17.0/curl_cffi/requests/utils.py): 전달받은 `http_version`을 정규화해 `CurlOpt.HTTP_VERSION`에 설정한다. Python API의 이름만으로 동작을 추정하지 않았다.
- [curl 8.23.0 `CURLOPT_HTTP_VERSION`](https://github.com/curl/curl/blob/curl-8_23_0/docs/libcurl/opts/CURLOPT_HTTP_VERSION.md): `CURL_HTTP_VERSION_3`은 URL 호스트에 HTTP/3를 시도하고 필요하면 이전 HTTP 버전으로 fallback한다. `3ONLY`는 이전 버전으로 내려가지 않는다. `2TLS`는 HTTPS에서 HTTP/2를 시도하고 HTTP/1.1로 fallback하며 평문 HTTP에는 1.1을 사용한다.

**적용:** HTTP/3가 켜져 있으면 `V3`, 꺼져 있으면 `V2TLS`를 설정한다. QUIC를 지원하지 않는 서버·UDP 경로·프록시 환경에서 HTTP/3만 강제하지 않는다. 이 fallback은 libcurl 내부의 연결 선택이며 파일 조각을 응용 프로그램에서 무조건 다시 내려받는 재시도와 구분한다. HTTP 버전 옵션은 요청이며 연결 재사용 시 다른 버전의 기존 연결을 사용할 수 있다는 curl 문서의 한계도 따른다.

프로토콜 표시는 옵션값이나 URL로 만들지 않는다. 공식 [`CURLINFO_HTTP_VERSION`](https://github.com/curl/curl/blob/curl-8_23_0/docs/libcurl/opts/CURLINFO_HTTP_VERSION.md)은 해당 handle의 전송에 사용한 HTTP 버전을 반환하며, 판단할 수 없으면 0이라고 명시한다. 실제 관측값만 `h3`, `h2`, `http/1.1`로 알리고 알 수 없는 값은 성공한 HTTP/3로 표시하지 않는다. 같은 파일의 서로 다른 요청이 다른 프로토콜을 쓸 수 있으므로 여러 관측값을 허용한다.

TLS 검증도 fallback과 분리한다. 공식 [`CURLOPT_SSL_VERIFYPEER`](https://github.com/curl/curl/blob/curl-8_23_0/docs/libcurl/opts/CURLOPT_SSL_VERIFYPEER.md)와 [`CURLOPT_SSL_VERIFYHOST`](https://github.com/curl/curl/blob/curl-8_23_0/docs/libcurl/opts/CURLOPT_SSL_VERIFYHOST.md)는 CA 체인 검증과 인증서 이름 검증이 서로 다른 검사임을 명시한다. 서버·HTTPS 프록시에 두 검사를 유지하고 지정한 CA 또는 신뢰 번들을 사용한다. CA 환경 설정과 상속된 프록시 경로를 사용하며 TLS 검증을 끄는 해결책을 채택하지 않는다. 패키지의 브라우저 impersonation 기능은 이 작업의 목적에 필요하지 않다.

## 3. 스트리밍 API만으로 메모리 상한이 생기지 않는 이유

[curl_cffi v0.17.0 동기 Session 구현](https://github.com/lexiforest/curl_cffi/blob/v0.17.0/curl_cffi/requests/session.py)은 streaming 경로에 `queue.Queue`를 넘기고, [옵션 구현](https://github.com/lexiforest/curl_cffi/blob/v0.17.0/curl_cffi/requests/utils.py)은 `queue_class()`를 만들고 받은 바이트를 `put_nowait`로 넣는다. 공식 [CPython 3.13 queue 문서](https://github.com/python/cpython/blob/v3.13.0/Doc/library/queue.rst)의 `Queue(maxsize=0)`는 크기 제한이 없다. 따라서 `stream=True`와 작은 소비 청크만으로 느린 디스크에서 생산자 버퍼까지 제한된다고 설명할 수 없다.

**적용:** `desktop/transport.py`는 저수준 Curl의 수신 콜백과 `Queue(maxsize=2)`를 사용하고 큐 항목을 최대 64 KiB로 나눈다. 큐가 차면 취소를 확인하면서 생산자가 기다린다. 공식 [`CURLOPT_WRITEFUNCTION`](https://github.com/curl/curl/blob/curl-8_23_0/docs/libcurl/opts/CURLOPT_WRITEFUNCTION.md)은 받은 바이트를 콜백에서 처리하고, 처리 길이가 다르면 전송 오류로 중단되는 계약을 명시한다. 이를 이용해 취소·닫힘 시 콜백을 끝내며, 파일 전체를 응답 객체에 축적하지 않는다.

전송 worker는 최대 4 MiB 구간 하나를 검증한 뒤 디스크에 기록한다. 파일 크기가 커져도 한 worker가 다음 조각들을 미리 저장하지 않는다. 디스크 쓰기 동안에도 네트워크 자원 예약을 보유해, 기록 중인 큰 버퍼를 상한 계산에서 빠뜨리지 않는다. 큐 128 KiB는 **그 큐의 payload 상한**이지 전체 RSS 상한이 아니다. 읽기·쓰기 복사, 헤더, Python 객체, libcurl·TLS·QUIC 내부 버퍼는 추가로 존재한다.

handle은 한 응답의 전용 스레드에서 사용하고 재사용 전후에 reset한다. 응답을 닫으면 그 응답만 취소하고 스레드를 회수한다. 공유 transport를 닫을 때는 자신이 소유한 스레드만 기다린다. 유한 큐·파일 worker·handle pool은 별도 상한이며 HTTP/2·HTTP/3 한 연결의 스트림 수와 동일한 숫자로 해석하지 않는다.

## 4. Range 병렬 전송의 동일 파일 검증

직접 읽은 표준은 HTTP Working Group의 [RFC 9110 원문 소스](https://github.com/httpwg/http-core/blob/main/rfc9110.xml)다. 관련 절은 §8.8 validator, §10.2.3 `Retry-After`, §13.1.1 `If-Match`, §13.1.5 `If-Range`, §14.2 `Range`, §14.4 `Content-Range`, §15.3.7.3 부분 결합이다.

- §14.2는 서버가 Range를 무시할 수 있다고 명시한다. `Accept-Ranges`나 파일 확장자만으로 병렬 전송을 확정하지 않는다.
- §13.1.1은 `If-Match`에 강한 ETag 비교를 요구하며, GET에도 사용할 수 있고 일치하지 않는 표현을 받는 대신 412를 원하는 구간 복구에 유용하다고 설명한다.
- §15.3.7.3은 여러 부분을 안전하게 결합하려면 같은 strong validator를 공유해야 한다고 명시한다. 약한 `W/` ETag를 동일 바이트의 증거로 사용하지 않는다.
- §14.4의 `Content-Range`는 시작·끝·전체 길이를 표현한다. 206 코드만 같다고 요청한 구간이 맞는 것은 아니다.

**적용:** 먼저 `Range: bytes=0-65535`와 `Accept-Encoding: identity`로 작은 실제 GET을 보낸다. 응답이 정상 200이면 같은 응답을 단일 전송으로 소비한다. 206이면 범위·실제 바이트 수·선언 길이를 검사한다. 전체 길이를 알고, 최소 8 MiB이고, 강한 ETag가 있고, 선택한 worker가 둘 이상일 때 최대 4개 worker로 나눈다. 조건이 부족하면 전체 파일 GET을 사용한다. 8 MiB·4 MiB·4개는 이 앱의 보수적인 정책이며 표준이 정한 최적값은 아니다.

후속 구간은 4 MiB 이하의 겹치지 않는 범위이며 `If-Match`와 `If-Range`에 최초 strong ETag를 전달한다. 각 응답의 206, 같은 ETag, 정확한 시작·끝·전체 길이, 일관된 최종 URL, 선언·실제 body 길이, identity encoding을 확인한다. 부분 전송 도중 200으로 바뀌거나 ETag·크기·범위가 달라지면 기존 조각과 섞지 않고 실패시킨다. 변경된 파일을 조용히 이어 붙이는 fallback은 하지 않는다. 최종 파일 게시 전에 별도 미디어 검증을 거치는 흐름은 전송 검증과 독립이다.

파일은 작업이 새로 소유한 경로를 배타적으로 생성하고, 실패·취소 시 자신이 만든 미완성 파일만 정리한다. 여러 worker가 도착 순서대로 각 오프셋에 쓰므로 전체 파일 크기의 메모리 결합은 필요 없다. Windows의 seek/write 구간은 잠금으로 보호한다.

## 5. 재시도·공정성·자원 예산

HTTP 표준의 `Retry-After`는 지연 초와 HTTP 날짜를 모두 허용한다. 이를 재시도 횟수를 늘리는 근거로 사용하지 않는다. 이 구현은 일시 네트워크 오류와 408·429·5xx에 요청당 최대 세 번 시도하고, 일반 오류에는 지수 대기와 작은 jitter를 사용한다. 유효한 `Retry-After`가 5초 이내면 지시한 시간만큼 기다린다. 더 긴 지시는 5초로 잘라 조기 재요청하지 않고 현재 작업을 종료해 나중에 재시도하도록 알린다. 취소는 대기 중에도 확인한다.

이미 디스크에 반영한 단일 전송을 처음부터 자동 반복하지 않는다. 구간은 body 전체가 검증되고 기록되기 전의 일시 오류만 같은 범위로 재시도한다. 범위·validator·인코딩·길이 불일치 같은 데이터 오류는 네트워크 오류로 바꿔 반복하지 않는다. 서버별·파일별 최적 재시도 정책을 실험으로 구했다는 뜻은 아니다.

프로세스 공유 `NETWORK_BUDGET = 16`에 직접 HTTP 요청도 각각 가중치 1을 예약한다. probe·단일 전송·각 구간은 같은 예산을 사용하며 응답 소비와 디스크 반영이 끝나야 반환한다. 재시도 대기에는 예약을 반환한다. 따라서 같은 프로세스의 여러 Engine과 기존 조각 다운로드가 서로 다른 제한을 사용해 합계가 무제한 증가하는 것을 막는다. 실제 소켓 수·DNS·리다이렉트 횟수를 관측한 전역 연결 16개라는 의미는 아니다.

기존 [동시 실행 조사](DESKTOP_CONCURRENCY_RESEARCH.ko.md)가 직접 확인한 SEDA의 단계별 유한 자원·역압 원칙과 Go weighted semaphore의 FIFO·starvation 방지 원칙을 유지한다. 단계 gate는 FIFO이며, GUI는 현재 실행 수가 적은 원본 사이트를 우선하고 같은 경우 먼저 대기한 작업을 선택한다. 새 직접 전송 요청도 기존 gate를 공유한다. 이는 **자원 수용과 작업 시작의 공정성**이며 사이트별 바이트·대역폭·완료 시간을 같게 보장하지 않는다. 예산 16과 worker 4는 측정한 최적값이 아니다.

## 6. Chrome 확장과 데스크톱의 경계

공식 [GoogleChrome/chrome-types 설명](https://github.com/GoogleChrome/chrome-types/blob/main/README.md)은 Chromium의 내부 IDL·JSON에서 생성한 타입을 npm으로 매일 배포하며 Chrome 개발자 사이트에도 사용한다고 밝힌다. 그 공식 배포본 [chrome-types 0.1.459](https://registry.npmjs.org/chrome-types/-/chrome-types-0.1.459.tgz)의 `downloads.DownloadOptions`와 `downloads.download`를 직접 읽었다. 옵션은 URL·파일명·충돌 정책·저장 대화상자·HTTP method·headers·body이며 HTTP 버전이나 QUIC 강제 선택 항목이 없다. [공식 downloads 문서 소스](https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/extensions/reference/downloads/index.md)와 Google의 다운로드 예제도 확인했다.

확장의 `src/local/background.ts`는 브라우저 저장에 `chrome.downloads.download`를 사용하고, `src/local/parallel-download.ts`는 Fetch로 구간을 요청한다. 이 경로의 네트워크 연결·HTTP 프로토콜 선택은 Chrome 네트워크 스택이 관리한다. 확장에서 데스크톱의 CurlHttpVersion 옵션을 적용할 수 없고, 확장 API에 HTTP/3 스위치를 추가했다고 설명할 수도 없다. 브라우저가 어떤 요청에서 실제로 h3를 썼다는 보장은 이 API 정의나 네이티브 DLL 지원만으로 얻을 수 없다.

이번 네이티브 전송 설정의 범위는 데스크톱 직접 미디어 다운로드다. yt-dlp 추출기·HLS/DASH·FFmpeg의 모든 네트워크 동작까지 HTTP/3로 바꾸는 기능으로 소개하지 않는다.

## 7. 재배포 고지와 확인 한계

Python wheel의 dist-info license만 모으면 네이티브 DLL 구성 요소 고지가 빠질 수 있다. 공식 [curl-impersonate 라이선스 수집 스크립트](https://github.com/lexiforest/curl-impersonate/blob/v2.3.1/cmake/CollectLicenses.cmake.in)와 [Windows 릴리스 구성](https://github.com/lexiforest/curl-impersonate/blob/v2.3.1/.github/workflows/build-win.yaml)을 확인하고, 위에서 DLL이 완전히 일치한 **v2.3.1 archive 자체**에서 다음 원문 파일을 확보했다.

`LICENSE`, `LICENSE_BORINGSSL`, `LICENSE_BROTLI`, `LICENSE_CARES`, `LICENSE_CURL`, `LICENSE_NGHTTP2`, `LICENSE_NGHTTP3`, `LICENSE_NGTCP2`, `LICENSE_ZLIB`, `LICENSE_ZSTD`.

해당 archive는 7,114,105 bytes이고 SHA-256은 `22753b8eaeb2d69fa4272e0b8282106e6d411195e6515399a21767c26750a64c`다. 원문을 요약 라이선스 이름으로 대체하지 않는다. 개별 고지의 URL·archive member·바이트 수·SHA-256과 wheel DLL 일치 증거를 잠금 자료에 남겼다. 프로젝트의 배포 고지는 [licenses/desktop-transport](../licenses/desktop-transport/)에, 패키지와 고지의 고정 정보는 [desktop/dependencies-lock.json](../desktop/dependencies-lock.json)에 둔다. cffi는 MIT-0, certifi는 MPL-2.0이므로 모두 MIT로 표기하지 않는다.

조사에서는 공식 소스·PyPI 메타데이터·wheel·release archive·DLL 정적 구조를 확인했다. 이 담당 작업에서 기존 테스트, 전체 빌드, 게시, 실제 미디어 다운로드, 인터넷 HTTP/3 속도 벤치마크를 실행하지 않았다. 별도 기능 테스트 결과는 구현 검증 자료에서 다뤄야 하며 이 문서의 소스 조사와 혼동하지 않는다. 특히 Windows 실제 실행과 UDP 환경에서의 h3 협상은 바이너리 정적 지원만으로 검증되지 않는다.

공개 원문은 상속된 프록시와 CA 신뢰를 유지해 허용된 GitHub·PyPI·npm 경로로 확보했다. 일부 Chromium 대형 저장소 원문은 HTTP 429여서, 공식 GoogleChrome 저장소가 명시한 자체 npm 배포 타입으로 API 범위를 확인했다. 프록시 우회·TLS 검증 해제·자격 증명 출력은 사용하지 않았다.
