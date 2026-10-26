# 데스크톱 동시 다운로드 확장 근거

확인일: **2026-10-26 (KST)**. 대상: My Video App의 `desktop/main.py`, `desktop/engine.py`, `desktop/concurrency.py`.

동시 실행 개수, 한 동영상의 조각 병렬도, 미디어 처리 개수를 따로 제한한다. 자동 설정은 2–4개, 수동 설정은 1–16개를 제공하되, 같은 원본 사이트는 기본 4개로 제한한다. 아래 숫자는 논문에서 도출한 최적값이 아니라 이 앱에 적용하는 보수적인 정책값이다. 인터넷 처리량이나 완료 시간 개선을 실측했다는 의미가 아니다.

## 1. 기존 제한과 변경의 의미

조사 시작 시 UI는 저장된 동시 실행 값을 최대 2로 제한하고, `QThreadPool`도 2개였다. 엔진은 작업 전체에 세마포어 3개를 적용했으며, yt-dlp의 `concurrent_fragment_downloads`는 이미 4였다. 따라서 설정 목록만 늘리면 UI 스레드풀 또는 엔진의 기존 상한에 다시 막히고, 상한만 모두 늘리면 조각 다운로드·추출기·FFmpeg가 함께 증가한다.

이 보고서가 뒷받침하는 설계는 다음과 같다.

| 자원 | 적용 정책 | 목적과 범위 |
| --- | --- | --- |
| 사용자 작업 | 자동 2–4개, 수동 1–16개 | 대기 작업을 포함한 전체 목록 길이가 아니라 실행 중인 작업 수 제한 |
| 자동 값 | `max(2, min(4, CPU수 // 2))` | CPU 수는 보수적 초기 선택의 참고값이며 네트워크·디스크 성능 추정값은 아님 |
| 같은 원본 사이트 | 별도 설정 1–16개, 기본 4개 | 실제 상한은 전체 작업 설정과 사이트 설정 중 작은 값 |
| 프로세스 전체 작업 | 최대 16개 | 같은 Python 프로세스의 여러 `Engine` 인스턴스도 공유 |
| 메타데이터·의존성 확인 | 최대 2개 | YouTube 추출기와 Deno 시작의 동시 증가 억제 |
| 네트워크 가중치 | 합계 최대 16 | 전송 중인 작업별 예약 가중치의 합계를 제한 |
| 조각 병렬도 | `F = max(1, min(4, 16 // C))` | `C`는 해당 설정의 유효 전체 작업 수; 일반 직접 전송은 가중치 1 |
| 실제 미디어 처리·검증 | 최대 2개 | 변환·병합 및 미디어 `ffprobe` 실행의 경합 억제 |
| FFmpeg 스레드 옵션 | `-threads 2` | 적용 가능한 FFmpeg 작업의 스레드 수 옵션; 전체 자식 프로세스 스레드 수의 강제 상한은 아님 |
| 다운로드 후 검사 | 최대 1개 | Defender 호출의 중복 실행 억제 |

조각 전송은 해당 트랙의 전송 직전에 `F`만큼을 **한 번에** 예약한다. 부분 예약을 여러 번 쌓아 나머지 토큰을 기다리는 방식은 사용하지 않는다. `C=1, 2, 4`에서는 `F=4`, `C=8`에서는 `F=2`, `C=16`에서는 `F=1`이다. 설정 변경으로 기존 작업과 새 작업의 `F`가 달라도 공유 예산 16이 합계를 제한한다.

네트워크 예산은 yt-dlp에 허용한 조각 병렬도의 예약 합계이다. 연결 풀·리다이렉트·추출기 요청·CDN별 소켓 수를 직접 측정한 전역 연결 제한은 아니다. FFmpeg/ffprobe의 **버전 확인**은 메타데이터 단계에 속하므로, 미디어 처리 예산 2를 모든 종류의 자식 프로세스 합계 2로 해석해서도 안 된다.

## 2. 직접 확인한 논문 두 편

