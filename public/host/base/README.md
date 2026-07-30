# 사용할 리포터 반신 이미지

씬에 실제로 올리는 최종 에셋이다. **손으로 고치지 않는다** — `../draft/`의 승인 아트에서
`tools/host-base-align.mjs`로 파생시킨 결과물이므로, 고칠 일이 있으면 draft를 갈고 도구를 다시 돌린다.

| 파일 | 캐릭터 | 담당 |
|---|---|---|
| `mia.png` | 미아 | 신작 첫인상·이벤트 속보 |
| `rei.png` | 레이 | 현장 취재·심층 리포트 |
| `kai.png` | 카이 | 데이터·분석 |

## 규격

900 × 1350 (2:3) · 배경 투명(알파) · 머리~허벅지 반신 정면 직립
광대선(눈높이) y = 23.5% · 얼굴 광대폭 = 22.5% · 얼굴 중심 x = 50%

카이만 `SCALE_NUDGE = 1.20`이 적용돼 얼굴폭이 26.8%다. 짧은 남성 헤어라 머리 위 여백이 커서
같은 얼굴 크기로는 작아 보였고, 키가 큰 설정을 살려 올렸다.

정수리 여백은 고정하지 않는다(헤어 볼륨만큼 캐릭터별로 다르다).
앵커 로지(`../rosie.png`)는 바스트업이라 이 규격에 포함되지 않는다.

## 재생성

```bash
node tools/host-base-align.mjs --in public/host/draft/kai.png --out public/host/base/kai.png
# 규격 정렬 + 배경 알파 컷 + 캐릭터별 스케일 보정이 한 번에 적용된다

# 3인 눈높이가 한 선에 오는지 확인
node tools/host-base-align.mjs --sheet public/host/base/mia.png public/host/base/rei.png public/host/base/kai.png /tmp/sheet.png
```

상세 근거는 `../../../CHARACTERS-REPORTERS-DRAFT.md` §5, 시안 이력은 `../../../host-archive/`.
