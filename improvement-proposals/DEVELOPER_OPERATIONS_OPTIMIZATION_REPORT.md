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
- **근거 및 관찰 사실:** `.github/workflows/release.yml`에는 `validationMode=focused-desktop-v18-restore`, `priorChecks=skipped-per-user`, `liveYouTubeVerified=false`가 기록됩니다. 이는 현행 워크플로가 표시하는 검증 범위입니다.
- **적용 원리·수식 또는 불변식:** 릴리스 완료 주장 `claimed_tests ⊆ actually_executed_tests`. `failed_required_tests > 0`이면 게시를 차단하는 정책을 명시하고, 건너뛴 범위를 성공으로 표기하지 않습니다.
- **공식 문서·논문 출처:** [SLSA Provenance](https://slsa.dev/spec/v1.2/provenance), [GitHub Actions workflow](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions) — 검증 보고서는 실제 CI 실행 결과와 연결되어야 합니다.
- **검증:** `npm run verify`(환경 설치 후)
- **완료 기준:** 검증 통과를 과장하지 않으며 릴리스 자료와 수행 이력이 동일
- **기존 항목 매핑:** IMP-M07, Q-M08
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### M-02 · Chrome Range 조각 무결성 (P0)

- **확인·수정 파일:** [`src/local/parallel-download.ts`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/src/local/parallel-download.ts), [`tests/parallel-download.test.ts`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/tests/parallel-download.test.ts)
- **Codex 실행 지침:** 잘못된 206/Content-Range/강한 ETag 변경·Range 무시·취소/재시도에서 다른 원본 조각이 합쳐지지 않도록 회귀를 고정합니다. 파일 출처가 바뀌면 안전하게 단일 다운로드/명시적 실패로 처리합니다.
- **근거 및 관찰 사실:** `src/local/parallel-download.ts`는 `strongETag()`과 HTTP 206, `Content-Range`, 조각 크기/시작·끝을 직접 비교합니다(기준 211~226행). 기존 보호를 간소화하지 않습니다.
- **적용 원리·수식 또는 불변식:** 조각 `i`마다 `range_start_i == expected_start_i`, `range_end_i == expected_end_i`, `total_i == total`, `ETag_i == initial_strong_ETag`. 연속 범위가 전체 `[0,total−1]`을 겹침·누락 없이 덮어야 합니다.
- **공식 문서·논문 출처:** [RFC 9110 §13.1.5 If-Range](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.5), [RFC 9110 §14.4 Content-Range](https://www.rfc-editor.org/rfc/rfc9110.html#section-14.4) — weak ETag를 If-Range에 사용 금지.
- **검증:** `npm test`
- **완료 기준:** 잘못된 조합이 완료 파일로 게시되지 않고 정상 다운로드 출력 불변
- **기존 항목 매핑:** IMP-M03, Q-M01
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### M-03 · Windows 비디오/오디오 부분 복구·재시작 (P0)

- **확인·수정 파일:** [`desktop/engine.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/desktop/engine.py), [`desktop/storage.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/desktop/storage.py), [`desktop/test_download_recovery.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/desktop/test_download_recovery.py)
- **Codex 실행 지침:** 정상 비디오+오디오 403/503, 네트워크 중단, 기존 `.part`, ETag 변경, 취소·디스크 가득 참을 테스트합니다. 재시작에서 정상 트랙/다른 다운로드 작업이 영향받지 않게 합니다.
- **근거 및 관찰 사실:** `desktop/test_download_recovery.py`에 403/503, 중도 실패, `part` 파일 보존, 선택 트랙만 재시도하는 회귀 사례가 있습니다. `desktop/storage.py`는 작업 상태를 보관합니다.
- **적용 원리·수식 또는 불변식:** 작업 상태 `queued → active → (done|error|cancelled)`. `done ⇒ 검증된 영상·음성 모두 존재`, `트랙 하나 실패 ⇒ 이미 성공한 다른 트랙 보존`. 전체 파일을 임의 삭제하는 재시도는 금지합니다.
- **공식 문서·논문 출처:** [Python pathlib / 안전한 파일 접근](https://docs.python.org/3/library/pathlib.html), [SQLite WAL](https://www.sqlite.org/wal.html) — 파일 게시와 DB commit은 서로 다른 실패 경계입니다.
- **검증:** `python -m unittest desktop.test_download_recovery -v`
- **완료 기준:** 정상 트랙 보존, 잘못된 완료 0건, SQLite 작업 상태 일치
- **기존 항목 매핑:** IMP-M08, Q-M02, Q-M04
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### M-04 · 네트워크·FFmpeg·OPFS·DB 시간 분리 (P1)

- **확인·수정 파일:** [`scripts/benchmark.mjs`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/scripts/benchmark.mjs), [`scripts/benchmark-native.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/scripts/benchmark-native.py), [`tests/parallel-download.test.ts`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/tests/parallel-download.test.ts)
- **Codex 실행 지침:** 64MiB/1GiB, Range 지원/미지원, 느린 쓰기/RTT, 동시 1/2/4/8의 end-to-end wall time과 각 단계 시간·RSS·파일 해시를 분리 계측합니다.
- **근거 및 관찰 사실:** `scripts/benchmark.mjs`의 국소 벤치마크와 전체 다운로드/FFmpeg/OPFS는 측정 단위가 다릅니다. 과거 고배수 Transfer 결과를 end-to-end 개선으로 표기하지 않습니다.
- **적용 원리·수식 또는 불변식:** 전체 임계 경로 `T_total`을 단계별로 계측하고 `Throughput = verified_bytes / wall_time`, 최적화 단계 시간 비율 `f`에 대해 `S = 1/(1−f+f/r)`를 사용합니다. 비동기 겹침이 있으면 단순 합산 금지.
- **공식 문서·논문 출처:** [Amdahl의 법칙](https://doi.org/10.1145/1465482.1465560), [Google Benchmark](https://google.github.io/benchmark/user_guide.html) — 단독 연산 개선배수는 전체 프로그램 속도가 아닙니다.
- **검증:** `npm run bench:algorithms`
- **완료 기준:** 다른 환경 결과를 무단 합산하지 않고 단계별 기준선 마련
- **기존 항목 매핑:** IMP-M01, IMP-M10
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### M-05 · FFmpeg 재인코딩 회피의 조건 검증 (P1)

- **확인·수정 파일:** [`desktop/engine.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/desktop/engine.py), [`desktop/test_engine.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/desktop/test_engine.py)
- **Codex 실행 지침:** ffprobe로 원본 codec/container/트랙 호환성이 확인된 경우에만 remux를 시도합니다. 변환이 필요하면 기존 경로를 유지하며 비트스트림·길이·오디오·메타데이터를 비교합니다.
- **근거 및 관찰 사실:** `desktop/engine.py`의 FFmpeg/ffprobe 사용 경로를 대상으로 합니다. 컨테이너와 코덱이 허용할 때만 streamcopy가 가능하며, 필터·재인코딩이 필요한 기능과는 다릅니다.
- **적용 원리·수식 또는 불변식:** 후보 비용 `T_streamcopy ≈ T_read + T_remux + T_write`; 재인코딩 비용 `T_reencode ≈ T_decode + T_filter + T_encode + I/O`. 실제로 둘의 출력 의미가 같은 경우에만 비교합니다.
- **공식 문서·논문 출처:** [FFmpeg Streamcopy 공식 문서](https://ffmpeg.org/ffmpeg.html#Streamcopy) — `-c copy`는 디코딩·인코딩을 생략하지만 지원하지 않는 컨테이너·필터 조합이 존재합니다.
- **검증:** `python -m unittest desktop.test_engine -v`
- **완료 기준:** 호환성 유지가 입증된 입력에서만 실제 전체 시간 개선
- **기존 항목 매핑:** IMP-M02
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### M-06 · OPFS·Worker 메모리 복사 중복 확인 (P2)

- **확인·수정 파일:** [`src/local/offscreen.ts`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/src/local/offscreen.ts), [`src/local/large-stream-worker.ts`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/src/local/large-stream-worker.ts), [`src/local/disk-fs.ts`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/src/local/disk-fs.ts)
- **Codex 실행 지침:** 기존 Transfer 최적화 부분은 이미 구현된 것으로 분류합니다. 중복 복사/OPFS sink backpressure가 측정상 병목일 때만 제한된 메모리 버퍼 실험을 수행합니다.
- **근거 및 관찰 사실:** Chrome Worker/OPFS 관련 기존 Transfer 최적화는 이미 구현된 경로가 있으므로 중복 제안하지 않습니다. `offscreen.ts`와 `disk-fs.ts`에서 현재 불필요한 복사 발생 여부를 계측합니다.
- **적용 원리·수식 또는 불변식:** 중복 버퍼 복사량 `B_copy = Σ(payload_bytes × unnecessary_copy_count)`; 이론적 추가 복사시간 하한 `T_copy ≥ B_copy/R_memory`. 실제 GC·전송·권한 이관은 별도 비용입니다.
- **공식 문서·논문 출처:** [MDN Transferable objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects), [File System API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API) — 전송 후 원본 버퍼 접근 무효화 주의.
- **검증:** `npm test`
- **완료 기준:** 완료 파일 SHA·순서·취소 동작 유지, heap 상한과 실제 비용 개선
- **기존 항목 매핑:** IMP-M03, IMP-M05
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### M-07 · 데스크톱 작업 동시성·자원 반환 (P2)

- **확인·수정 파일:** [`desktop/concurrency.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/desktop/concurrency.py), [`desktop/test_concurrency.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/desktop/test_concurrency.py)
- **Codex 실행 지침:** 동시 1/2/4/8, 서버 429, CPU 변환+네트워크 작업, 취소와 대기열 공정성을 함께 계측합니다. 무제한 병렬 요청으로 우회하지 않습니다.
- **근거 및 관찰 사실:** `desktop/concurrency.py`의 자원 예산과 GUI 큐를 기준으로 작업자 수를 실험합니다. 현재 동시성 제약이 버그라는 증거는 없습니다.
- **적용 원리·수식 또는 불변식:** 안정 상태에서 Little의 법칙 `L = λW`(동시 작업 수=도착률×평균 체류시간). 대기시간 `W`가 악화하면 단순 동시 작업 수 `L` 증가는 성능 개선이 아닙니다.
- **공식 문서·논문 출처:** [Little 1961](https://doi.org/10.1287/opre.9.3.383), [Python concurrent.futures](https://docs.python.org/3/library/concurrent.futures.html) — 서버의 429 제한·사용자 취소 대응을 보존합니다.
- **검증:** `python -m unittest desktop.test_concurrency -v`
- **완료 기준:** 처리량·p95·자원 반환 확인, 다른 작업의 롤백 전파 없음
- **기존 항목 매핑:** IMP-M04
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### M-08 · SQLite transient 상태 갱신 빈도 (P2)

- **확인·수정 파일:** [`desktop/storage.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/desktop/storage.py)
- **Codex 실행 지침:** 진행률 등 일시 상태만 묶어 쓰는 것이 실제 병목인지 측정합니다. 완료/오류/취소의 terminal 상태는 즉시 내구성 있게 기록하고 재시작 복구 검증을 유지합니다.
- **근거 및 관찰 사실:** `desktop/storage.py`는 SQLite WAL과 busy_timeout을 사용합니다. write가 실제 병목인지 확인한 다음 terminal 상태와 progress 상태의 지속성 요구를 구별합니다.
- **적용 원리·수식 또는 불변식:** `terminal ∈ {done,error,cancelled}`이면 해당 상태의 `COMMIT` 내구성을 보존; `WAL`에서는 동시 writer가 **한 명**입니다. 진행 갱신을 묶으면 `writes_per_second`는 줄지만 재시작 관찰 가능한 중간 상태는 달라질 수 있습니다.
- **공식 문서·논문 출처:** [SQLite WAL 공식 문서](https://www.sqlite.org/wal.html) — WAL이 모든 쓰기 병렬성을 허용하는 것은 아닙니다.
- **검증:** `python -m unittest desktop.test_download_recovery -v`
- **완료 기준:** DB 상태 누락 없이 유의미한 쓰기 시간 개선
- **기존 항목 매핑:** IMP-M06, Q-M03
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### M-09 · 개인정보 보호 로그·회전 검증 (P1)

- **확인·수정 파일:** [`desktop/activity.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/desktop/activity.py), [`desktop/test_activity.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/desktop/test_activity.py), [`tests/test_activity_release.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/tests/test_activity_release.py)
- **Codex 실행 지침:** URL·쿠키·동영상 제목·파일 경로·예외 문자열이 로그에 직접 나오지 않는지 fixture로 점검합니다. symlink/권한 실패, 2MiB 회전, 기록 실패 fallback을 테스트합니다.
- **근거 및 관찰 사실:** `desktop/activity.py`는 기본 `max_bytes=2*1024*1024`, `backup_count=4`이며 원본 URL·제목·경로·헤더 등을 로그에서 배제하도록 설계됐습니다. 기존 로테이션을 유지해야 합니다.
- **적용 원리·수식 또는 불변식:** 로그 검사 `sensitive_fields ∩ actual_logged_fields = ∅`. 총 파일 보관량은 정상 회전·개별 크기 상한이 지켜질 때 대략 `(backup_count+1)×max_bytes` 이내(5×2MiB≈10MiB)이지만 파일 시스템 실패 예외를 고려합니다.
- **공식 문서·논문 출처:** [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html), [Python file mode 보안](https://docs.python.org/3/library/os.html#os.open) — 민감 원문을 디버그 모드에서도 기록하지 않습니다.
- **검증:** `python -m unittest desktop.test_activity -v`
- **완료 기준:** 민감정보 노출 0건·이상 종료 복구, 로그 실패가 다운로드를 중단하지 않음
- **기존 항목 매핑:** IMP-M09, Q-M07
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### M-10 · 확장 권한/Native Messaging/백신 상태 (P1)

- **확인·수정 파일:** [`src/local/manifest.json`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/src/local/manifest.json), [`src/local/antivirus.ts`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/src/local/antivirus.ts), [`tests/antivirus-policy.test.ts`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/tests/antivirus-policy.test.ts)
- **Codex 실행 지침:** 넓은 호스트 권한과 all_frames 사용의 실제 필요성을 기능별로 검사합니다. optional nativeMessaging 권한 거부와 백신 검사 불가를 안전한 완료로 위장하지 않는지 확인합니다.
- **근거 및 관찰 사실:** `src/local/manifest.json`에는 광범위한 HTTP(S) host permissions, `all_frames`, 선택적 `nativeMessaging`이 선언돼 있습니다. 범위 존재는 소스 사실이며 실제 취약점 존재를 증명하지 않습니다.
- **적용 원리·수식 또는 불변식:** 권한 최소화 조건 `required_permissions ⊆ granted_permissions`이면서 `unused_permissions`를 줄이는 방향. 백신 판정은 `unknown != clean`, 요청 거부/기능 불능을 정상 검사 성공으로 표시하지 않습니다.
- **공식 문서·논문 출처:** [Chrome host_permissions](https://developer.chrome.com/docs/extensions/reference/manifest/host-permissions), [Chrome Optional Permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions), [OWASP 최소권한 원칙](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) — 사이트 호환성 회귀 후 축소합니다.
- **검증:** `npm test`
- **완료 기준:** 필요 없는 권한 축소는 호환성 검증 뒤, 백신 상태 판정이 정확함
- **기존 항목 매핑:** Q-M05, Q-M06, Q-M09
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### M-11 · 두 UI의 접근성·상태 동기화 (P2)

- **확인·수정 파일:** [`src/local/ui.ts`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/src/local/ui.ts), [`desktop/main.py`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/desktop/main.py), [`tests/browser.mjs`](https://github.com/P-JSL/myapps/blob/ed0abd8d9727bd92f0d3a63748dcb940057504f1/tests/browser.mjs)
- **Codex 실행 지침:** Chrome 확장과 Python GUI 각각에서 다운로드 대기·재시도·취소·완료 상태의 키보드 조작/화면낭독/실제 작업 상태 일치를 검사합니다.
- **근거 및 관찰 사실:** `src/local/ui.ts`와 Python 데스크톱 UI는 실행 생명주기가 다릅니다. 동일한 상태 레이블을 공유하더라도 런타임 저장소까지 합칠 근거는 없습니다.
- **적용 원리·수식 또는 불변식:** UI 불변식 `표시 완료 ⇒ 실제 작업 terminal == done`; 대기/실패/취소/복구를 키보드 조작으로 탐색 가능해야 하며 상태 알림은 화면낭독 대상이 되어야 합니다.
- **공식 문서·논문 출처:** [WCAG 2.2 Keyboard](https://www.w3.org/WAI/WCAG22/Understanding/keyboard), [Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages) — 웹 기준은 Chrome UI에 직접, Windows 데스크톱에는 사용성 원칙으로 적용합니다.
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

## 8. 추가 보안·위험·복구 보완 사항 — 소스 재검증 (2026-11-12)

기존 11개 작업을 보존하고 추가로 관측한 운영·보안 위험 경계입니다. **현재 확인한 것은 소스 동작 및 시험 필요 조건이며, 실제 악용·사고·기능 손상은 별도 실행 없이는 확정하지 않습니다.**

### 8.1 신규 교차 검토 결과

1. Windows 데스크톱 SQLite에는 작업 URL·제목·폴더·파일 경로가 원문 컬럼으로 저장됩니다. 개인정보 최소화 `activity.jsonl` 정책과 별개의 저장면입니다.
2. Chrome 네트워크 경로에서 `credentials: 'include'`와 `redirect:'follow'`를 사용합니다. 브라우저 쿠키의 출처별 규칙을 전제로 해도 승인하지 않은 대상과 전송 정책이 있는지 테스트해야 합니다.
3. 내부 바이트 검사는 최대 256MiB까지만 분석하며 결과 `no-signals`는 악성코드가 없다는 보증이 아닙니다. 상태 표시·외부 백신 판정과 혼동되지 않아야 합니다.
4. 파일명 정규화는 일부 특수 문자·양끝 공백을 제거하지만 Windows 예약 파일명·정규화 충돌은 호출자 전체 경로에서 검증해야 합니다.

### 8.2 Codex 신규 작업 인덱스

| ID | 우선 | 내용 | 판정 |
|---|---|---|---|
| M-12 | P1 | SQLite 작업 이력의 URL·제목·경로 보관 정책과 접근 제어 | 저장 컬럼 확인, 실제 유출 미검증 |
| M-13 | P1 | Chrome 다운로드의 쿠키 포함 전송·리다이렉트 도착지 검증 | 브라우저 옵션 확인, 자격증명 유출은 미증명 |
| M-14 | P1 | 내부 탐지기의 256MiB 검사 한도·판정 의미 일치 | 검사 코드의 명시적 제한 확인, 보안 진단 성공 주장 아님 |
| M-15 | P2 | Windows 예약 파일명·대소문자·유니코드 충돌 | 공통 파일명 정규화 확인, 전체 저장 경로 취약점 미확정 |

### 8.3 상세 구현·검증 지시

### M-12 · SQLite 작업 이력의 URL·제목·경로 보관 정책과 접근 제어 (P1)

- **현재 확인·미확인:** 저장 컬럼 확인, 실제 유출 미검증
- **소스 위치:** [`desktop/storage.py` 40-75행](https://github.com/P-JSL/myapps/blob/4658a7db3dade73df710cb6ae1239e3ff4bf3e74/desktop/storage.py#L40-L75)
- **추가 근거:** `jobs` 테이블에는 `url`, `title`, `folder`, `filepath`, `message`가 저장되고, WAL 파일이 추가될 수 있습니다. 기존 M-09의 익명화된 `activity.jsonl` 검증만으로 SQLite 개인정보 보존을 보장할 수 없습니다.
- **Codex 구현·시험:** Windows LocalAppData 경로 권한·다른 계정 접근·작업 200개 이력 삭제·복구·DB/WAL/SHM 잔류를 별도 임시 계정으로 검사합니다. 사용자가 선택한 이력 기능은 유지하되 개인정보 보관 정책과 삭제 동작을 문서화합니다.
- **적용 원리/안전 불변식:** `민감 저장소 = DB + WAL + SHM + 백업/복사본`; 삭제 UI의 한 행 제거가 물리 디스크 흔적 제거를 보장하지 않음. 데이터 보유 범위는 사용자 선택·업무 목적을 기준으로 정합니다.
- **검증 명령:** `python -m unittest desktop.test_download_recovery -v` + SQLite 테스트 전용 디렉터리/권한 검사
- **합격 기준:** 업무 이력 기능 유지, 실제 저장되는 항목/보관기간/삭제의 의미가 명확하고 무단 계정 접근이 차단됨
- **원복·금지 사항:** `PRAGMA secure_delete`나 VACUUM 도입 전 성능·내구성·파일 잠금 영향을 시험, 단순히 암호화했다고 주장 금지
- **기존 작업 연결:** M-03 / M-09
- **기술 규격·논문 출처:** [원문](https://www.sqlite.org/pragma.html#pragma_secure_delete)

### M-13 · Chrome 다운로드의 쿠키 포함 전송·리다이렉트 도착지 검증 (P1)

- **현재 확인·미확인:** 브라우저 옵션 확인, 자격증명 유출은 미증명
- **소스 위치:** [`src/local/network.ts` 50-84행](https://github.com/P-JSL/myapps/blob/4658a7db3dade73df710cb6ae1239e3ff4bf3e74/src/local/network.ts#L50-L84)
- **추가 근거:** 네트워크 GET은 `credentials:'include'`, `redirect:'follow'`를 사용하고 `response.url`에 대해 `mediaURL()` 검증을 거칩니다. 모델은 HTTP(S)만 허용하며 확장 권한은 넓어 요청 출처·리다이렉트 도착지 정책을 별도로 검증할 가치가 있습니다.
- **Codex 구현·시험:** 서로 다른 테스트 Origin A/B와 302/307, HTTP→HTTPS, localhost/사설주소, 쿠키·인증 리다이렉트, 명시 사용자 승인 URL을 시험합니다. 쿠키는 브라우저의 실제 origin 정책으로 판단하고, 모든 redirect가 외부로 쿠키를 누출한다고 가정하지 않습니다.
- **적용 원리/안전 불변식:** `요청 대상 허용 ⇒ 시작 URL 정책 통과 ∧ 최종 응답 URL 정책 통과`; 신뢰 도메인 제한을 적용할 경우 실제 미디어 CDN·서명 URL 호환성을 보존해야 함.
- **검증 명령:** `npm test`; 브라우저 통합 테스트 서버에서 네트워크 동작/credential 전송 검사
- **합격 기준:** 예상치 못한 외부 도착지·사설망 접근과 승인된 CDN 리다이렉트를 구분하고 사용자 의도와 실송신 호스트가 일치
- **원복·금지 사항:** 브라우저 표준 쿠키 스코프를 무시한 임의 자격증명 헤더 복사 금지
- **기존 작업 연결:** M-02 / M-10
- **기술 규격·논문 출처:** [원문](https://developer.mozilla.org/en-US/docs/Web/API/Request/credentials)

### M-14 · 내부 탐지기의 256MiB 검사 한도·판정 의미 일치 (P1)

- **현재 확인·미확인:** 검사 코드의 명시적 제한 확인, 보안 진단 성공 주장 아님
- **소스 위치:** [`src/security/internal-scan.ts` 165-218행](https://github.com/P-JSL/myapps/blob/4658a7db3dade73df710cb6ae1239e3ff4bf3e74/src/security/internal-scan.ts#L165-L218)
- **추가 근거:** 검사기는 최대 256MiB만 확인하고 `status`가 `suspicious`, `incomplete`, `no-signals` 중 하나입니다. 주석도 `no-signals`를 '악성코드 없음'으로 해석하지 말라고 명시합니다.
- **Codex 구현·시험:** 256MiB 초과·부분 프리픽스·지원 안 되는 컨테이너·EICAR 무해 테스트 문자열·ZIP 첨부 파일을 합성 fixture로 검사하고 Chrome 사용자 UI와 선택적 외부 백신 결과를 교차 점검합니다.
- **적용 원리/안전 불변식:** `no-signals != malware-free`, `complete == false ⇒ 검사 미완료 표시`; 내부 룰 탐지가 백신·서명 검증의 대체가 아님.
- **검증 명령:** `npm test` + `tests/internal-scan.test.ts`(존재 확인 후) 및 브라우저 UI 회귀
- **합격 기준:** 검사 범위를 벗어난 입력이 안전 완료로 보이지 않고 UI가 검사기의 의미·한계를 정확히 표시
- **원복·금지 사항:** 탐지 결과를 더 보기 좋게 바꾸려고 `incomplete`를 `clean`으로 매핑 금지
- **기존 작업 연결:** M-10 / M-11
- **기술 규격·논문 출처:** [원문](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)

### M-15 · Windows 예약 파일명·대소문자·유니코드 충돌 (P2)

- **현재 확인·미확인:** 공통 파일명 정규화 확인, 전체 저장 경로 취약점 미확정
- **소스 위치:** [`src/shared/filename.ts` 1-4행](https://github.com/P-JSL/myapps/blob/4658a7db3dade73df710cb6ae1239e3ff4bf3e74/src/shared/filename.ts#L1-L4)
- **추가 근거:** `safeBasename()`은 경로 구분자·제어문자·일부 특수문자를 치환하고 180글자로 제한하지만, 해당 함수만으로 `CON`, `PRN`, `NUL`, `COM1` 등의 Windows 예약 이름과 대소문자/유니코드 정규화 충돌까지 검사되는지는 확정되지 않습니다.
- **Codex 구현·시험:** Chrome/Windows 각각에서 `CON.mp4`, `aux.`, 대소문자 동명, NFC/NFD 이름, 확장자만 다른 경로와 길이 경계를 fixture로 시험합니다. 호출자의 최종 파일 경로 안전성·기존 동일 이름 자동 넘버링을 확인합니다.
- **적용 원리/안전 불변식:** `normalized(A)==normalized(B)`라도 서로 다른 사용자 파일을 덮어쓰지 않음. 유효 최종 파일명은 **사용 운영체제의 예약 이름·허용 경로 정책**을 만족해야 함.
- **검증 명령:** `npm test`; Windows 네이티브 파일명 충돌 테스트 별도
- **합격 기준:** 특수 파일명이 기존 파일을 덮거나 다운로드가 완료로 오인되지 않고 사용자에게 명확한 대체 이름 제공
- **원복·금지 사항:** 전 플랫폼 공통 규칙을 무리하게 강화해 정상 Linux 파일명을 변경하지 않도록 플랫폼 구분
- **기존 작업 연결:** M-03 / M-11
- **기술 규격·논문 출처:** [원문](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)

### 8.4 공통 실행 게이트

1. 현재 `main`의 실제 코드·테스트·의존성을 재검토하고 기존 동작을 고정하는 실패 fixture를 먼저 만듭니다.
2. 실사용 데이터는 다루지 않고 임시 디렉터리·테스트 서버·독립 Windows 계정으로 위험 상황을 재현합니다.
3. 기존 보안 조치를 약화하지 않고 원인에 필요한 최소 범위를 수정한 뒤 정상/오류/취소/재시작 경로를 검증합니다.
4. 변경 파일·재현 결과·실제 수행 명령·미검증 조건·원복 방법·커밋 SHA를 남깁니다. **문서 커밋은 코드 개선 완료를 뜻하지 않습니다.**
