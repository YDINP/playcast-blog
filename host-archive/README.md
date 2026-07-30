# 리포터 캐릭터 시안 아카이브

VIP(playcast) 리포터 캐릭터를 만드는 과정에서 생성한 **모든 시안**을 모아둔 곳이다.
설계 결정의 근거와 함정은 `../CHARACTERS-REPORTERS-DRAFT.md`에 정리돼 있다.

> ⚠ **PNG는 git에서 제외된다**(`.gitignore`의 `host-archive/**/*.png`).
> 49장 73MB이고 대부분 폐기 시안이라 저장소 히스토리에 넣을 가치가 없다.
> 이 README만 버전 관리되므로, 파일이 사라졌다면 여기 목록으로 어떤 시안이 있었는지 확인할 수 있다.
> 버전 관리가 필요하면 해당 `.gitignore` 줄을 지우면 된다.

## 폴더

| 경로 | 내용 |
|---|---|
| `mia/` `rei/` `kai/` | 캐릭터별 시안 (파일명에 버전과 결과 표시) |
| `_sheets/` | 정렬 검증 시트, 스케일 비교, 리터치 전후 비교 |

파일명 접미사: `ADOPTED`=채택, `FINAL`=최종본, `FAILED`/`DISCARDED`=실패·폐기

## 실제로 쓰이는 이미지는 여기가 아니다

| 경로 | 내용 |
|---|---|
| `../public/host/draft/` | **승인된 원본 아트** (mia, rei, kai) — 생성 결과 그대로 |
| `../public/host/base/` | **사용할 반신 이미지** 900×1350 알파 PNG — draft에서 도구로 파생 |

---

## 미아 (Mia)

| 파일 | 내용 |
|---|---|
| `v1-bustup.png` | 최초 시안. 바스트업 데스크 구도. 그림체는 1회로 합격 |
| `v2-halfbody-jacket-draped.png` | 반신 통일 + 재킷을 어깨에 걸침 |
| `v2-halfbody-jacket-worn-ADOPTED.png` | **채택**. 재킷 정식 착용 + 소매 롤업 (팔 분리가 쉬워 리깅에 유리) |

## 레이 (Rei)

| 파일 | 내용 |
|---|---|
| `v1-shortcut-slate.png` / `v1-shortcut-ashbrown.png` | 첫 시안. 준실사로 이탈 — 눈 작고 25세 이상, 명암 무거움 |
| `v2-crewstyle-slate.png` / `v2-crewstyle-ashbrown.png` | 미아를 절대 기준으로 크루 그림체 복귀 |
| `v3-bigeyes-a.png` / `v3-bigeyes-b.png` | 눈 확대 시도 → **무반영**. 원인은 프롬프트가 아니라 참조 이미지 미로드였다 |
| `v4-bob.png` | 턱선 단발. 눈 크기·22세 얼굴·홍조까지 크루 규격 달성 |
| `v4-medium.png` | 어깨 길이 → 눈 작아지고 얼굴 길어져 후퇴 |
| `v5-shoulder-straight.png` / `v5-shoulder-layered.png` | 참조 경로 수정 후 얼굴 고정 성공. 단 길이가 요청보다 짧음 |
| `v6-longer-a.png` / `v6-longer-b.png` | 실제 어깨선까지 연장 + 랜야드 우측 배치 |
| `v7-upright-a-ADOPTED.png` | **채택**. 정면 직립 (좌우 대칭이라 리그 파츠 분해에 적합) |
| `v7-upright-b.png` | 정면 직립 대안. 마이크 케이블·랜야드가 몸을 가로질러 탈락 |

## 카이 (Kai)

바스트업으로 시작해 한 번 보류됐다가 재개, 최종적으로 반신 정면 직립으로 통일했다.

| 파일 | 내용 |
|---|---|
| `v1-twotone-vest.png` | 최초 시안. 투톤 헤어 + 니트베스트. 세이넨 극화체로 이탈 |
| `v2-solid-cobalt.png` / `v2-solid-navy.png` | 머리 단일색화. 눈매·턱선 순화 |
| `v3-novest-a.png` / `v3-novest-b.png` | 니트베스트 제거 |
| `v4-sharp-slickback-a.png` / `v4-sharp-slickback-b.png` | 샤프 + 올백 깐머리. 눈매가 사나워지고 연령 30대로 상승 |
| `v5-softened-inknavy.png` / `v5-softened-ashslate.png` | 눈매 순화 + 차분한 저채도 팔레트 |
| `v6-slick.png` / `v6-softback.png` | v3a 무드 + v5 색감·디테일 결합 |
| `mix1-a.png` / `mix1-b.png` | v1↔v2navy 중간 시도. 축이 모호해 헛돎 |
| `mix2-young-ADOPTED-bustup.png` | **바스트업 단계 채택본**. 나이·그림체를 중간값 양쪽으로 브래킷해 고름 |
| `mix2-mature.png` | 같은 브래킷의 성숙한 쪽 |
| `half1-a.png` / `half1-b.png` | 반신 정면 직립 1차 |
| `half2-faceB-bodyA-FAILED-*.png` | 얼굴 B + 몸 A 조합 시도 → **실패**. 상대 표현으로 지시해 B보다 더 날카롭고 늙게 나옴 |
| `half3-faceB-restored-a.png` / `-b.png` | 절대 묘사 + 실패본을 부정 참조로 넣어 얼굴 복구 |
| `half4-bishounen-a.png` | 20세 미형 시도 |
| `half4-bishounen-b-ADOPTED.png` | **채택**. 체형·비율·프레임이 가장 좋음 |
| `half5-regen-DISCARDED-*.png` | 속눈썹·볼터치 제거를 재생성으로 시도 → **폐기**. 프레임이 2:3→1:2로 변하고 마이크 든 손이 반전 |
| `half4-b-retouched-FINAL.png` | **최종본**. half4-b에서 아래 속눈썹·볼터치만 국소 리터치 (= `public/host/draft/kai.png`) |

## _sheets

| 파일 | 내용 |
|---|---|
| `crew-alignment-sheet.png` | 3인 눈높이 정렬 검증(빨간선=광대선 기준) |
| `crew-alpha-check.png` | 배경 알파 컷 검증(마젠타 배경) |
| `kai-scale-compare.png` | 카이 스케일 보정 비교 (미아 / 1.00 / 1.12 / 1.25) |
| `kai-retouch-1to1.png` | 리터치 전후 1:1 실제 크기 비교 — **수용 판단은 이걸로 한다** |
| `kai-retouch-zoom.png` | 리터치 전후 확대 비교 — 눈 손상 여부 확인용 |
| `kai-face-zoom-before.png` | 리터치 전 얼굴 확대 (속눈썹·볼터치 확인) |
