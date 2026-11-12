# myapps — Codex 작업용 개선 계획서

> **기준 소스:** [`ed0abd8d9727`](https://github.com/P-JSL/myapps/tree/ed0abd8d9727bd92f0d3a63748dcb940057504f1) · **한국어 재정리:** 2026-11-12(KST)  
> **상태:** 분석·개선안 작성. 현재 실제 코드 수정/테스트/릴리스가 완료된 것은 아닙니다.  
> **제품:** My Video App — Chrome 확장과 Python Windows 데스크톱

## 1. Codex 수행 규칙

1. 한 번에 **작업 ID 하나만** 선택합니다. 반드시 현 시점 브랜치의 실제 소스·호출자·테스트를 먼저 읽어, 아래 소스 링크(분석 당시 커밋)와 차이가 있는지 확인합니다.
2. 인터페이스·파일 형식·상태 전이·오류·로그·보안 정책·데이터 정합성 등 기존 계약을 유지하며 필요 최소 범위만 수정합니다. 존재 확인되지 않은 API/테이블/옵션/의존성을 만들어내지 않습니다.
3. '기존 구현', '재현된 불일치', '추가 검증', '성능 조건부'를 구분합니다. 이미 구현된 보호를 중복 개발하지 않습니다.
4. 수정 전 실패를 재현하는 테스트/프로파일을 먼저 준비합니다. 테스트/스모크/벤치마크를 실제 실행하지 않았으면 **미검증**으로 표시합니다. Windows/네이티브/외부 서버는 안전한 환경에서만 테스트합니다.
5. 완료 시 변경 파일, 이전 동작, 수정 이유·내용, 실제 테스트 명령/결과, 미검증 상황, 잔존 위험, 커밋 SHA를 남깁니다. 별도 요청 없이 릴리스·배포·운영 데이터 변경을 진행하지 않습니다.

## 2. 제품 구조와 절대 보존할 계약

Chrome 확장은 미디어 탐색·Range/OPFS·Worker·선택적 백신 연동을, Windows 앱은 yt-dlp/FFmpeg·SQLite WAL·작업 큐·개인정보 최소화 활동 로그를 사용합니다. 두 제품의 데이터 저장 및 UI 계약은 별도입니다.

- Chrome Range는 강한 ETag·206·Content-Range·총 크기를 검증한 후 조각을 게시합니다.
- Windows의 영상/오디오 부분 실패 복구는 정상 트랙·기존 사용자 파일을 보존해야 합니다.
- SQLite WAL의 작업 상태와 `activity.jsonl` 진단 로그는 목적이 달라 서로 대체하지 않습니다. 로그에 URL·쿠키·실제 파일 경로·토큰을 기록하지 않습니다.
- 확장 Host Permission은 현재 HTTP/HTTPS 폭넓은 범위와 `all_frames`, optional Native Messaging이 포함됩니다. 임의 축소 전에 기능 영향을 검증합니다.
- 릴리스 검증 문구는 실제 수행된 테스트만 나타내며, FFmpeg/yt-dlp와 배포물 무결성 계약을 유지합니다.

## 3. 소스와 과거 보고서 교차 확인 사항

- 확인된 검증 범위: `.github/workflows/release.yml`에 `focused-desktop-v18-restore`와 `priorChecks='skipped-per-user'`가 있어 전체 테스트 완료로 표시하면 안 됩니다.
- 기존 보안: `src/local/parallel-download.ts`는 강한 ETag/범위/206을 검사하고 `desktop/storage.py`는 WAL을 사용합니다.
- Desktop 활동 로그는 `logs/activity.jsonl`에 현재 2MiB 및 최대 이전 4개 회전 파일로 구성됩니다.
- 과거 수백 배의 국소 전송 benchmark는 사용자 전체 다운로드 개선량으로 환산할 수 없습니다.

## 4. Codex 작업 순서

| ID | 우선순위 | 실행 주제 |
|---|---|---|
| M-01 | P0 | 릴리스 검증 범위와 사용자 안내 정합화 |
| M-02 | P0 | Chrome Range 조각 무결성 |
| M-03 | P0 | Windows 비디오/오디오 부분 복구·재시작 |
| M-04 | P1 | 네트워크·FFmpeg·OPFS·DB 시간 분리 |
| M-05 | P1 | FFmpeg 재인코딩 회피의 조건 검증 |
| M-06 | P2 | OPFS·Worker 메모리 복사 중복 확인 |
| M-07 | P2 | 데스크톱 작업 동시성·자원 반환 |
| M-08 | P2 | SQLite transient 상태 갱신 빈도 |
| M-09 | P1 | 개인정보 보호 로그·회전 검증 |
| M-10 | P1 | 확장 권한/Native Messaging/백신 상태 |
| M-11 | P2 | 두 UI의 접근성·상태 동기화 |

P0는 사용자의 데이터·정합성에 영향을 줄 수 있는 경계 우선 검증, P1은 품질/운영, P2는 실측 후 결정할 최적화입니다. **P0가 곧 현재 장애·취약점의 확정 판정을 뜻하지는 않습니다.**

## 5. 상세 작업 지시서

### M-01 · 릴리스 검증 범위와 사용자 안내 정합화 (P0)

- **확인·수정 파일:** [`.github/workflows/release.yml`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/.github/workflows/release.yml), [`scripts/build-desktop.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/scripts/build-desktop.py), [`scripts/publish-release.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/scripts/publish-release.py)
- **Codex 실행 지침:** 현재 focused v1.18 복원만 검증한 경로와 전체 기능 회귀를 엄격히 구분합니다. 검증 JSON/릴리스 노트에서 실제 수행한 테스트·건너뛴 테스트·소스 SHA를 표시하고 필수 테스트 실패 시 차단하는 범위를 점검합니다.
- **검증:** `npm run verify`(환경 설치 후)
- **완료 기준:** 검증 통과를 과장하지 않으며 릴리스 자료와 수행 이력이 동일
- **기존 항목 매핑:** IMP-M07, Q-M08
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### M-02 · Chrome Range 조각 무결성 (P0)

- **확인·수정 파일:** [`src/local/parallel-download.ts`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/src/local/parallel-download.ts), [`tests/parallel-download.test.ts`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/tests/parallel-download.test.ts)
- **Codex 실행 지침:** 잘못된 206/Content-Range/강한 ETag 변경·Range 무시·취소/재시도에서 다른 원본 조각이 합쳐지지 않도록 회귀를 고정합니다. 파일 출처가 바뀌면 안전하게 단일 다운로드/명시적 실패로 처리합니다.
- **검증:** `npm test`
- **완료 기준:** 잘못된 조합이 완료 파일로 게시되지 않고 정상 다운로드 출력 불변
- **기존 항목 매핑:** IMP-M03, Q-M01
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### M-03 · Windows 비디오/오디오 부분 복구·재시작 (P0)

- **확인·수정 파일:** [`desktop/engine.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/desktop/engine.py), [`desktop/storage.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/desktop/storage.py), [`desktop/test_download_recovery.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/desktop/test_download_recovery.py)
- **Codex 실행 지침:** 정상 비디오+오디오 403/503, 네트워크 중단, 기존 `.part`, ETag 변경, 취소·디스크 가득 참을 테스트합니다. 재시작에서 정상 트랙/다른 다운로드 작업이 영향받지 않게 합니다.
- **검증:** `python -m unittest desktop.test_download_recovery -v`
- **완료 기준:** 정상 트랙 보존, 잘못된 완료 0건, SQLite 작업 상태 일치
- **기존 항목 매핑:** IMP-M08, Q-M02, Q-M04
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### M-04 · 네트워크·FFmpeg·OPFS·DB 시간 분리 (P1)

- **확인·수정 파일:** [`scripts/benchmark.mjs`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/scripts/benchmark.mjs), [`scripts/benchmark-native.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/scripts/benchmark-native.py), [`tests/parallel-download.test.ts`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/tests/parallel-download.test.ts)
- **Codex 실행 지침:** 64MiB/1GiB, Range 지원/미지원, 느린 쓰기/RTT, 동시 1/2/4/8의 end-to-end wall time과 각 단계 시간·RSS·파일 해시를 분리 계측합니다.
- **검증:** `npm run bench:algorithms`
- **완료 기준:** 다른 환경 결과를 무단 합산하지 않고 단계별 기준선 마련
- **기존 항목 매핑:** IMP-M01, IMP-M10
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### M-05 · FFmpeg 재인코딩 회피의 조건 검증 (P1)

- **확인·수정 파일:** [`desktop/engine.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/desktop/engine.py), [`desktop/test_engine.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/desktop/test_engine.py)
- **Codex 실행 지침:** ffprobe로 원본 codec/container/트랙 호환성이 확인된 경우에만 remux를 시도합니다. 변환이 필요하면 기존 경로를 유지하며 비트스트림·길이·오디오·메타데이터를 비교합니다.
- **검증:** `python -m unittest desktop.test_engine -v`
- **완료 기준:** 호환성 유지가 입증된 입력에서만 실제 전체 시간 개선
- **기존 항목 매핑:** IMP-M02
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### M-06 · OPFS·Worker 메모리 복사 중복 확인 (P2)

- **확인·수정 파일:** [`src/local/offscreen.ts`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/src/local/offscreen.ts), [`src/local/large-stream-worker.ts`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/src/local/large-stream-worker.ts), [`src/local/disk-fs.ts`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/src/local/disk-fs.ts)
- **Codex 실행 지침:** 기존 Transfer 최적화 부분은 이미 구현된 것으로 분류합니다. 중복 복사/OPFS sink backpressure가 측정상 병목일 때만 제한된 메모리 버퍼 실험을 수행합니다.
- **검증:** `npm test`
- **완료 기준:** 완료 파일 SHA·순서·취소 동작 유지, heap 상한과 실제 비용 개선
- **기존 항목 매핑:** IMP-M03, IMP-M05
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### M-07 · 데스크톱 작업 동시성·자원 반환 (P2)

- **확인·수정 파일:** [`desktop/concurrency.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/desktop/concurrency.py), [`desktop/test_concurrency.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/desktop/test_concurrency.py)
- **Codex 실행 지침:** 동시 1/2/4/8, 서버 429, CPU 변환+네트워크 작업, 취소와 대기열 공정성을 함께 계측합니다. 무제한 병렬 요청으로 우회하지 않습니다.
- **검증:** `python -m unittest desktop.test_concurrency -v`
- **완료 기준:** 처리량·p95·자원 반환 확인, 다른 작업의 롤백 전파 없음
- **기존 항목 매핑:** IMP-M04
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### M-08 · SQLite transient 상태 갱신 빈도 (P2)

- **확인·수정 파일:** [`desktop/storage.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/desktop/storage.py)
- **Codex 실행 지침:** 진행률 등 일시 상태만 묶어 쓰는 것이 실제 병목인지 측정합니다. 완료/오류/취소의 terminal 상태는 즉시 내구성 있게 기록하고 재시작 복구 검증을 유지합니다.
- **검증:** `python -m unittest desktop.test_download_recovery -v`
- **완료 기준:** DB 상태 누락 없이 유의미한 쓰기 시간 개선
- **기존 항목 매핑:** IMP-M06, Q-M03
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### M-09 · 개인정보 보호 로그·회전 검증 (P1)

- **확인·수정 파일:** [`desktop/activity.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/desktop/activity.py), [`desktop/test_activity.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/desktop/test_activity.py), [`tests/test_activity_release.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/tests/test_activity_release.py)
- **Codex 실행 지침:** URL·쿠키·동영상 제목·파일 경로·예외 문자열이 로그에 직접 나오지 않는지 fixture로 점검합니다. symlink/권한 실패, 2MiB 회전, 기록 실패 fallback을 테스트합니다.
- **검증:** `python -m unittest desktop.test_activity -v`
- **완료 기준:** 민감정보 노출 0건·이상 종료 복구, 로그 실패가 다운로드를 중단하지 않음
- **기존 항목 매핑:** IMP-M09, Q-M07
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### M-10 · 확장 권한/Native Messaging/백신 상태 (P1)

- **확인·수정 파일:** [`src/local/manifest.json`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/src/local/manifest.json), [`src/local/antivirus.ts`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/src/local/antivirus.ts), [`tests/antivirus-policy.test.ts`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/tests/antivirus-policy.test.ts)
- **Codex 실행 지침:** 넓은 호스트 권한과 all_frames 사용의 실제 필요성을 기능별로 검사합니다. optional nativeMessaging 권한 거부와 백신 검사 불가를 안전한 완료로 위장하지 않는지 확인합니다.
- **검증:** `npm test`
- **완료 기준:** 필요 없는 권한 축소는 호환성 검증 뒤, 백신 상태 판정이 정확함
- **기존 항목 매핑:** Q-M05, Q-M06, Q-M09
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### M-11 · 두 UI의 접근성·상태 동기화 (P2)

- **확인·수정 파일:** [`src/local/ui.ts`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/src/local/ui.ts), [`desktop/main.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/desktop/main.py), [`tests/browser.mjs`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/tests/browser.mjs)
- **Codex 실행 지침:** Chrome 확장과 Python GUI 각각에서 다운로드 대기·재시도·취소·완료 상태의 키보드 조작/화면낭독/실제 작업 상태 일치를 검사합니다.
- **검증:** `npm run test:browser`
- **완료 기준:** 마우스 없이 중요 기능 접근·사용자가 본 완료 상태가 실제 상태와 동일
- **기존 항목 매핑:** Q-M10
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

## 6. 기존 저장소에서 확인한 검증 명령

```bash
npm run typecheck
npm run check:source
npm test
npm run test:native
npm run build
npm run test:browser
python -m unittest desktop.test_download_recovery -v
```

서로 다른 OS·작업 루트에서 실행하는 명령은 각각 준비한 후 실행합니다. 마지막 Go/Rust parity는 두 바이너리를 빌드한 뒤, Windows 네이티브/실 서버·백신 테스트는 전용 환경에서 실행합니다. 문서에 명령을 적었다고 테스트가 완료된 것은 아닙니다.

## 7. 과거 이력 정리 및 완료 보고 양식

- 초기 `IMP-*` 과제는 위 작업별 번호로 연결하고 중복·이미 구현된 제안을 합쳤습니다. 비성능 `Q-*` 보호·품질 과제도 필요한 검증/수정 안으로 통합했습니다.
- 과거의 100회/1,000회 검토는 **합성 모델의 시나리오 교차 검산**으로, 실제 프로그램 1,000회 실행 또는 전문가 검토 1,000회가 아닙니다. 중복된 영어 보고·복잡한 통계표 대신 코드 작업 가능성·완료 조건만 남겼습니다.
- 성능 향상 배수는 이 저장소에서 측정된 실제 기준선·변경 전후 비교만을 사용해야 합니다. 다른 시스템·논문의 배수는 적용 불가합니다.
- **Codex 완료 보고:** 작업 ID / 변경 파일 / 재현 조건 / 구현 내용 / 기존 동작 보존 근거 / 테스트 명령·결과 / 미검증 항목 / 원복 방법 / 커밋 SHA. 미통과 작업은 `완료`로 표기하지 않습니다.