두 논문의 PDF를 **저자 Matt Welsh 본인의 공개 웹사이트 저장소**에서 확보하고 관련 절을 직접 확인했다. [해당 디렉터리 설명](https://github.com/mdwelsh/mdwelsh.github.io/blob/afe3ea0a0790868616a100923abe9ec9955900a7/astro/public/papers/README.md)은 “papers published by Matt Welsh”라고 명시한다. [저자 출판 목록](https://github.com/mdwelsh/mdwelsh.github.io/blob/afe3ea0a0790868616a100923abe9ec9955900a7/astro/src/content/pages/pubs.md)도 두 논문의 제목·저자·학회를 확인해 준다. 확인일은 모두 2026-10-26이다.

### 논문 1: SEDA — 단계와 명시적인 자원 경계

Matt Welsh, David Culler, Eric Brewer, **“SEDA: An Architecture for Well-Conditioned, Scalable Internet Services”**, SOSP 2001. [저자 제공 PDF](https://github.com/mdwelsh/mdwelsh.github.io/blob/afe3ea0a0790868616a100923abe9ec9955900a7/astro/public/papers/seda-sosp01.pdf), [ACM DOI](https://dl.acm.org/doi/10.1145/502034.502057).

- PDF p.1 초록은 “network of event-driven stages connected by explicit queues”와 자원 과다 할당 방지를 설명한다.
- §3.2, pp.4–5는 각 stage를 event handler·incoming queue·thread pool로 나누고, 단계마다 적은 수의 스레드를 사용하는 구조를 설명한다.
- p.5는 유한 큐의 삽입이 실패할 때 “backpressure (by blocking on a full queue)” 또는 load shedding을 선택할 수 있다고 명시한다.
- §3.4, p.6는 단계별 **관측한 성능과 수요**에 따라 자원을 조정하는 controller를 설명한다.

**적용:** 메타데이터·전송·미디어 처리·검사를 별도 예산으로 제한하고, 다음 단계를 기다릴 때 이전 단계 자원을 반환한다. **제외:** 미디어 조각을 버리는 load shedding, 앱 전체의 SEDA 이벤트 기반 재작성, 측정 없이 동적 controller를 복사하는 방법. 논문의 HTTP 서버·Gnutella 실험은 이 앱의 다운로드 처리량 실측으로 전용하지 않는다.

### 논문 2: Adaptive Overload Control — 측정·목표·튜닝의 필요

Matt Welsh, David Culler, **“Adaptive Overload Control for Busy Internet Servers”**, 4th USENIX Conference on Internet Technologies and Systems, USITS'03, March 2003. [저자 제공 PDF](https://github.com/mdwelsh/mdwelsh.github.io/blob/afe3ea0a0790868616a100923abe9ec9955900a7/astro/public/papers/control-usits03.pdf).

- §2.3, pp.3–4는 병목 stage에 집중한 admission control과 역압을 설명한다. 큐 삽입 실패가 반드시 사용자 요청의 폐기를 의미하는 것은 아니며, upstream에서 기다리는 선택도 가능하다.
- §3.1–3.2, pp.4–5는 **90백분위 응답 시간 목표**, 실제 요청 응답 시간 기록, EWMA 평활화, token-bucket admission rate의 additive increase/multiplicative decrease를 결합한다.
- p.5는 controller 매개변수가 실험을 통해 정해졌다고 밝히고, “there are no guarantees that they are optimal”이라고 한계를 명시한다.

**적용:** 진행 중인 자원을 제한하고 대기 상태를 사용자에게 표시한다. 제한 16·메타데이터 2·처리 2·검사 1은 이 앱의 초기 정책이며 논문에서 계산한 최적값으로 소개하지 않는다. **제외:** 파일 크기와 변환 시간이 다른 영상의 총 완료 시간을 그대로 응답 시간 표본으로 넣는 자동 제어. 이 앱에는 논문 수준의 서비스 목표·동질적인 표본·실험 튜닝이 없으므로 고정 상한과 수동 조절을 먼저 제공한다.

참고로 Little의 **“A Proof for the Queuing Formula: L = λW”** (Operations Research 9(3), 383–387, 1961, [DOI](https://doi.org/10.1287/opre.9.3.383))는 Netflix 공식 문서가 소개하는 관련 기초 연구다. 이 논문의 전문은 이번에 확인하지 않았고 위 두 편의 직접 확인한 논문에 포함하지 않는다. Little의 법칙만으로 다운로드의 최적 동시 실행 수를 정할 수 없다.

처음 요청한 ACM DOI 호스트와 SOSP PDF 호스트는 구성된 프록시에서 `403 Forbidden`으로 차단되었다. 이후 허용된 GitHub에서 저자 자신의 원본 배포본을 찾았다. 프록시 우회·TLS 검증 해제·제3자 복제본을 사용하지 않았다. 논문 실험을 재현하지 않았으며, 위 인용 범위의 설계 원칙만 적용한다.

## 3. 직접 확인한 기초 기술 자료

아래 링크는 모두 2026-10-26에 실제로 읽었다. SEDA는 확인한 커밋으로 고정했고, 나머지 upstream 브랜치 링크는 이후 변경될 수 있다.

### SEDA 저자 구현: 단계별 자원 제어

- [공식 저자 저장소 설명](https://github.com/mdwelsh/seda/blob/249d897ca1a356097f4150d4a8db17ae72ac1076/seda/docs/index.html): “stages connected by queues”, “preventing resources from being overcommitted when demand exceeds service capacity”.
- [Sandstorm 사용 문서](https://github.com/mdwelsh/seda/blob/249d897ca1a356097f4150d4a8db17ae72ac1076/seda/docs/sandstorm.html): 가득 찬 큐의 삽입 실패와 `enqueue_lossy`의 버림 동작을 설명한다.
- [ThreadPoolController](https://github.com/mdwelsh/seda/blob/249d897ca1a356097f4150d4a8db17ae72ac1076/seda/src/seda/sandStorm/internal/ThreadPoolController.java): 단계별 큐 크기·처리량을 관찰하고 스레드풀 크기를 조절하는 실제 코드다.
- [QueueThresholdPredicate](https://github.com/mdwelsh/seda/blob/249d897ca1a356097f4150d4a8db17ae72ac1076/seda/src/seda/sandStorm/core/QueueThresholdPredicate.java): `sink.size() + 1 > threshold`일 때 새 항목 수용을 거부한다.

**적용 판단:** 네트워크를 기다리는 작업과 CPU·디스크를 사용하는 작업을 같은 전체 상한만으로 제어하지 않고, 메타데이터·전송·처리·검사에 독립 예산을 둔다. 현재 변경은 동기식 작업 내부의 단계별 게이트이며, 전체 앱을 SEDA 이벤트 파이프라인으로 재작성한 것은 아니다. 다운로드 요청이나 미디어 조각을 조용히 버리는 `enqueue_lossy` 동작은 적용하지 않는다. 자동 스레드풀 제어기도 측정 근거 없이 복사하지 않는다.

### Go 공식 weighted semaphore: 취소와 공정성

- [Go Authors `golang.org/x/sync/semaphore`](https://github.com/golang/sync/blob/master/semaphore/semaphore.go).
- `Weighted`는 “bound concurrent access to a resource”를 제공한다. `Acquire`는 자원 확보 또는 취소를 기다리며, 실패 시 “leaves the semaphore unchanged”를 보장한다.
- `notifyWaiters`는 뒤의 작은 요청을 먼저 처리하면 큰 요청에 “starvation”이 생길 수 있으므로 앞의 요청을 기다리는 이유를 실제 코드 주석으로 설명한다.

**적용 판단:** 가중치 예약은 원자적으로 처리하고, 성공·실패·취소 시 반드시 반환한다. FIFO 대기열과 취소된 대기자의 제거로 오래 기다린 큰 요청의 기아를 줄인다. FIFO는 앞의 큰 요청 때문에 남은 자원이 잠깐 놀 수 있는 절충이다. 이는 의도적인 공정성 선택이며 항상 최대 이용률을 보장하지 않는다. Python의 취소 대기는 0.1초 주기로 상태를 확인하며 OS 스케줄링을 포함한 실시간 응답 보장은 아니다.

### CPython 공식 executor 문서: 제출량과 실행량, 풀 내부 대기

- [공식 CPython `concurrent.futures` 문서 소스](https://github.com/python/cpython/blob/main/Doc/library/concurrent.futures.rst).
- `map(buffersize=...)` 설명은 결과를 아직 소비하지 않은 제출 작업 수를 제한하고, 버퍼가 가득 차면 입력 반복을 멈춘다고 명시한다.
- “Deadlocks can occur when the callable associated with a Future waits on the results of another Future”와 단일 작업자가 같은 풀에 제출한 하위 작업을 기다리는 교착 예제가 있다.

**적용 판단:** 실행 가능한 작업만 GUI 스레드에서 `QThreadPool`에 제출하며, 작업자가 같은 풀의 하위 작업을 동기적으로 기다리는 구조를 추가하지 않는다. 이 문서는 설계 원칙의 근거이며, 앱이 CPython의 새 `buffersize` API를 사용한다는 뜻은 아니다. 전체 사용자 대기 목록에는 이번 변경으로 별도의 유한 개수 상한을 추가하지 않았다. 따라서 실행 자원 제한이 대기 목록의 무제한 메모리 사용까지 해결한 것은 아니다.

### HTTP 표준: 과부하와 재시도

- [HTTP Working Group RFC 9110 소스](https://github.com/httpwg/http-core/blob/main/rfc9110.xml), §10.2.3 `Retry-After`, §15.6.4 `503 Service Unavailable`.
- “Retry-After ... indicate how long the user agent ought to wait before making a follow-up request”. 값은 HTTP 날짜 또는 지연 초일 수 있다. 503은 일시 과부하·정비 상태를 표현할 수 있다.
- [HTTP/2 표준 소스](https://github.com/httpwg/http2-spec/blob/main/draft-ietf-httpbis-http2bis.xml), `SETTINGS_MAX_CONCURRENT_STREAMS`: 한 연결의 동시 스트림 허용 개수이며, 보내는 쪽이 상대가 시작할 수 있는 스트림 수를 정한다.

**적용 판단:** 동시 작업 수, HTTP 연결 수, 한 연결의 HTTP/2 스트림 수를 같은 숫자로 취급하지 않는다. 서버의 재시도 지시를 무시하고 병렬도를 높이는 방법은 채택하지 않는다. 이번 변경이 yt-dlp의 모든 오류 경로에서 `Retry-After`를 파싱·준수하도록 새로 구현했다는 주장은 하지 않는다. HTTP 표준은 이 앱의 최적 병렬도 숫자를 정하지 않는다.

## 4. 실제 프로그램에서 확인한 방법

### yt-dlp: 작업 간 병렬도와 조각 병렬도 분리

공식 자료: [README의 Download Options](https://github.com/yt-dlp/yt-dlp/blob/master/README.md#download-options), 실제로 읽은 [원문](https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/README.md).

`-N, --concurrent-fragments N`은 “Number of fragments of a dash/hlsnative video ... concurrently”, 기본값 1이다. `--retry-sleep`은 고정·선형·지수 대기식을 별도로 제공한다. 따라서 조각 병렬도는 여러 영상 작업 수와 별개이며, 모든 직접 HTTP 파일에서 N개 연결로 분할 전송한다는 뜻이 아니다.

**채택:** 원래 최대 4개 조각 병렬도를 유지하되 전체 작업 수가 커지면 2 또는 1로 줄이고, 전송 중인 트랙이 해당 가중치를 예약한다. 일반 직접 파일은 1개로 계산한다. **제외:** 각 작업의 조각 수를 무조건 늘리는 방식과 `작업 수 × 4`를 제한 없이 허용하는 방식. 새로운 retry-sleep 정책은 이번 변경에 추가하지 않는다.

### aria2: 큐 항목·항목 내부 분할·서버 제한 분리

공식 자료: [aria2c 매뉴얼 원문](https://github.com/aria2/aria2/blob/master/doc/manual-src/en/aria2c.rst).

`--max-concurrent-downloads`는 “limits the number of items which are downloaded concurrently”, 기본값 5이다. 같은 설명에서 `--split`, `--min-split-size`는 각 항목 내부 연결 수에 영향을 준다고 구분한다. `--max-connection-per-server`는 “for each download”의 서버별 연결 수이며 기본값 1이다. 이는 모든 항목을 합친 서버 전역 연결 제한이 아니다.

**채택:** 전체 작업과 작업 내부 조각·자원 예산을 분리하는 구조. **앱의 추가 판단:** 원본 호스트별 작업 상한을 따로 둔다. **제외:** aria2 기본값 5가 이 앱에서도 최적이라는 추론, 모든 미디어에 Range 분할을 강제하는 방법, per-download 서버 제한을 앱 전체 CDN 연결 상한으로 소개하는 설명. aria2를 새 런타임 의존성으로 추가하지 않는다.

### qBittorrent: 작업 유형별 상한과 느린 작업 예외

공식 구현: [SessionImpl](https://github.com/qbittorrent/qBittorrent/blob/master/src/base/bittorrent/sessionimpl.cpp), `// Queueing System` 블록 및 `MaxActiveDownloads` 설정.

실제 코드는 `active_downloads`, `active_limit`, `active_seeds`를 따로 설정한다. 큐에서 느린 작업을 제외하는 `dont_count_slow_torrents`도 별도 옵션이다. 조사한 기본 설정 코드에서 `MaxActiveDownloads`는 3이고 `IgnoreSlowTorrentsForQueueing`은 false다.

**채택:** 다른 성격의 작업에는 다른 상한을 주는 방식. **제외:** 느린 미디어 작업을 전체 상한 계산에서 자동 제외하는 방법. 큰 파일, 일시적으로 느린 서버, 변환 대기를 구별할 측정 없이 예외를 만들면 실행 프로세스와 전송 수가 계속 증가할 수 있다. BitTorrent의 peer·seed 동작을 HTTP 다운로드에 그대로 적용하지 않는다.

### Netflix concurrency-limits: 상한과 피드백 제어 구분

공식 자료: [README](https://github.com/Netflix/concurrency-limits/blob/master/README.md), [VegasLimit](https://github.com/Netflix/concurrency-limits/blob/master/concurrency-limits-core/src/main/java/com/netflix/concurrency/limits/limit/VegasLimit.java), [AIMDLimit](https://github.com/Netflix/concurrency-limits/blob/master/concurrency-limits-core/src/main/java/com/netflix/concurrency/limits/limit/AIMDLimit.java).

README는 CPU·메모리·디스크·네트워크 같은 자원의 고갈과 지연 증가를 설명하고 Little의 법칙을 소개한다. Vegas는 `L * (1 - minRTT/sampleRTT)`로 큐를 추정한다. 실제 AIMD 코드는 drop 또는 timeout에서 상한을 곱셈으로 낮추고, 충분한 실행 수가 있을 때 1씩 늘리며, 최소·최대 범위로 제한한다. 이는 존재하는 구현의 동작이며 이 앱에서 유효성이 검증된 결과는 아니다.

**채택:** 병렬도에 명시적인 상한을 두고, 실제 측정 없이 최적값을 확정하지 않는 원칙. **제외:** 영상 전체 완료 시간을 RTT로 보고 Vegas/AIMD를 자동 적용하는 방법. 영상 길이·화질·서버별 제한·변환·디스크 때문에 지연이 크게 달라지고, 로컬 오류와 서버 과부하를 구분할 측정 경로도 부족하다. 이번 정책은 적응형 네트워크 혼잡 제어가 아니다.

## 5. 사이트 공정성과 구현 비용

원본 사이트는 입력 URL의 정규화한 호스트명이다. 지원하는 YouTube 별칭은 `youtube.com`으로 묶는다. 서명 URL, 쿼리, 쿠키, 인증 헤더를 스케줄링 키나 보고서에 사용하지 않는다.

실행 여유가 생기면 사이트 상한을 넘지 않는 후보 중 **현재 실행 수가 가장 적은 사이트**를 먼저 선택하고, 수가 같으면 대기열에서 먼저 들어온 항목을 선택한다. 대기열 맨 앞 사이트가 상한에 걸려도 뒤의 다른 사이트가 출발할 수 있다. 이는 작업 시작의 공정성이다. 전송 바이트·대역폭·완료 시간의 동등 분배는 보장하지 않으며 이미 시작한 작업을 중단하거나 선점하지 않는다.

이 사이트 상한은 작업 수 전체에 적용하므로 변환·검사 중인 작업도 계산한다. 같은 사이트만 넣은 상태에서 전체 16개와 사이트 기본 4개를 고르면 최대 4개만 실행된다. 사용자가 사이트 상한을 함께 올릴 수 있다. 직접 URL의 호스트가 다르면 같은 사업자·CDN이라도 다른 키이며, 리다이렉트 후 목적지·미디어 조각 CDN까지 추적한 서버별 연결 제한은 아니다. GUI 밖에서 엔진을 직접 호출할 때에도 단계별 공유 예산은 적용되지만 GUI의 사이트 선택 정책까지 자동 적용되는 것은 아니다.

대기 항목 수를 `Q`, 실행 작업 수를 `A ≤ 16`, 한 번의 큐 처리에서 새로 시작한 수를 `K ≤ 16`이라고 하면, 초기 목록 정리와 실행 사이트 집계는 `O(Q + A)`, 후보 선택은 최대 `O(KQ)`이다. 리스트 제거 비용도 이 범위에 포함되므로 한 번의 큐 처리는 `O(Q + A + KQ)`이고, K의 고정 상한에서는 Q에 선형이다. 사이트 집계의 추가 공간은 `O(A)`다. 이는 긴 대기열에서 GUI가 절대로 지연되지 않는다는 보장은 아니며, 이번 변경은 기존 대기열·카드 보관 구조를 유지한다.

단계 게이트는 FIFO로 대기자를 관리한다. 앞 대기자의 취소 제거는 최악 `O(W)`, 상태 변경 시 깨우기는 대기자 수에 영향을 받는다. 정상 앱 실행에서 전체 작업 상한 16이 단계별 대기자 수도 제한한다. 가중치 네트워크 토큰은 한 번에 부여하므로 여러 작업이 일부만 쥐고 서로 기다리는 순환을 피한다. 전송 예산은 미디어 처리·검사를 기다릴 때 보유하지 않는다. 단계 대기는 GUI 스레드가 아닌 작업자에서 진행한다.

## 6. 확인 범위와 남은 한계

- 실행 상한 확대는 여러 작업의 진행을 허용한다. 하나의 영상이나 전체 묶음의 완료 시간이 몇 배 빨라진다는 실측 근거는 없다.
- 고정 상한은 메모리·CPU 비율·남은 디스크 용량의 동적 할당기가 아니다. 여러 대용량 원본과 최종 파일이 동시에 존재할 수 있다.
- 전체 개수와 사이트 개수를 낮춰도 진행 중인 작업을 강제 중단하지 않고 이후 새 작업의 출발을 제한한다. 이미 확보한 자원은 단계 종료 때 반환한다.
- 원본 주소·서명 쿼리·추출기 진단을 노출하지 않는 기존 방침과, 작업별 임시 디렉터리·게시 전 미디어 검증·안전한 최종 파일 게시 흐름을 유지해야 한다.
- 이 연구 담당 작업에서는 테스트·실제 미디어 다운로드·벤치마크를 실행하지 않았다. 기존에 실행한 테스트를 이번 변경의 새 검증으로 재사용하거나 재실행하지 않았다. 코드 독해와 공개 자료 확인은 실행 검증과 다르다.

원본 자료는 현재 환경의 상속된 프록시·CA 신뢰 경로를 사용해 가져왔다. GitHub와 raw GitHub의 허용된 공개 원문을 읽었으며, 자격 증명 값이나 환경 변수 전체를 출력하지 않았다. SEDA 구현의 조사 커밋은 `249d897ca1a356097f4150d4a8db17ae72ac1076`, 저자 웹사이트·논문의 조사 커밋은 `afe3ea0a0790868616a100923abe9ec9955900a7`이다.
