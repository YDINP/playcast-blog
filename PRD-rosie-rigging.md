# PRD — 로지 아바타 리깅 (표정 + 립싱크 + 깜빡임)

## 목표
정적 rosie.png(단일 합성)를 **베이스 + 교체 오버레이(눈·눈썹·입)** 레이어 구조로 바꿔,
scene-player가 씬 `emotion`과 타이핑 리듬(`--mouth`)에 따라 표정/입모양을 실시간 변경.

## 현황(재사용 가능한 인프라 — JS)
- `.sp-host` rigLoop: 흔들림/끄덕임 transform, POSE(emo별 몸짓), `.rig-parts` 시차, `.rig-pupil` 추적
- `--mouth`(타이핑되는 글자마다 0.12~1.25), `.is-talking`, `.rig-blink`+`.is-blink`(startBlink 스케줄러)
- 씬 `emotion` → `.sp-host.emo-<emotion>` (콘텐츠가 쓰는 값: **idle/happy/surprised/think** 4종)
- pupil 추적은 사용자 요청으로 제외(정적 눈)

## 애셋(저장된 위치·크기 = .tmp/rosie-editor-state.json)
- base: 뒷머리(현재 OFF)+바디+얼굴+앞머리 → 정적 `rosie-base.png`
- 오버레이: eyes2.png, brows.png, mouth-0..3.png (얼굴 기준 좌표)

## 구현
### Phase 1 — 스캐폴드(idle + 립싱크 + 깜빡임)
1. export: 저장상태로 base.png 합성 + 각 오버레이 최종 rect(%) 산출 → `rig.json`
2. HostRig.astro: `.sp-host > .rig-parts > (.rig-base, .rig-mouth, .rig-mouth-open, .rig-eyes.rig-blink, .rig-brows)` 저장 좌표(%)로 배치
3. global.css: `--mouth`→mouth-open scaleY, `.is-blink`→눈 scaleY squash
4. /watch 페이지에서 재생·깜빡임 검증

### Phase 2 — 표정 아트(happy/surprised/think)
- codex로 표정별 눈/눈썹 아트 생성 → 컷·정렬
- CSS: `.emo-happy .rig-eyes` 등으로 해당 표정 파트 노출, 기본(idle) 숨김
- surprised=입 크게(--mScale), think=눈썹 기울임 등 POSE 연동

## 완료 기준
- idle 정지 모습이 현재 rosie.png와 동일
- 재생 시 타이핑 리듬대로 입 움직임 + 주기적 깜빡임
- happy/surprised/think 씬에서 표정 전환
- 로컬 검증(커밋은 사용자 지시 후)
