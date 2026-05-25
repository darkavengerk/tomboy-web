# 노트 안 인라인 지도 임베드 — 설계

- **상태**: 디자인 확정, 구현 대기
- **작성일**: 2026-05-25
- **범위**: v1 (기능 테스트 톤). 다중 핀·역지오코딩·필드 검색 등 모두 명시적 후속

## 1. 의도

모바일 우선 PWA에서 `geo:lat,lon` 형태의 좌표 텍스트를 노트에 삽입하면,
그 자리 바로 아래에 **인라인 지도 카드**가 자동으로 렌더링된다.
사용자는 노트를 작성/조회하는 흐름을 끊지 않고 위치를 시각적으로 확인할 수 있다.

이번 작업은 "노트에 지도 넣기"의 가장 가벼운 진입점이다.
향후 위치 기반 기능(노트북 지도, 다중 핀, 경로 등)의 기초가 된다.

## 2. 사용자 시나리오

1. 사용자가 모바일에서 노트를 편집 중.
2. 툴바 (또는 액션시트)의 "📍 현재 위치 삽입" 버튼을 탭.
3. 브라우저가 위치 권한을 묻고 사용자가 허용.
4. 커서 위치에 `geo:37.123456,127.123456` 텍스트가 삽입됨 (URL 링크 마크 적용).
5. 그 줄 바로 아래에 정사각 지도 카드가 렌더링되며 좌표 위치에 마커 표시.
6. 카드 안에서 팬/줌 가능. Backspace 한 번으로 URL과 지도가 함께 사라짐.

데스크탑에서도 동일한 동작 (geolocation은 Wi-Fi 측위로 작동).

## 3. 아키텍처

### 3.1 신규 모듈

```
app/src/lib/editor/geoMap/
  parseGeoUrl.ts            # "geo:lat,lon[;...]" → {lat, lon} | null
  geoMapPlugin.ts           # ProseMirror plugin (imagePreviewPlugin 미러)
  renderGeoMap.ts           # Leaflet 동적 import + mount/unmount/destroy
  insertCurrentLocation.ts  # navigator.geolocation → editor insert
```

### 3.2 수정 지점

- `app/src/lib/editor/TomboyEditor.svelte` — extensions 배열에
  `createGeoMapPlugin()` 등록 + Leaflet CSS 동적 `<link>` 삽입 부트스트랩
- `app/src/lib/editor/Toolbar.svelte` — `📍` 버튼 한 칸 (기존 `📅` 옆)
- `app/src/lib/editor/NoteActionSheet.svelte` — "현재 위치 삽입" 항목
- `app/package.json` — `leaflet`, `@types/leaflet` 의존성 추가

### 3.3 의도적으로 수정하지 않는 곳

다음은 변경 0:

- `TomboyUrlLink` (mark 그대로 사용)
- `noteContentArchiver.ts` (.note XML 양방향 파이프라인)
- `noteArchiver.ts`
- `syncManager.ts` / `dropboxClient.ts` / Firebase notesync
- copy/format 직렬화 (`copyFormatted.ts`)
- IDB 스키마 (`db.ts`)
- autoLink 모듈 (내부 제목 자동링크는 무관)

## 4. 데이터 모델 & 라운드트립

### 4.1 저장 단위

`geo:lat,lon` 텍스트를 `tomboyUrlLink` mark로 감싼 형태가 유일한 진실의 원천.

- .note XML 표현: `<link:url>geo:37.123456,127.123456</link:url>`
- Tomboy 데스크탑은 이를 일반 URL 링크로 인식하므로 호환 손상 0
- 데스크탑에서 탭하면 OS의 `geo:` URI 핸들러로 위임 (의도된 동작)

### 4.2 좌표 포맷

- RFC 5870 `geo:lat,lon` 기본형
- 정밀도: **소수점 6자리** (예: `37.123456`) — 약 10cm 정밀도
- 옵셔널 파라미터 (`;u=`, `;z=`, `;crs=` 등): **v1 파서는 lat/lon만 추출하고
  나머지는 무시**. 파라미터가 있다는 이유로 거부하지 않음 — 후속 확장
  (예: `;z=15`로 줌 저장) 여지 확보
- 범위 검증: `lat ∈ [-90, 90]`, `lon ∈ [-180, 180]`. 범위 밖이면 `parseGeoUrl()`이
  `null` 반환 → 지도 위젯 미렌더링, URL 텍스트는 일반 링크로 남음

### 4.3 동기화

별도 처리 없음. URL 마크 데이터로서 Dropbox/Firebase 양 채널을 그대로 흐름.
지도는 데코레이션(뷰 레이어)이므로 동기화 대상 자체가 아님.

## 5. 지도 위젯 렌더링

### 5.1 배치

PM `Decoration.widget(r.to, dom, { side: 1, key: ... })` — geo URL 텍스트
바로 뒤. DOM은 `<div class="tomboy-geo-map" contenteditable="false">`로,
CSS `display: block`을 통해 자연스럽게 다음 줄로 떨어진다.

