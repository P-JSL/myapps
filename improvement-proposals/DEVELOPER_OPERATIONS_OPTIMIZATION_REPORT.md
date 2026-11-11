# 9. myapps — My Video App (Chrome 확장 + Python Windows 앱)

**저장소:** [P-JSL/myapps](https://github.com/P-JSL/myapps)  
**소스 분석 기준:** `main` / [`a0e297f84a677ac7c9720bfe520dc103480e3183`](https://github.com/P-JSL/myapps/commit/a0e297f84a677ac7c9720bfe520dc103480e3183)  
**보고서 작성일:** 2026-11-11 (KST)  
**대상:** 개발자 · 운영자 · 릴리스 담당자  
**개선 후보:** 7개 (우선순위·수정 위치·구현·검증·원복 기준 포함)  
**상태:** 분석·구현 제안만 작성. 실제 소스 최적화·동적 성능 측정·프로그램 배포는 수행하지 않음.  
> 문서 내 장·절 번호는 원래 6개 저장소 통합 보고서의 번호를 보존한 것입니다. 코드 근거 링크는 작성 시점의 커밋으로 고정했습니다.

## 9.1 두 제품의 완전히 다른 실행 경로

**Chrome 확장 (TypeScript):** 웹페이지 콘텐츠 스크립트가 미디어를 감지 → 백그라운드가 보안·다운로드 상태와 저장 정책 관리 → 오프스크린 문서/Worker가 일반 미디어·HLS/DASH를 디스크 기반으로 준비 → Chrome 다운로드/확장 기록 → 선택적 백신 도우미.

**Windows 앱 (Python/PySide6):** GUI가 다운로드 대기열·설정을 관리 → Qt 작업자가 `desktop/engine.py`의 yt-dlp/FFmpeg 경로 실행 → SQLite에 기록 및 상태 저장 → JSONL 실행 로그 → 완료 폴더 열기·재시도.

두 제품을 **같은 구현**으로 취급하면 장애 분석을 잘못하게 됩니다. YouTube는 **Windows 앱**을 사용하며 Chrome 확장에는 YouTube 다운로드가 없습니다.

### Chrome 확장 경로

```text
웹페이지 src/local/collect.ts
 → Chrome 메시지/권한 → src/local/background.ts (수집·요청·보안·기록)
 → src/local/queue.ts (무거운 준비 작업 순서화)
 → src/local/offscreen.ts (OPFS에 파일 준비, Worker, 스트림 처리)
 → src/local/hls.ts / network.ts / parallel-download.ts
 → src/security/* · src/local/antivirus.ts (위험 신호·외부 백신 결과)
 → src/data/database.ts (IndexedDB 메타데이터·이전 저장소 마이그레이션)
 → 브라우저 다운로드/OPFS, UI
```

[src/local/collect.ts](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/local/collect.ts#L13)는 미디어 태그/링크 후보 및 브라우저 리소스 타이밍을 확인하고 확장 메시지로 전달합니다. [src/local/background.ts](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/local/background.ts#L85)는 `navigator.locks`를 이용하여 이력 변경 충돌을 줄이고, [src/local/queue.ts](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/local/queue.ts#L2)는 무거운 준비 작업을 직렬화합니다. [src/local/offscreen.ts](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/local/offscreen.ts#L57)는 OPFS·Worker를 사용하며, [src/local/parallel-download.ts](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/local/parallel-download.ts#L96)은 원격 바이트를 **전체 메모리에 누적하지 않고 사용자 제공 디스크 sink**로 저장하는 경로를 지원합니다. HLS는 [src/local/hls.ts](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/local/hls.ts#L28)에서 재귀 깊이·순환·트랙 구성을 검증합니다.

[src/data/database.ts](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/data/database.ts#L165)는 브라우저 저장소를 IndexedDB 메타데이터로 관리하고, 미디어 바이트는 OPFS/Chrome 다운로드에 둡니다. 시크릿 모드에서는 일반 기록과 별도 메모리 경로를 사용합니다. [src/local/antivirus.ts](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/local/antivirus.ts#L62)는 백신 스캔 응답에 파일 SHA-256·크기·엔진 정보가 없는 경우 `clean`을 수용하지 않도록 검사합니다.

### Windows 데스크톱 경로

```text
desktop/main.py (PySide6 UI · 대기열 · 상태·사용자 이벤트)
 → desktop/concurrency.py (전체 작업·호스트별 제한, 단계별 자원 게이트)
 → desktop/engine.py (다운로드 요청 검증, yt-dlp, FFmpeg·파일 결과)
 → desktop/storage.py (SQLite 설정·작업 이력)
 → desktop/activity.py (작업 이벤트 JSONL·파일 회전)
 → 실행 ZIP/런타임 (scripts/build-desktop.py)
 → GitHub Actions 릴리스 (scripts/publish-release.py)
```

[desktop/concurrency.py](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/concurrency.py#L16)은 전체 동시 다운로드 상한 **16**, 동일 호스트 기본 **4**, 조각 병렬 처리 상한 **4**를 둡니다. `ResourceBudget`는 메타데이터/변환/백신 단계를 별도 게이트로 제한하고 취소 시 임대 자원을 반환합니다. [desktop/storage.py](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/storage.py#L37)은 SQLite 연결을 작업 단위로 열어 GUI·작업자가 공유하며, v1.19.4에서 제거한 과거 HTTP/3·네이티브 전송 설정을 DB에서 정리합니다. [desktop/engine.py](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/engine.py#L372)이 GUI와 독립적인 실제 다운로드 엔진입니다.

[desktop/activity.py](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/activity.py#L115)는 앱 데이터 폴더의 `logs/activity.jsonl`에 이벤트를 기록하고 **2MiB × (현재+최대 이전 4개)**의 순환 로그를 유지합니다. 기록 실패는 다운로드 자체를 중단시키지 않지만, 해당 세션 로그가 메모리에만 남을 수 있으므로 운영자가 UI 경고를 확인해야 합니다.

## 9.2 데이터·보안 경계

| 대상 | 위치·범위 | 운영 원칙 |
|---|---|---|
| Chrome 확장 설정·이력 | [src/data/database.ts](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/data/database.ts)의 IndexedDB, 시크릿 별도 | 확장 삭제·재설치/브라우저 프로필 전환 시 데이터 보존 여부 점검 |
| Chrome 미디어 중간 파일 | OPFS 및 Chrome Downloads | 저장 불가/취소/브라우저 종료 후 잔여 파일 정리 경로 점검 |
| Windows 앱 설정·작업이력 | `%LOCALAPPDATA%\\MyVideoApp\\Desktop\\desktop.sqlite3` | 앱 ZIP 교체와 **사용자 데이터 백업을 분리** |
| Windows 앱 실행 로그 | `%LOCALAPPDATA%\\MyVideoApp\\Desktop\\logs\\activity.jsonl` | 2MiB 회전 전에 장애 이력 별도 보존 |
| 선택적 백신 도우미 | [native/antivirus_host.py](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/native/antivirus_host.py) | 파일 상한 약 2GiB, 심볼릭 링크·네트워크 공유 제외, 검사 실패 ≠ 안전 |
| Windows 앱 런타임 | [scripts/build-desktop.py](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/scripts/build-desktop.py) | 고정된 URL·해시·크기·파일 구조 확인 후 패키징 |

**다운로드 보안:** Windows 엔진은 입력 주소·DRM·트랙 형식을 검증하고 원본 사이트의 접근 권한을 우회하지 않는 경로를 사용합니다. Chrome 도우미는 OS 백신 결과와 자체 정적 위험 신호를 구분해 반환합니다. **'위험 없음'은 보안 보증이 아니며**, 검사 실패·미완료를 `clean`으로 처리하면 안 됩니다.

## 9.3 릴리스 품질 게이트 — 핵심 검증 공백

[.github/workflows/release.yml](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/.github/workflows/release.yml#L52)의 2026-11-11 기준 워크플로는 **Windows 앱 v1.18 복원 경로에 집중한 테스트**를 실행합니다. 주석에 **이전 테스트 스위트는 사용자 요청에 따라 생략**한다고 적혀 있으며, `WINDOWS-VALIDATION.json`에 `priorChecks="skipped-per-user"`, `liveYouTubeVerified=false`를 기록합니다. 즉, **배포 자동화가 존재한다는 사실과 모든 주요 기능을 검증했다는 주장은 다릅니다.** 이것을 CI 실패나 프로그램 결함으로 단정할 수는 없지만, 릴리스 리뷰에서는 명확하게 표시해야 하는 검증 범위 제한입니다.

[scripts/build-desktop.py](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/scripts/build-desktop.py#L75)는 릴리스 패키지 의존성의 고정 해시와 플랫폼을 검증합니다. [scripts/publish-release.py](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/scripts/publish-release.py#L170)는 버전·커밋·패키지 SHA 및 증빙을 검사하고 릴리스 게시 전 조건을 확인합니다. 그러나 워크플로에서 생략한 예전 동작의 회귀를 코드 서명이나 SHA-256 확인만으로 검증할 수는 없습니다.

### 운영자 배포 표준 절차

1. **배포본 확인:** Windows 앱 ZIP, Chrome 확장 ZIP, `SHA256SUMS-RELEASE.txt`, 버전 v1.19.4가 **같은 릴리스**인지 확인합니다.
2. **설치:** Windows 앱은 **반드시 새 폴더**에 전체 압축을 풀고, 기존 프로그램 폴더 위에 덮어쓰지 않습니다. 사용자 데이터는 `%LOCALAPPDATA%`에서 분리 보존됩니다.
3. **앱 시험:** 공개 테스트 콘텐츠를 대상으로 URL 입력 → 트랙 확인 → 저장 폴더 → 다운로드 → FFmpeg 병합 → 완료 파일 검증 → 기록·로그 확인 → 실패·재시도까지 수행합니다.
4. **동시성 시험:** 전체 1/4/16, 동일 호스트 1/4/16 설정에서 큐·취소·완료 후 슬롯 반환을 확인합니다. 16개가 항상 더 빠른 것은 아닙니다.
5. **확장 시험:** Chrome 개발자 모드에서 확장 로드 → 일반 미디어 페이지 감지 → 저장 폴더 설정 → 허용된 비암호화 HLS/DASH → 취소/기록/백신 미연결 상태 확인. YouTube 미지원 상태가 유지돼야 합니다.
6. **오류 대응:** Windows 앱의 `실행 로그`를 열어 실패 단계와 작업 ID를 확인하고, 오류 보고 전 URL·쿠키·개인정보를 제거합니다.
7. **롤백:** 앱 ZIP 버전만 이전 정상 패키지로 되돌리고 SQLite 사용자 데이터·저장된 영상은 원칙적으로 유지합니다. DB 마이그레이션의 **역호환 여부**는 복원 전에 확인해야 하며, 새로운 DB가 이전 앱에서 읽힌다고 임의로 보장할 수 없습니다.

### 개발자 검증 명령

```sh
# Chrome 확장 및 공통 TypeScript
npm ci
npm run typecheck
npm test
npm run build
npm run test:browser
npm run test:native

# Python Windows 앱 단위 테스트 (적절한 실행 환경)
python -m unittest discover -s desktop -p 'test_*.py'

# Windows 릴리스 계약 검증은 .github/workflows/release.yml과
# scripts/publish-release.py의 고정 검사 경로를 따를 것
```

테스트 명령은 개발자용 **추천 실행 경로**이며 실제 통과 여부는 이번 보고서가 확인하지 않았습니다. 특히 **실제 YouTube 접근, 비암호화 HLS/DASH, DRM 차단, 데이터 이전, 저장 폴더 선택, 업데이트/재설치**가 변경되었다면, 선택적 회귀 검사를 반드시 별도 수행해야 합니다.

---

## 9.4 미디어 전송·FFmpeg·메모리·릴리스 성능 최적화 심층 검토 (추가)

**성능 성격:** 네트워크·원격 사이트 응답 + 디스크 쓰기 + FFmpeg 컨테이너 병합/트랜스코딩 + Chrome Worker/OPFS + Windows 앱의 Qt 이벤트 처리. **텍스트 생성형 LLM은 없습니다.** Chrome 미디어 확대/변환은 [FFmpeg WASM](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/upscale/worker.ts#L1)으로 구현돼 있으며 언어 모델 추론 가속 대상이 아닙니다.

### 9.4.1 이미 적용된 최적화

| 구현 | 코드 근거 및 뜻 |
|---|---|
| Windows 동시 실행 제한 | [desktop/concurrency.py L16-L22](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/concurrency.py#L16): 전체 최대 16, 같은 사이트 기본 4, 네트워크 용량 16, FFmpeg 작업 스레드 2. [L110-L148](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/concurrency.py#L110)은 단계별 자원 대기·취소·반납을 관리합니다. |
| FFmpeg 비재인코딩 병합 | [desktop/engine.py L716-L733](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/engine.py#L716)은 비오디오 변환에서 `-c copy`를 사용해 비디오 재인코딩을 피합니다. MP3/M4A 변환은 여전히 인코딩 필요. |
| Chrome Range+ETag 기반 병렬 다운로드 | [parallel-download.ts L195-L237](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/local/parallel-download.ts#L195)는 강한 ETag/정확한 Content-Range가 있을 때만 **기본 4개·4MiB 청크**를 병렬 다운로드하고, 조건이 없으면 순차 스트리밍으로 안전하게 폴백합니다. |
| Worker·disk-backed 처리 | [offscreen.ts L57-L99](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/local/offscreen.ts#L57), [disk-fs.ts L84-L118](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/local/disk-fs.ts#L84): Worker에서 파일을 처리하고 Extent 배열에 대한 이진 탐색으로 저장된 조각을 읽습니다. 데이터 전체를 JS RAM에 무제한 축적하는 구조로 단순화할 필요는 없습니다. |
| 크기·형식·보안 검사 | [src/upscale/worker.ts L23-L25](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/upscale/worker.ts#L23)에서 로컬 처리 입력을 256MiB로 제한하며 [src/local/network.ts](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/local/network.ts#L50)도 응답 바이트 한도/재시도 경계를 확인합니다. |
| 사용자 데이터 DB | Windows [storage.py L45-L80](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/storage.py#L45)는 SQLite WAL 및 작업별 연결을 사용합니다. Chrome [database.ts L165-L225](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/data/database.ts#L165)는 IndexedDB 트랜잭션/OPFS를 분리합니다. |

### 9.4.2 추가 최적화 후보

| ID/우선 | 코드·병목 가설 | 개선 방법 및 제약 |
|---|---|---|
| **M-P1** | Windows [engine.py L716-L733](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/engine.py#L716)에서 MP3/M4A 출력은 재인코딩을 수행하고, 비오디오 출력은 stream copy입니다. **FFmpeg CPU 사용을 최우선 측정**. | 원본 오디오 코덱·컨테이너가 목표 형식과 정확하게 호환되는 경우에 한한 '복사 가능 여부' 검토. MP3 출력에서 AAC를 복사하면 형식 계약이 깨집니다. 음질/호환성/메타데이터/재생 시간 검증 없이 무조건 copy로 변경 금지. |
| **M-P1** | Chrome [offscreen.ts L75-L84](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/local/offscreen.ts#L75)에서 병렬로 다운로드된 각 청크의 OPFS 쓰기는 Promise 체인 **직렬화**를 거칩니다. 네트워크가 디스크보다 빠른 환경에서 쓰기 큐 길이·버퍼 잔류가 병목이 될 수 있습니다. | `queued bytes`, 최고 메모리, 디스크 write MB/s, 다운로드 미수신 대기시간을 먼저 계측. 체인 유지하되 동시 요청 측 압력 제어/청크 크기 조정; **동일 파일 오프셋 손실·덮어쓰기·전송 순서 오염 금지**. |
| **M-P2** | [parallel-download.ts L100-L105](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/local/parallel-download.ts#L100) 기본 청크 4MiB·동시 4, 재시도 상태 제한. | **1/2/4/8 병렬 요청** × **1/2/4MiB 청크**를 로컬 고정 서버와 동일 외부 테스트 소스에서 비교. ETag·Range 미지원/변경/부분 응답은 반드시 현재 안전한 단일 스트리밍 또는 오류로 처리. 무단으로 8/16 고정 상향 금지. |
| **M-P2** | [desktop/concurrency.py L31-L41](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/concurrency.py#L31)의 자동 작업 수는 CPU 코어를 기준으로 2~4이며, 네트워크/처리/검사 별도 자원 게이트가 있습니다. | HDD/SSD, 네트워크 100Mbps/1Gbps, CPU 2/8/16 코어 등 조건을 고정하여 throughput과 p95 작업 완료 지연을 비교. **대역폭·서버 rate-limit**의 영향을 앱 로직과 분리해야 함. |
| **M-P2** | [src/upscale/worker.ts L43-L71](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/upscale/worker.ts#L43)의 256MiB 이하 처리 경로는 입력을 `arrayBuffer()`에 담고 FFmpeg MEMFS로 전달한 뒤 출력 버퍼를 추출합니다. | 큰 입력에서 Peak JS/WASM 메모리·GC pause 계측. `canOwn`·transferable 이미 사용하므로 추가 zero-copy 효과를 **실측**해야 하며 보안 스캐너와 File 바이트 계약 유지. |
| **M-P2** | Windows [storage.py L71-L80](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/storage.py#L71)는 각 DB 작업에서 연결을 새로 열고 닫습니다. | 초당 다운로드 진행 이벤트/DB 저장 빈도를 측정. 큰 작업량에서 반복 `connect()`·commit 비용이 크면 **배치 저장/스레드 소유 연결** 검토. WAL·크래시 이후 작업 상태 복구와 사용자 설정 저장 즉시성 보존 필수. |
| **M-P1 운영** | [.github/workflows/release.yml L55-L68](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/.github/workflows/release.yml#L55)는 특정 v1.18 복원 시나리오만 실행하고 이전 스위트는 의도적으로 생략합니다. | **CI 소요시간 단축은 이미 이루어진 대신 회귀 커버리지 공백이 명시**되어 있습니다. 변경 영향 기반 최소 스모크를 추가하는 경우 필요한 테스트를 독립·병렬 Job으로 배치하고, 릴리스 승인 게이트를 숨기지 않도록 합니다. 속도 개선보다 신뢰성 관리 우선. |

### 9.4.3 현장 성능 검증 절차

**개발자 명령(현재 package.json 정의 기반):**

```sh
npm ci
npm run typecheck
npm test
npm run bench:algorithms
npm run verify
# Windows Python 개발 환경: 실제 의존성 설치 후 관련 회귀 테스트
python -m unittest desktop.test_concurrency desktop.test_engine desktop.test_download_recovery
```

- **고정 HTTP fixture:** Range, ETag 변경, 206/200 폴백, 서버 429/503, 연결 중단, 다운로드 중 취소, 1MiB/100MiB/대용량을 재현 가능한 테스트 서버로 제공. 브라우저는 Chrome 버전·확장 빌드·스토리지 상태를 고정합니다.
- **Windows:** URL 메타데이터 추출 시간, 다운로드 시간, 조각 수신 MB/s, 병합/인코딩 시간, 디스크 busy%, CPU%, 메모리 Peak RSS, 대기/검사 시간, 실패 후 재시도 비율을 `job_id` 기준으로 분리합니다. [engine.py L403-L421](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/engine.py#L403)에는 단계 시간 `duration_ms` 계측 지점이 있습니다.
- **Chrome:** Worker 이벤트 전송 대기, OPFS 쓰기 큐, FFmpeg 초기 로드/인코딩, Garbage Collection, 탭 응답성과 peak JS/WASM memory를 측정합니다.
- **실제 사이트:** YouTube 등 외부 테스트는 네트워크·서비스 변경을 통제할 수 없어 참고 성능으로 별도 표기하고, 인증/DRM 우회 테스트는 수행하지 않습니다.

**필수 회귀:** 바이너리 내용·SHA-256·파일 포맷 재생 가능성, 원본 오디오/비디오 분리·병합 정합성, 다운로드 취소/재시도, 파일 충돌·부분 산출물, 브라우저 다운로드 히스토리/보안 검사 우회 불가, Windows 사용자 설정 및 DB 마이그레이션 보존. `-c copy`는 이미 적용돼 있으므로 이를 신규 속도 개선 실적으로 제시하지 않습니다.

## 9.5 My Video App: 다운로드·FFmpeg·저장소 개선 구현안 (추가)

**구조 주의:** Windows 데스크톱(`desktop/engine.py`, SQLite, yt-dlp, FFmpeg)과 Chrome 확장(`src/local/offscreen.ts`, OPFS, Worker, FFmpeg WASM)은 별개의 런타임입니다. **한쪽에서 성능 개선을 확인해도 다른 쪽에 그대로 적용할 수 없습니다.** 외부 영상 서버는 rate limit/회선 품질에 영향을 받으므로 고정 HTTP fixture 결과를 우선합니다.

### IMP-M01 · 다운로드 병목을 단계별로 나눠 확인 (P1)

- **위치:** Windows `desktop/engine.py`의 `_activity_phase()` [L403-L421](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/engine.py#L403), `desktop/concurrency.py`의 단계별 자원 예산 [L110-L148](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/concurrency.py#L110).
- **구현:** ① 이미 존재하는 `duration_ms` 단계 로그를 활용하여 `metadata`, `waiting(network)`, `transfer`, `process`, `scan`, `finalize` 값을 job_id 단위로 집계합니다. ② 전체 작업 처리시간만 비교하지 않고 **대기/네트워크/디스크/인코딩**을 분리합니다. ③ CPU·디스크 busy·네트워크 처리량·동시 작업 수를 함께 기록합니다. ④ 추출만 느린 경우 yt-dlp metadata 단계, 전송만 느린 경우 네트워크·동시성, 후처리만 느린 경우 FFmpeg를 먼저 검토합니다.
- **제약:** 로그의 민감한 URL, 쿠키, 인증 헤더를 출력하지 않습니다. 장애 조사용 timing 수집은 로그 크기·파일 순환 정책을 그대로 유지.

### IMP-M02 · FFmpeg 변환을 불필요하게 반복하지 않기 (P1 / 품질 조건부)

- **위치:** `desktop/engine.py` `_process()` [L716-L733](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/engine.py#L716). 현재 동영상/오디오 병합에는 `-c copy`가 이미 적용되어 있습니다. MP3/M4A 오디오 출력은 재인코딩합니다.
- **개선 조건:** ① 입력 오디오 codec/container와 출력 형식을 `ffprobe`로 확인합니다. ② **이미 목표 코덱·비트레이트·스트림 계약과 정확하게 일치**할 때만 복사/컨테이너 변경을 프로토타입으로 비교합니다. ③ 음질·시크 시간·동영상 플레이어 호환성·원본 사용 권한·자막·메타데이터 정책을 동일 fixture에서 비교합니다. ④ 기존 결과가 192kbps 고정 인코딩을 의도한다면 copy 방식이 출력 계약을 바꾸므로 **적용하지 않습니다**.
- **권고:** 먼저 후처리 시간이 전체의 어느 비중인지 확인합니다. 이미 적용된 비디오 `-c copy`를 신규 최적화로 다시 제안하지 않습니다.

### IMP-M03 · Chrome Range 다운로드/OPFS 쓰기 균형 찾기 (P1)

- **위치:** `src/local/parallel-download.ts`의 기본 **4MiB 청크 × 병렬 4 요청** [L96-L105](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/local/parallel-download.ts#L96), `src/local/offscreen.ts`의 `writing = writing.then(...)` [L70-L85](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/local/offscreen.ts#L70).
- **정확한 이해:** `sink.write()` 자체를 `await`하기 때문에 작업자당 미완료 청크는 제한되어 있습니다. 따라서 **무제한 큐라고 판정하는 것은 부정확**합니다. 다만 쓰기 스트림은 단일 체인이므로 디스크가 병목이라면 요청 병렬성만 높여도 효과가 없을 수 있습니다.
- **구현:** ① 로컬 서버에서 파일 1/100/1000MiB, Range 206/일반 200/ETag 변경/연결 중단/429/503 fixture를 구성합니다. ② `concurrency=1/2/4/8`, `chunkBytes=1/2/4MiB`의 12개 조합으로 network MB/s, OPFS 쓰기 평균/p95, Peak JS heap, 전체 완료 시간 비교. ③ 설정값을 사용자 기본값으로 바꾸기 전에 **같은 크기·같은 네트워크·같은 디스크**에서 일관된 이득을 확인합니다. ④ 단일 `FileSystemWritableFileStream`에 대해 무작정 concurrent `write()`를 보내지 않으며, offset·ETag·Content-Range를 유지합니다.
- **검증:** 불완전 청크/최종 크기/파일 SHA-256/부분 읽기/취소 시 write abort/강한 ETag/리다이렉트 주소 일치. 고정 병렬 8·16 요청 확대는 서버 과부하/실패율을 높일 수 있어 기본값으로 추천하지 않습니다.

### IMP-M04 · Windows 다운로드 동시성 자동 모드 튜닝 (P2)

- **위치:** `desktop/concurrency.py` [L16-L41](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/concurrency.py#L16). 전체 기본 자동 2~4 작업, 같은 호스트 4, 네트워크 예산 16, process 2, scan 1.
- **방법:** CPU 2/8/16 코어 × HDD/SSD × 회선 100Mbps/1Gbps 조합에서 전체 동시 2/4/8, 같은 사이트 1/2/4의 처리량·p95·실패율을 비교합니다. 결과가 충분히 일관될 때만 **자동 추천 상한**을 조정하고, 사용자 직접 설정 `1..16` 및 각 작업의 취소·자원 반납은 유지합니다.
- **부작용:** 새 다운로드가 대기 중인 사이 오래된 작업이 resource lease를 반납하지 못하면 starvation이 생깁니다. 빠른 처리량보다 **기아 상태/취소 응답성**을 먼저 확인합니다.

### IMP-M05 · FFmpeg WASM 전송·메모리 프로파일 (P2)

- **위치:** `src/upscale/worker.ts` [L43-L74](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/upscale/worker.ts#L43)와 `src/local/disk-fs.ts` [L84-L118](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/local/disk-fs.ts#L84).
- **방법:** ① 32/128/256MiB 테스트에서 `arrayBuffer`·내부 위험 검사·FFmpeg core load·probe·encode·FS.readFile·transfer 각각의 ms와 peak JS/WASM memory를 계측합니다. ② 현재 `FS.writeFile(...,{canOwn:true})`와 transferable Buffer를 이미 사용하므로 먼저 **불필요한 ArrayBuffer 복사가 실제 발생하는지** 프로파일러로 확인합니다. ③ 병합/변환 Worker의 반복 초기화가 지배적이면 같은 신뢰 구간의 제한된 core 재사용을 연구할 수 있으나, **이전 작업 메모리/메타데이터·취소가 다음 작업에 섞이지 않는 독립성**이 필수입니다.
- **반려 조건:** 바이러스/내부 검사 우회, 256MiB 입력 한도/실행 시간 제한 변경, 출력 파일의 형식/재생성 차이, 취소 직후 메모리 미해제.

### IMP-M06 · SQLite 저장 호출 빈도 조절 (P2)

- **위치:** Windows `desktop/storage.py` [L31-L80](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/storage.py#L31). 이미 WAL·10초 busy timeout이 있고, 작업별 새 연결을 열고 닫습니다.
- **방법:** ① 초당 기록 갱신·`connect`/`commit` 평균/p95, SQLite lock wait, UI 이벤트 지연을 관측합니다. ② 실제 과도한 갱신이 있으면 **진행률 같은 비핵심 이벤트만 일정 주기 배치**하고 완료·오류·취소·재시도·사용자 설정은 즉시 commit을 유지합니다. ③ 프로세스 재시작 시 `queued/downloading/processing→error` 복구 동작과 기록 보존을 확인합니다.
- **금지:** SQLite 트랜잭션을 장시간 열린 채 UI 이벤트나 네트워크 요청에 걸쳐 유지하는 변경. DB 오류를 삼키고 작업 성공으로 표시하는 변경.

### IMP-M07 · Windows 릴리스 검증 범위 표시/게이트 보강 (P0 운영)

- **위치:** `.github/workflows/release.yml` [L55-L73](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/.github/workflows/release.yml#L55). 현재 **v1.18 복원 범위만 검사**하고 `priorChecks="skipped-per-user"`, `liveYouTubeVerified=$false`라고 명시합니다.
- **권고:** 최적화 변경이 포함된 PR/릴리스에 한해 파일 경로 기준 **영향 받은 테스트만 별도 병렬 Job**으로 실행하는 방안을 설계합니다. 원래 의도한 빠른 릴리스 흐름을 무조건 되돌리지 않고, **릴리스가 통과했다고 모든 이전 테스트를 수행한 것처럼 오인하지 않도록** `WINDOWS-VALIDATION.json`에 실제 실행 범위를 기록합니다. 예: `offscreen.ts` 변경 → Chrome download fixture 회귀, `engine.py` → Windows 오디오/비디오 처리 회귀, `storage.py` → 재시작/DB 복원, `publish-release.py` → SHA 및 자산 계약 검사.
- **중요:** 릴리스 규칙의 변경은 CI/운영 정책 변경입니다. 실제 코드와 독립 검증 job을 추가한 뒤 기존 사용자 요청의 '필요 최소 검사' 원칙을 해치지 않는지 검토해야 합니다.

### 미디어 앱 검증 및 원복

```sh
npm ci
npm run typecheck
npm test
npm run bench:algorithms
npm run verify
# Windows 릴리스 빌드/검증은 workflow와 scripts/publish-release.py의 승인 절차를 따름
```

**측정표:** 네트워크·FFmpeg·OPFS·SQLite 각 ms, throughput MB/s, 전체 처리 p50/p95, 정상 완료율, 작업 취소 지연, 최고 RSS/JS heap, 출력 SHA-256, 실제 파일 재생 여부. **반려:** DRM/인증 우회 경로 신설, URL/쿠키 로그 유출, 안전검사 생략, Range·ETag 무결성 변경, 부분 파일 정상 완료, 데이터베이스 기록 복구 실패, 오래된 실행 파일 혼입.


## 9.6 추가 보완 과제 — 중단 복구·개인정보 안전 진단·실측 근거 (2026-11-11)

기존 IMP-M01~M07은 전송·FFmpeg·저장소 처리량과 CI 범위를 다룹니다. 추가로 **실제 재시작 복원**, **진단 로그의 민감정보 배제**, **마이크로벤치마크와 실제 다운로드 속도의 구분**을 독립 작업으로 정의합니다.

### IMP-M08 · 다운로드 실패·프로세스 중단 후 복구 계약을 릴리스 시험에 연결 (P1)

- **확인 근거:** [desktop/storage.py L43-L69](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/storage.py#L43-L69)는 SQLite WAL과 재시작 시 미완료 작업을 오류 상태로 표시합니다. [desktop/test_download_recovery.py L1-L7](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/test_download_recovery.py#L1-L7)에는 실제 SQLite·임시 파일·게시 경계를 사용하는 집중 복구 테스트가 있습니다.
- **개선 절차:** 동일 URL의 2트랙 다운로드를 네트워크 503·오디오만 실패·사용자 취소·프로세스 강제 종료·재시작 순서로 테스트하고 임시 파일 소유권과 최종 파일 단 한 번 게시 조건을 검증합니다. Windows 배포본 기준 입력/설정/상태 스냅샷은 개인 URL과 쿠키를 마스킹합니다. SQLite 손상, 원격 파일 변경/ETag 실패는 안전한 재시도만 허용합니다.
- **합격/원복:** 미완료 작업을 완료로 표시하지 않음, 원본과 최종 파일 SHA 일치, 다른 작업의 취소/롤백 전파 없음, 재시작 후 SQLite 기록 정합성 유지. 관련 테스트는 패키지 내 Python과 검증된 실행 경로에서 수행하고 테스트 이력에 근거를 남깁니다.

### IMP-M09 · 개인정보 보호형 이벤트 로그의 운영 기준선 (P2 보안/효율)

- **확인 근거:** [desktop/activity.py L1-L5, L115-L125, L171-L214](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/activity.py#L115-L125)는 사용자 URL·제목·경로·헤더·예외 원문을 기록하지 않도록 제한하고, JSONL 회전과 메모리 fallback을 구현합니다.
- **개선 절차:** 다운로드 작업 100건/동시 1·4·16건에서 이벤트 수, 초당 로그 용량, 로테이션 횟수, 이벤트 기록 누적 ms를 측정합니다. 로그 비활성화 대신 진행 이벤트 중복 빈도를 조절하되 시작·완료·실패·취소와 보안 판정 이벤트를 반드시 보존합니다. 운영자 매뉴얼에 %LOCALAPPDATA%\\MyVideoApp\\Desktop\\logs의 접근 권한·백업·사용자 제공 시 익명화 정책을 명시합니다.
- **합격/원복:** [desktop/test_activity.py](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/test_activity.py)와 [tests/test_activity_release.py](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/tests/test_activity_release.py) 통과, URL/쿠키/원문 제목의 로그 유출 0건. 기록 실패가 다운로드 실패로 전파되지 않는 기존 fallback 유지.

### IMP-M10 · 기존 벤치마크 활용 및 실제 다운로드/FFmpeg E2E 성능 분리 (P1 측정)

- **확인 근거:** [scripts/benchmark.mjs L9-L40](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/scripts/benchmark.mjs#L9-L40)은 작업을 순차 실행하고 각 비교 결과·소스 SHA를 묶어 보관합니다. [scripts/benchmark-native.py](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/scripts/benchmark-native.py)의 안전 파일 복사 실험은 실제 백신 속도 측정이 아닙니다. [tests/parallel-download.test.ts](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/tests/parallel-download.test.ts)는 Range/ETag/취소·조각 응답을 시험합니다.
- **개선 절차:** npm run bench:algorithms로 JS 알고리즘 기준선을 보관하되 전체 다운로드/변환 속도 향상이라고 표기하지 않습니다. 별도 로컬 테스트 서버에서 64 MiB/1 GiB, Range 지원·미지원·변경 ETag, HTTP 429, 느린 sink 조합을 구성하여 네트워크 수신·OPFS 쓰기·FFmpeg 변환·안전 검사 각각의 p50/p95·MB/s·RSS를 기록합니다. 외부 영상 사이트 실측은 정책/네트워크 영향이 커서 재현 가능한 합격 수치로 사용하지 않습니다.
- **합격/원복:** 네트워크 프로토콜 정보, 요청 retry 제한, MIME 검사·SHA 결과·저장 파일 일치, 사용자 취소 후 자원 반환을 보존합니다. CPU만 빨라졌는데 메모리·디스크 사용량이 크게 늘었다면 별도 승인 필요.

## 9.7 다운로드·미디어 처리·전송의 추가 속도 개선 여력 — 2단계 반복 검토 (2026-11-11)

### 이미 얻은 미시적 속도개선과 추가 개선량 혼동 금지

[reports/performance-transfer.json](https://github.com/P-JSL/myapps/blob/0775ef6f9dd284d2e3c8ac2a190d1fc0f4a64fb1/reports/performance-transfer.json)은 64MiB worker output 전달 연산의 median **22.084847→0.051617ms (427.86배)**를 보고하지만 **전송 자체만** 측정한 결과입니다. 실제 64MiB FFmpeg MEMFS 준비는 **68.839→43.953ms (1.566배)**입니다. [reports/performance-security.json](https://github.com/P-JSL/myapps/blob/0775ef6f9dd284d2e3c8ac2a190d1fc0f4a64fb1/reports/performance-security.json)은 안전한 64MiB 복사 readinto 후보가 108.29→107.34ms로 **거의 변화가 없어 적용하지 않기로 결정**했습니다. 모두 **과거 수행된 특정 작업/버전의 기록**이며 새 최적화 기대치가 아닙니다.

| 우선 | 실제 병목 후보 | 추가 개선 방법 | 적용 전 반드시 구별 |
|---|---|---|---|
| 1 | [src/local/parallel-download.ts](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/local/parallel-download.ts) | Range 1/2/4/8 streams와 chunk 64KiB/1MiB, OPFS 쓰기 batch·backpressure 튜닝 | 네트워크 B/R_net, 디스크 B/R_disk의 하한. R_net이 느리면 CPU 10배 가속 무의미; ETag/Range 정합성 유지 |
| 2 | [desktop/engine.py](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/engine.py) | ffprobe 판단 뒤 입력 codec/container가 호환일 때만 **stream copy/remux** 실험, 불필요한 reencode 제거 | 재인코딩과 stream copy의 출력 bitstream·호환성은 다름. 동일 출력/정책이 요구되면 사용 금지 |
| 3 | [src/local/offscreen.ts](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/local/offscreen.ts) 및 [src/local/disk-fs.ts](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/src/local/disk-fs.ts) | 반복 buffer copy가 프로파일에서 확인될 때만 owned ArrayBuffer transfer/zero-copy 경계 재분석 | 427.86배 microbench는 이미 적용된 별도 경로이므로 **추가 속도 상한**으로 사용할 수 없음 |
| 4 | [desktop/concurrency.py](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/concurrency.py) | 동시 다운로드 1/2/4/8 및 host별 제한의 E2E throughput/latency 측정, 메모리/네트워크 공정 배분 | Little L=λW에 따라 작업 수 증가는 queue·RAM을 늘릴 수 있고 단건 속도 증가와 다름 |
| 5 | [desktop/storage.py](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/desktop/storage.py) | SQLite WAL은 이미 사용 중. 진행률 업데이트가 실제 DB 병목일 때만 UI rate와 persistence rate 분리 | WAL에는 동시 writer 1개 제약이 있고 crash recoverability/완료 이력 보존 필수 ([SQLite WAL](https://www.sqlite.org/wal.html)) |
| 6 | [scripts/benchmark.mjs](https://github.com/P-JSL/myapps/blob/a0e297f84a677ac7c9720bfe520dc103480e3183/scripts/benchmark.mjs) | 현재 source SHA 고정 단위 마이크로벤치마크 외에 FFmpeg/네트워크/OPFS/DB **동일 데이터 E2E 표본** 추가 | JavaScript µs 연산 100배가 네트워크 수십 초짜리 다운로드 전체 100배 개선을 뜻하지 않음 |

**성능 하한:** 순차 처리 기준 T≥max(B/R_net, B/R_disk, T_decode, T_encode)이며, 병렬 단계의 파이프라인 중복이 있으면 실제 critical path를 기준으로 다시 계산해야 합니다. 전체 처리 시간이 30초인데 전송 준비 복사가 22ms였다면, 그 복사를 **무한히 가속해도 최대 시간 단축은 22ms(약 0.073%)**뿐입니다. **30초·22ms는 이 저장소의 실측 쌍이 아닌 Amdahl 설명용 예시**입니다.

**측정:** 고정 로컬 HTTP 서버 64MiB/1GiB, Range 정상/무시/ETag 변경, fast/slow sink, ffmpeg 복사/변환, 저장소 재시작 후 파일 SHA, 5회 이상 p50/p95·MiB/s·peak RSS. 작업당 총 elapsed에 대한 network/ffmpeg/OPFS/SQLite 구간 비율 f가 측정되기 전까지 **현행 대비 추가 속도 배수는 미측정**입니다.

### 논문·수학 모델에 따른 추가 개선 상한

**Amdahl:** 전체 기존 시간 중 최적화할 단계 비율 f, 해당 단계 가속 r이면 전체 S=1/(1−f+f/r). 가령 f=0.10/r=4 → S=1.081배(전체 시간 7.5% 단축), f=0.50/r=4 → 1.600배(37.5% 단축), f=0.80/r=4 → 2.500배(60% 단축). **위 수치는 측정 결과도 개선 약속도 아닌 계산 예시**입니다. 실측 f가 없으면 저장소 전체의 추가 가능 배수는 제시할 수 없습니다. 여러 단계 국소 개선 배수를 곱하면 안 됩니다.

**Roofline:** CPU 작업량뿐 아니라 메모리/디스크/네트워크 트래픽이 병목일 수 있습니다. **Little:** 안정된 작업계에서 동시 작업수 L=요청 도착률 λ×평균 체류시간 W이며, 작업자 수의 무조건적인 증가는 RAM·대기열과 p95를 악화시킬 수 있습니다. 최소 5회 동일 입력·동일 장비에서 E2E wall time·단계별 CPU·peak RSS·읽기/쓰기 bytes·처리량·p50/p95를 모두 관측합니다. 벤치마크 기록이 없는 개선률은 **미측정**입니다.

검증된 1차 문헌: [Amdahl (1967)](https://doi.org/10.1145/1465482.1465560), [Roofline (2009)](https://zenodo.org/records/1236156), [Little (1961)](https://doi.org/10.1287/opre.9.3.383), [Dean & Barroso (2013), The Tail at Scale](https://research.google/pubs/the-tail-at-scale/), [Google Benchmark Guide](https://google.github.io/benchmark/user_guide.html). 논문에 기재된 **다른 시스템의 가속 배수**는 이 프로그램에서 실현 가능한 개선치로 옮겨 적지 않습니다.

### 재검토 방법과 수행 범위

**1차 100회**는 기존 코드/벤치마크 기반 후보·명령·향상률 주장·복잡도 경계를 다른 입력 크기·작업자 수·병목 구성 조건으로 반복 검산한 **정적·수치 검토**입니다. **2차 100회**는 1차 문헌을 반영해 Amdahl, Roofline, Little 및 동일 성능 단위 기준을 서로 다른 모형 파라미터로 교차 검산한 **학술·수학적 정합성 검토**입니다. 이는 각 문서에 별도로 시행한 100+100 반복 라운드입니다. **200번의 독립적인 전 코드 정독, 실기 벤치마크 200회, 논문 전체 실험 재현을 의미하지 않습니다.** 실제 추가 개선율은 코드 수정 전후의 재현 가능한 성능 시험 없이는 확정할 수 없습니다.