권장 사용 패턴은 geo URL을 자체 단락에 두는 것이지만, 같은 단락 안에
인라인으로 들어가도 위젯은 블록으로 단락 아래에 렌더링된다.

### 5.2 크기

```css
.tomboy-geo-map {
  width: 100%;
  aspect-ratio: 1 / 1;
  display: block;
}
```

편집 영역 너비에 맞춰 정사각으로 가변. **캡 없음** — 데스크탑 콘텐츠 폭이
700px이면 700×700 정사각이 렌더링됨. v1 의도된 동작 (단순성 우선).

### 5.3 Leaflet 설정

- 타일: `https://tile.openstreetmap.org/{z}/{x}/{y}.png`
- attribution: Leaflet 기본 — bottom-right "© OpenStreetMap contributors"
- 마커: 기본 `L.Icon.Default` 1개, lat/lon 위치, 팝업에 좌표 텍스트
- 초기 줌: 15 (도시 블록 보이는 수준)
- 컨트롤: Leaflet 기본 `+`/`-` 버튼 유지 (`zoomControl: true`)
- 인터랙션: 모든 기본값 (pan, scrollWheelZoom, touchZoom, `tap: true`)

**모바일 스크롤 충돌**: 한 손가락 드래그 = 지도 팬, 두 손가락 또는 카드
바깥에서 시작한 드래그 = 페이지 스크롤. v1엔 우회 안 함 (사용자가
익숙해져야 하는 동작으로 명시).

### 5.4 지연 로딩

- `import('leaflet')`은 모듈 레벨 싱글톤 promise로 첫 위젯 렌더 시 한 번만
- Leaflet CSS도 동일하게 동적 `<link>` 삽입
- 로딩 동안 위젯은 회색 배경 + "지도 로딩…" placeholder
- **마커 아이콘 경로 함정**: 정적 빌드(Vite + adapter-static)에서
  `L.Icon.Default`의 기본 경로가 깨지므로 `marker-icon.png` / `marker-icon-2x.png` /
  `marker-shadow.png`를 `import`로 받아 `L.Icon.Default.mergeOptions({...})` 명시

### 5.5 다중 지도

노트에 geo URL이 N개면 N개의 Leaflet 인스턴스가 동시에 생성됨.
v1엔 가속 안 함. 실용 상한 ~3-5개.
"IntersectionObserver 기반 lazy init"은 후속 항목.

## 6. 감지 규칙

### 6.1 스캔

`geoMapPlugin`이 doc 전체 텍스트 노드를 스캔.

- 정규식: `geo:-?\d+(\.\d+)?,-?\d+(\.\d+)?` (옵셔널 파라미터는 v1 미사용)
- 매치를 `parseGeoUrl()`로 검증
- **mark 유무 무관** — `tomboyUrlLink`로 감싸지지 않은 plain 텍스트도 매치되면
  지도 렌더. 외부에서 `geo:...`를 복붙해도 자연스럽게 작동
- 단, 버튼 삽입 경로는 **항상 mark 적용** — 라운드트립과 데스크탑 링크 동작 보장

### 6.2 키 동작 (atomic-character)

`imagePreviewPlugin`과 동일한 패턴:

- URL 텍스트 옆에서 Backspace → URL 전체 삭제 → 데코도 자동 소멸
- ArrowLeft/Right로 URL 가로지름 (한 글자처럼 취급)
- **URL 텍스트는 숨기지 않음** (이미지 플러그인과의 차이 — 좌표 자체가
  의미 있는 정보)

## 7. 삽입 플로우

### 7.1 헬퍼

`insertCurrentLocation(editor: Editor): Promise<void>`

1. `navigator.geolocation.getCurrentPosition(ok, err, { enableHighAccuracy: true, timeout: 10000 })`
2. 성공 시:
   - `geo:${lat.toFixed(6)},${lon.toFixed(6)}` 텍스트 생성
   - 커서 위치에 `tomboyUrlLink` mark로 감싸 삽입
   - 커서를 삽입 끝으로 이동
3. 실패 시: `lib/stores/toast.ts`로 한국어 토스트
   - `PERMISSION_DENIED` → "위치 권한이 거부되었습니다. 브라우저 설정에서 허용해주세요."
   - `POSITION_UNAVAILABLE` → "현재 위치를 가져올 수 없습니다."
   - `TIMEOUT` → "위치 가져오기 시간 초과"

### 7.2 UI 진입점

- `Toolbar.svelte`: `📍` 버튼 한 칸. 위치는 기존 "오늘 날짜 삽입(`📅`)"
  버튼 옆 (둘 다 "커서 위치에 메타데이터 삽입" 의미가 통일됨).
- `NoteActionSheet.svelte`: 항목 "📍 현재 위치 삽입" 한 줄.
  "오늘 날짜 삽입" 항목 바로 아래.
- 둘 다 같은 헬퍼를 호출.

### 7.3 엣지

- 제목 줄(첫 블록) 안에서 호출 시: v1엔 별도 가드 없음, 그냥 삽입.
  제목 유일성 검사 통과하며 동작 정상.
- 이미 로딩 중 (`getCurrentPosition` 콜백 대기) 인데 다시 버튼을 누름:
  v1엔 별도 가드 없음. 두 번째 호출이 결국 두 번째 삽입을 트리거할 수
  있으나 사용자가 명시적으로 누른 행동이므로 그대로 수용.

## 8. 에러 / 엣지 케이스

- **잘못된 좌표 (`geo:abc,def`, `geo:91,200`)** → `parseGeoUrl` null → 지도
  위젯 미렌더링. 원본 텍스트(또는 URL 마크가 적용돼 있다면 그 마크)는 그대로
  남아 사용자가 직접 수정/삭제 가능
- **오프라인 / 타일 서버 다운** → Leaflet 기본 회색 빈 타일. 별도 처리 X
- **노트에 geo URL 수십 개** → 모든 지도 동시 생성 (v1 한계)
- **편집 중 doc 변경마다 재스캔** → `tr.docChanged`만 처리, decoration key로
  동일 위젯 재사용 → Leaflet 인스턴스 깜빡임 방지
- **PWA 오프라인 첫 로드 후 Leaflet 동적 import** → SW 캐시에 있으면 OK,
  없으면 위젯 placeholder에서 멈춤 (별도 토스트 X)
- **터미널/OCR/슬립 노트와 충돌**: 셋 다 본문 첫 줄 형태로 분기 → `geo:` URL은
  본문 어디서나 매치되지만, 이 세 종류 노트는 본문을 일반 에디터로 렌더링하지
  않으므로 그 안에선 지도가 안 뜸 (일반 노트에서만 작동). 충돌 없음.

## 9. 테스트

### 9.1 단위 테스트

`app/tests/unit/editor/geoMap/`:

- `parseGeoUrl.test.ts` — RFC 5870 케이스 (양/음, 정수, 소수, 범위 밖,
  옵셔널 파라미터 무시 동작, 잘못된 포맷)
- `geoMapPlugin.test.ts` — 스캔이 위치 정확히 찾음, 데코 개수, atomic 키
  동작 (Backspace/Delete/Arrow). `imagePreviewPlugin` 테스트가 있으면 그
  구조를 미러
- `insertCurrentLocation.test.ts` — `navigator.geolocation`을 mock해서
  성공/거부/타임아웃 분기 검증, mark 적용 확인

### 9.2 렌더 격리

Leaflet 실제 렌더는 jsdom 환경에선 어려움. `renderGeoMap.ts`를 별 파일로
분리하고, 테스트에서는 `vi.mock`으로 stub 처리.

### 9.3 수동 검증

- 모바일 실기기 (또는 Chrome DevTools 모바일 에뮬레이션):
  권한 프롬프트 → 삽입 → 지도 카드 → 팬/줌
- 데스크탑: 동일 흐름
- Dropbox sync 라운드트립: A 기기 삽입 → 동기화 → B 기기에서 카드 렌더
- Tomboy 데스크탑 라운드트립 (선택): .note 파일을 데스크탑에서 열어
  `<link:url>geo:...</link:url>`이 일반 URL 링크로 보이는지 확인

## 10. v1 명시적 제외 (Out-of-scope)

다음은 모두 후속:

- 다중 핀 한 지도 (노트 안 모든 geo를 한 지도에 모아 보기)
- 역지오코딩 (lat/lon → 주소)
- 지도에서 핀 드롭으로 새 geo 삽입
- "내 위치로 다시 센터" 버튼 (위젯 내부)
- 두 좌표 간 거리 / 경로
- 타일 프로바이더 폴백 체인 / 설정 가능한 타일 URL
- 정적 스냅샷 (인쇄/PDF용)
- 노트북 전체 "내 노트 지도" 또는 `/desktop/graph` 통합
- 주소 검색 → 좌표
- "탭 시 활성화" 인터랙션 토글 (모바일 스크롤 충돌 우회)
- 위치 정확도 표시 (`geo:lat,lon;u=10` 형태 저장 + 표시)
- 다중 지도 시 IntersectionObserver 기반 lazy init

## 11. 라이브러리 / 라이선스 / 비용

- `leaflet@^1.9` — BSD-2-Clause, ~42KB gz
- `@types/leaflet` (dev)
- 타일: OpenStreetMap (ODbL, attribution 표시 필수 — Leaflet 기본 동작)
- API 키 / 유료 서비스 없음
- 트래픽 우려: OSM Foundation 타일 서버는 "고트래픽 서비스 부적합" 명시.
  현재는 개인 사용 규모라 문제 없으나, 향후 공개 배포 트래픽 증가 시
  `appSettings`에 타일 URL을 빼두고 무료 미러로 교체하는 후속 작업 가능.
