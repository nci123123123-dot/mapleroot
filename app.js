'use strict';

// ── OCR 서버 설정 ─────────────────────────────────────────────────────────────
// 배포 후 실제 서버 URL로 변경하세요
const OCR_SERVER_URL = 'https://your-ocr-server.railway.app';

// ── 상태 ────────────────────────────────────────────────────────────────────
const S = {
    stream:       null,
    isCapturing:  false,
    isMonitoring: false,
    workerValue:  null,
    workerReady:  false,
    ocrRunning:   false,

    // 두 인식 영역 { x, y, w, h } 표시 좌표계 (클릭 중심점 기반 고정 박스)
    regions: { meso: null, sol: null },

    // 박스 크기 (px 절대값) — +/- 버튼으로 4px씩 조절
    // 메소: 가로로 긴 텍스트 / 솔: 아이템 슬롯 전체(정사각형)
    boxPx: { meso: { w: 104, h: 12 }, sol: { w: 80, h: 12 } },  // 두 값 모두 고정

    // ImageCapture 인스턴스 (고화질 정지 프레임용)
    imageCapture: null,

    // 클릭 선택 상태
    selMode: null,   // 'meso' | 'sol' | null

    // 박스 드래그 상태
    dragBox:    null,   // 'meso' | 'sol' | null
    dragOffset: null,   // { dx, dy }

    // 마지막 OCR 원본 텍스트 (수정 학습용)
    lastRaw: { meso: '', sol: '' },

    // 마지막 이진화 캔버스 (템플릿 학습용)
    lastSolBinary:  null,
    lastMesoBinary: null,

    // OCR 안정화 버퍼 — 2회 연속 같은 값이어야 확정
    candidate:  { meso: null, sol: null },
    candCount:  { meso: 0,    sol: 0    },

    // 델타 추적
    prevMeso: null,
    prevSol:  null,

    // 세션
    sessionStart:      null,
    sessionTimer:      null,
    idleTimer:         null,   // 30초 무변화 → 세션 자동 종료
    recordTimer:       null,   // 10분마다 누적 기록
    lastRecordedMeso:  null,   // 마지막 기록 시점의 메소
    lastRecordedSol:   null,   // 마지막 기록 시점의 조각
    monitorTimer:      null,
    logs:              [],
    totalGainMeso:     0,
    totalGainSol:      0,
};

// ── DOM ─────────────────────────────────────────────────────────────────────
const D = {
    video:            document.getElementById('screen-video'),
    selCanvas:        document.getElementById('sel-canvas'),
    placeholder:      document.getElementById('placeholder'),
    ocrMesoRawCanvas: document.getElementById('ocr-meso-raw-canvas'),
    ocrSolRawCanvas:  document.getElementById('ocr-sol-raw-canvas'),
    ocrMesoCanvas:    document.getElementById('ocr-meso-canvas'),
    ocrSolCanvas:     document.getElementById('ocr-sol-canvas'),
    rawMesoText:      document.getElementById('raw-meso-text'),
    rawSolText:       document.getElementById('raw-sol-text'),
    parsedMeso:       document.getElementById('parsed-meso'),
    parsedSol:        document.getElementById('parsed-sol'),
    btnCapture:    document.getElementById('btn-capture'),
    btnStop:       document.getElementById('btn-stop-capture'),
    btnSelMeso:    document.getElementById('btn-sel-meso'),
    btnSelSol:     document.getElementById('btn-sel-sol'),
    btnMonitor:    document.getElementById('btn-monitor'),
    btnForce:      document.getElementById('btn-force-ocr'),
    btnClearLog:     document.getElementById('btn-clear-log'),
    btnSaveSession:  document.getElementById('btn-save-session'),
    btnHistory:      document.getElementById('btn-history'),
    intervalSel:   document.getElementById('interval-sel'),
    step2Box:      document.getElementById('step2-box'),
    step3Box:      document.getElementById('step3-box'),
    selStatus:     document.getElementById('sel-status'),
    sessionTime:   document.getElementById('session-time'),
    statusMsg:     document.getElementById('status-msg'),
    ocrState:      document.getElementById('ocr-state'),
    logBody:       document.getElementById('log-body'),
    logEmpty:      document.getElementById('log-empty'),
    curMeso:       document.getElementById('cur-meso'),
    curSol:        document.getElementById('cur-sol'),
    statMeso:      document.getElementById('stat-meso'),
    statSol:       document.getElementById('stat-sol'),
};

// ── 유틸 ────────────────────────────────────────────────────────────────────
const fmt  = n => Math.round(n).toLocaleString('ko-KR');
const hms  = d => d.toTimeString().slice(0, 8);
const clsM = n => n > 0 ? 'td-gain-meso' : n < 0 ? 'td-neg' : 'td-muted';
const clsS = n => n > 0 ? 'td-gain-sol'  : n < 0 ? 'td-neg' : 'td-muted';

/** 메소를 억/만/일 단위 한국 표기로 변환. 예: 1308490078 → "13억 849만 78" */
function fmtMeso(n) {
    if (n === null || n === undefined || isNaN(n)) return '-';
    n = Math.round(n);
    if (n === 0) return '0';
    const neg  = n < 0;
    const abs  = Math.abs(n);
    const eok  = Math.floor(abs / 1e8);
    const man  = Math.floor((abs % 1e8) / 1e4);
    const ones = abs % 1e4;
    let s = '';
    if (eok  > 0) s += eok  + '억 ';
    if (man  > 0) s += man  + '만 ';
    if (ones > 0 || s === '') s += ones.toLocaleString('ko-KR');
    return (neg ? '-' : '') + s.trim();
}
const signMeso = n => n > 0 ? `+${fmtMeso(n)}` : n < 0 ? `-${fmtMeso(-n)}` : '-';
const signSol  = n => n > 0 ? `+${fmt(n)}` : n < 0 ? fmt(n) : '-';

function setStatus(msg, c = '') {
    D.statusMsg.textContent = msg;
    D.ocrState.className    = 'ocr-state ' + c;
    D.ocrState.textContent  =
        c === 'active'     ? '● 모니터링 중'  :
        c === 'processing' ? '⏳ 인식 중...'   :
        c === 'error'      ? '✗ 오류'          : '';
}

function stepEnable(el, on) {
    el.style.opacity       = on ? '1'    : '.4';
    el.style.pointerEvents = on ? 'auto' : 'none';
}

function updateSelStatus() {
    const mesoOk = !!S.regions.meso;
    const solOk  = !!S.regions.sol;
    const lines  = [];
    lines.push(mesoOk ? '💰 메소 ✓ (드래그 이동 가능)' : '💰 메소 — 미지정');
    lines.push(solOk  ? '🔷 조각 ✓ (드래그 이동 가능)' : '🔷 조각 — 미지정');
    D.selStatus.innerHTML = lines.join('<br>');

    const ready = mesoOk || solOk;
    D.btnMonitor.disabled = !ready;
    D.btnForce.disabled   = !ready;
    if (ready) stepEnable(D.step3Box, true);

    // 박스가 있으면 캔버스 항상 인터랙티브
    D.selCanvas.style.pointerEvents = (mesoOk || solOk) ? 'auto' : '';
}

// ── 숫자 파싱 ────────────────────────────────────────────────────────────────
function parseKoreanMeso(raw) {
    if (!raw) return null;

    // 정규화: 콤마/점 제거, 알려진 오인식 문자 교체
    const norm = raw
        .replace(/[,，.·]/g, '')
        .replace(/[먹역엌먺억]/g, '억')   // 억 오인식 (억 자체도 포함해 정규화)
        .replace(/[판반딴만]/g, '만')     // 만 오인식
        .replace(/[oO]/g, '0')           // 0 → o 오인식
        .replace(/[lI|]/g, '1')          // 1 → l/I 오인식
        .replace(/\s+/g, ' ')            // 연속 공백 정리
        .trim();

    // ── 방법 1: 억+만 둘 다 찾은 경우 (가장 신뢰)
    const eok = norm.match(/(\d{1,3})\s*억/);
    const man = norm.match(/(\d{1,4})\s*만/);
    if (eok && man) {
        const total = parseInt(eok[1])*1e8 + parseInt(man[1])*1e4;
        const rem = norm.replace(/\d+\s*억/, '').replace(/\d+\s*만/, '');
        return Math.round(total + parseInt(rem.match(/\d+/)?.[0] ?? '0'));
    }

    // ── 방법 2: 구조적 위치 파싱 (한글 인식 결과 무관)
    // "숫자(1-3자리) + 구분자(1글자 이상) + 숫자(1-4자리) + 구분자 + 숫자(1-4자리)"
    const s3 = norm.match(/(\d{1,3})\D+?(\d{1,4})\D+?(\d{1,4})(?:\D|$)/);
    if (s3) return Math.round(+s3[1]*1e8 + +s3[2]*1e4 + +s3[3]);

    // 억/만 없고 숫자 사이 공백만 있는 경우 ("13 1027 7640")
    const s3sp = norm.match(/^(\d{1,3})\s+(\d{1,4})\s+(\d{1,4})$/);
    if (s3sp) return Math.round(+s3sp[1]*1e8 + +s3sp[2]*1e4 + +s3sp[3]);

    // 억만 있거나 만만 있을 때
    if (eok) {
        const parts = norm.replace(/\d+\s*억/, '').match(/\d+/g) || [];
        if (parts.length >= 1) return Math.round(parseInt(eok[1])*1e8 + parseInt(parts[0])*1e4);
    }
    if (man) {
        const parts = norm.replace(/\d+\s*만/, '').match(/\d+/g) || [];
        // 만 앞에 숫자가 있으면 그게 억
        const beforeMan = norm.split(/\d+\s*만/)[0];
        const eokVal = beforeMan.match(/(\d{1,3})\D*$/)?.[1];
        if (eokVal) return Math.round(parseInt(eokVal)*1e8 + parseInt(man[1])*1e4 + parseInt(parts[0] ?? '0'));
        return Math.round(parseInt(man[1])*1e4 + parseInt(parts[0] ?? '0'));
    }

    // ── 방법 3: 숫자 그룹만 추출해서 위치로 처리
    const parts = (norm.match(/\d+/g) || []).map(Number);
    if (parts.length === 3) return Math.round(parts[0]*1e8 + parts[1]*1e4 + parts[2]);
    if (parts.length === 2) {
        const [a, b] = parts;
        if (a <= 999) return Math.round(a*1e8 + b*1e4);
        return Math.round(a*1e4 + b);
    }
    // 숫자 1개만 있는 경우: 최소 1만 이상이어야 메소로 인정 (노이즈 방지)
    if (parts.length === 1 && parts[0] >= 10000) return parts[0];

    return null;
}

function parseSolCount(raw) {
    if (!raw) return null;

    // 흔한 오인식 보정: I/l/| → 1, O → 0, S → 5, B → 8
    let norm = raw
        .replace(/[IlL|]/g, '1')
        .replace(/[Oo]/g, '0')
        .replace(/S/g, '5')
        .replace(/B/g, '8')
        .trim();

    // 숫자 사이 공백 제거 (예: "1 0" → "10", "1  2" → "12")
    norm = norm.replace(/(\d)\s+(\d)/g, '$1$2');
    // 혹시 두 번 이상 붙어있는 공백도 처리
    norm = norm.replace(/(\d)\s+(\d)/g, '$1$2');

    // 첫 번째 숫자 그룹 추출
    const match = norm.match(/\d+/);
    if (!match) return null;
    const val = parseInt(match[0], 10);
    return val > 0 ? val : null;
}

// ── OCR 안정화 ───────────────────────────────────────────────────────────────

/**
 * 2회 연속 같은 값(또는 허용 오차 이내)이 나와야 확정값 반환
 * 메소: 만 단위(10,000) 반올림 — OCR 소수점 노이즈 흡수
 * 조각: 정수 완전 일치
 */
const MESO_SNAP = 10_000;

function tryConfirm(type, rawVal) {
    if (rawVal === null) return null;
    const snapped = type === 'meso'
        ? Math.round(rawVal / MESO_SNAP) * MESO_SNAP
        : rawVal;

    if (snapped === S.candidate[type]) {
        S.candCount[type]++;
    } else {
        S.candidate[type] = snapped;
        S.candCount[type] = 1;
    }
    return S.candCount[type] >= 2 ? snapped : null;
}

// ── OCR 수정 학습 ────────────────────────────────────────────────────────────

/** 두 문자열 유사도 (0~1, Levenshtein 기반) */
function strSim(a, b) {
    if (a === b) return 1;
    if (!a || !b) return 0;
    const la = a.length, lb = b.length;
    let prev = Array.from({ length: lb + 1 }, (_, i) => i);
    for (let i = 1; i <= la; i++) {
        const cur = [i];
        for (let j = 1; j <= lb; j++) {
            cur[j] = a[i-1] === b[j-1] ? prev[j-1] :
                1 + Math.min(prev[j], cur[j-1], prev[j-1]);
        }
        prev = cur;
    }
    return 1 - prev[lb] / Math.max(la, lb);
}

const CORR_KEY = type => `maple_ocr_corrections_${type}`;

/** 수정 저장 (localStorage) */
function saveCorrection(type, rawText, value) {
    if (!rawText || value === null) return;
    const list = JSON.parse(localStorage.getItem(CORR_KEY(type)) || '[]');
    const hit  = list.find(c => c.raw === rawText);
    if (hit) { hit.val = value; hit.n++; }
    else      list.push({ raw: rawText, val: value, n: 1 });
    // 최대 200개 유지 (오래된 것 제거)
    if (list.length > 200) list.splice(0, list.length - 200);
    localStorage.setItem(CORR_KEY(type), JSON.stringify(list));
}

/**
 * 저장된 수정 중 유사한 OCR 텍스트 검색
 * 유사도 0.72 이상이면 저장된 값 반환
 */
function lookupCorrection(type, rawText) {
    if (!rawText) return null;
    const list = JSON.parse(localStorage.getItem(CORR_KEY(type)) || '[]');
    let best = null, bestSim = 0.72;
    for (const c of list) {
        const s = strSim(rawText.trim(), c.raw.trim());
        if (s > bestSim) { bestSim = s; best = c; }
    }
    return best ? best.val : null;
}

/** 수정 횟수 통계 반환 */
function correctionStats() {
    return ['meso', 'sol'].map(t => {
        const list = JSON.parse(localStorage.getItem(CORR_KEY(t)) || '[]');
        return { type: t, count: list.length };
    });
}

// ── 이미지 전처리 ────────────────────────────────────────────────────────────

/** 그레이스케일 배열 추출 */
function toGray(d, n) {
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) g[i] = 0.299*d[i*4] + 0.587*d[i*4+1] + 0.114*d[i*4+2];
    return g;
}

/**
 * 언샤프 마스킹 (CSS blur 기반, GPU 가속)
 * 선명도 ↑ → 작은 텍스트 획이 뭉개지지 않게 함
 */
function unsharpMask(src, radius = 1.2, amount = 3.5) {
    const dst = document.createElement('canvas');
    dst.width = src.width; dst.height = src.height;
    const ctx = dst.getContext('2d');

    // 블러본을 오프스크린에 생성
    const blurred = document.createElement('canvas');
    blurred.width = src.width; blurred.height = src.height;
    const bCtx = blurred.getContext('2d');
    bCtx.filter = `blur(${radius}px)`;
    bCtx.drawImage(src, 0, 0);
    bCtx.filter = 'none';

    ctx.drawImage(src, 0, 0);
    const orig = ctx.getImageData(0, 0, dst.width, dst.height);
    const blur = bCtx.getImageData(0, 0, dst.width, dst.height);
    const od = orig.data, bd = blur.data;
    for (let i = 0; i < od.length; i += 4) {
        for (let c = 0; c < 3; c++) {
            od[i+c] = Math.min(255, Math.max(0,
                od[i+c] + amount * (od[i+c] - bd[i+c])));
        }
    }
    ctx.putImageData(orig, 0, 0);
    return dst;
}

/**
 * 적응형 임계화 (Integral Image 기반, O(n) 속도)
 * 인벤토리처럼 배경이 불균일할 때 전역 Otsu보다 훨씬 정확
 * 각 픽셀의 임계값 = 로컬 블록 평균 - C
 */
function adaptiveThreshold(src, blockSize, C = 8) {
    const W = src.width, H = src.height;
    // blockSize는 홀수, 최소 3, 최대 이미지 단변의 절반
    const bs = Math.max(3, Math.min(
        blockSize || Math.floor(Math.min(W, H) / 2) | 1,
        Math.floor(Math.min(W, H) * 0.8) | 1
    )) | 1;   // 홀수 보장

    const dst = document.createElement('canvas');
    dst.width = W; dst.height = H;
    const ctx = dst.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const id = ctx.getImageData(0, 0, W, H);
    const d  = id.data;
    const gray = toGray(d, W * H);

    // 적분 이미지
    const ii = new Float64Array((W+1) * (H+1));
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            ii[(y+1)*(W+1)+(x+1)] = gray[y*W+x]
                + ii[y*(W+1)+(x+1)]
                + ii[(y+1)*(W+1)+x]
                - ii[y*(W+1)+x];
        }
    }

    const half = bs >> 1;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const x1 = Math.max(0, x - half), x2 = Math.min(W-1, x + half);
            const y1 = Math.max(0, y - half), y2 = Math.min(H-1, y + half);
            const cnt = (x2-x1+1) * (y2-y1+1);
            const sum = ii[(y2+1)*(W+1)+(x2+1)]
                      - ii[y1*(W+1)+(x2+1)]
                      - ii[(y2+1)*(W+1)+x1]
                      + ii[y1*(W+1)+x1];
            const thresh = sum / cnt - C;
            const val = gray[y*W+x] > thresh ? 0 : 255;  // 밝음=텍스트 → 검정
            const idx = (y*W+x)*4;
            d[idx] = d[idx+1] = d[idx+2] = val; d[idx+3] = 255;
        }
    }
    ctx.putImageData(id, 0, 0);
    return dst;
}

/**
 * Otsu 전역 이진화 (단순 배경에서 빠른 대안)
 */
function otsuBinarize(src, invert = true) {
    const dst = document.createElement('canvas');
    dst.width = src.width; dst.height = src.height;
    const ctx = dst.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const id = ctx.getImageData(0, 0, dst.width, dst.height);
    const d  = id.data;
    const n  = d.length / 4;
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4)
        hist[Math.round(0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2])]++;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, maxVar = 0, thresh = 128;
    for (let t = 0; t < 256; t++) {
        wB += hist[t]; if (!wB) continue;
        const wF = n - wB; if (!wF) break;
        sumB += t * hist[t];
        const v = wB * wF * (sumB/wB - (sum-sumB)/wF) ** 2;
        if (v > maxVar) { maxVar = v; thresh = t; }
    }
    for (let i = 0; i < d.length; i += 4) {
        const g = Math.round(0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2]);
        const v = (g > thresh) === invert ? 0 : 255;
        d[i] = d[i+1] = d[i+2] = v; d[i+3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    return dst;
}

/** 히스토그램 스트레칭 */
function enhanceContrast(src) {
    const dst = document.createElement('canvas');
    dst.width = src.width; dst.height = src.height;
    const ctx = dst.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const id = ctx.getImageData(0, 0, dst.width, dst.height);
    const d  = id.data;
    let lo = 255, hi = 0;
    for (let i = 0; i < d.length; i += 4) {
        const g = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
        if (g < lo) lo = g; if (g > hi) hi = g;
    }
    const range = hi - lo || 1;
    for (let i = 0; i < d.length; i += 4) {
        const g = Math.round(((0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2]) - lo) / range * 255);
        d[i] = d[i+1] = d[i+2] = g; d[i+3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    return dst;
}

/** 어두운 무채색 픽셀 검출 — 숫자 검은 외곽선만 추출 (글로우·스프라이트 제외) */
function darkOutlineThreshold(src, vMax = 0.52, sMax = 0.38) {
    const dst = document.createElement('canvas');
    dst.width = src.width; dst.height = src.height;
    const ctx = dst.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const id = ctx.getImageData(0, 0, dst.width, dst.height);
    const d  = id.data;
    for (let i = 0; i < d.length; i += 4) {
        const r = d[i]/255, g = d[i+1]/255, b = d[i+2]/255;
        const mx = Math.max(r,g,b), mn = Math.min(r,g,b);
        const s  = mx === 0 ? 0 : (mx - mn) / mx;
        const v  = mx;
        // bicubic 블렌딩으로 외곽선이 스프라이트 색과 섞임 → S 제약 제거, V만으로 판별
        // 글로우(v>0.52)만 제외, 스프라이트 어두운 픽셀도 포함(size필터로 제거)
        const isOutline = (v < vMax);
        d[i] = d[i+1] = d[i+2] = isOutline ? 0 : 255; d[i+3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    // dilate 3회 → 블러된 외곽선 조각을 이어붙여 솔리드 숫자로 복원
    let result = dst;
    for (let i = 0; i < 3; i++) result = morphOp(result, 1, 'dilate');
    return result;
}

/** 단순 밝기 임계값 — 그레이스케일 > thresh 이면 텍스트(검정), 아니면 배경(흰색) */
function brightThreshold(src, thresh = 160) {
    const dst = document.createElement('canvas');
    dst.width = src.width; dst.height = src.height;
    const ctx = dst.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const id = ctx.getImageData(0, 0, dst.width, dst.height);
    const d  = id.data;
    for (let i = 0; i < d.length; i += 4) {
        const gray = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
        const v    = gray > thresh ? 0 : 255;  // 밝으면 검정(텍스트), 어두우면 흰색(배경)
        d[i] = d[i+1] = d[i+2] = v; d[i+3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    return dst;
}

/** 색상 필터 — HSV 기반 (밝기 무관, 색조로만 판별) */
function colorFilterHSV(src, type) {
    const dst = document.createElement('canvas');
    dst.width = src.width; dst.height = src.height;
    const ctx = dst.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const id = ctx.getImageData(0, 0, dst.width, dst.height);
    const d  = id.data;

    for (let i = 0; i < d.length; i += 4) {
        const r = d[i] / 255, g = d[i+1] / 255, b = d[i+2] / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const delta = max - min;

        // Hue 계산 (0~360)
        let h = 0;
        if (delta > 0) {
            if (max === r)      h = 60 * (((g - b) / delta) % 6);
            else if (max === g) h = 60 * ((b - r) / delta + 2);
            else                h = 60 * ((r - g) / delta + 4);
            if (h < 0) h += 360;
        }
        const s = max === 0 ? 0 : delta / max;  // Saturation
        const v = max;                            // Value (밝기)

        let isText = false;
        if (type === 'meso') {
            // 메이플 메소 금색: H=38~52°, S>0.40, V>0.50 (범위 좁혀 배경 UI 원소 차단)
            isText = (h >= 38 && h <= 52 && s > 0.40 && v > 0.50)
                  || (s < 0.15 && v > 0.78);   // 순수 흰색 텍스트 보조
        } else {
            // 순수 흰색 숫자: S<0.22, V>0.70
            // 그림자(파란 스프라이트 그림자, S>0.10 또는 V<0.70) 및 스프라이트(S>0.25) 제거
            isText = (s < 0.22 && v > 0.70);
        }
        d[i] = d[i+1] = d[i+2] = isText ? 0 : 255; d[i+3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    return dst;
}

/**
 * 솔 에르다 조각 스프라이트 마스킹
 * 아이템 아이콘의 파란/보라 계열 픽셀을 흰색(배경)으로 치환
 * → 이후 threshold/OCR 단계에서 숫자 픽셀만 남음
 * HSV 범위: H=195~300°(파랑~보라), S>0.20, V>0.10
 */
function removeSolSprite(src) {
    const dst = document.createElement('canvas');
    dst.width = src.width; dst.height = src.height;
    const ctx = dst.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const id = ctx.getImageData(0, 0, dst.width, dst.height);
    const d  = id.data;

    for (let i = 0; i < d.length; i += 4) {
        const r = d[i] / 255, g = d[i+1] / 255, b = d[i+2] / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const delta = max - min;

        let h = 0;
        if (delta > 0) {
            if (max === r)      h = 60 * (((g - b) / delta) % 6);
            else if (max === g) h = 60 * ((b - r) / delta + 2);
            else                h = 60 * ((r - g) / delta + 4);
            if (h < 0) h += 360;
        }
        const s = max === 0 ? 0 : delta / max;
        const v = max;

        // 파란/보라 계열 → 흰색(배경)으로 날려버림
        if (h >= 195 && h <= 300 && s > 0.20 && v > 0.10) {
            d[i] = d[i+1] = d[i+2] = 255;
        }
        d[i+3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    return dst;
}

/**
 * 모폴로지 연산 공통 커널
 * mode='erode' : 주변에 흰 픽셀 하나라도 있으면 흰색 (검정 픽셀 축소)
 * mode='dilate': 주변에 검은 픽셀 하나라도 있으면 검정 (검정 픽셀 팽창)
 */
function morphOp(src, size, mode) {
    const W = src.width, H = src.height;
    const dst  = document.createElement('canvas');
    dst.width  = W; dst.height = H;
    const dCtx = dst.getContext('2d');
    const sData = src.getContext('2d').getImageData(0, 0, W, H).data;
    const out   = dCtx.createImageData(W, H);
    const od    = out.data;

    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            let found = false;
            outer: for (let dy = -size; dy <= size; dy++) {
                for (let dx = -size; dx <= size; dx++) {
                    const nx = x + dx, ny = y + dy;
                    if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
                        const px = sData[(ny * W + nx) * 4];
                        if (mode === 'dilate' && px === 0) { found = true; break outer; }
                        if (mode === 'erode'  && px === 255) { found = true; break outer; }
                    }
                }
            }
            const idx = (y * W + x) * 4;
            // dilate: found(검정 이웃) → 검정. erode: found(흰 이웃) → 흰색
            od[idx] = od[idx+1] = od[idx+2] = (mode === 'dilate') === found ? 0 : 255;
            od[idx+3] = 255;
        }
    }
    dCtx.putImageData(out, 0, 0);
    return dst;
}

/**
 * Bilateral Filter — 엣지(텍스트 획) 보존하며 배경 노이즈만 제거
 * Gaussian blur와 달리 색상 차이가 큰 경계(텍스트 윤곽)는 흐리지 않음
 * d: 커널 반지름, sigmaColor: 색상 민감도, sigmaSpace: 공간 거리 민감도
 */
function bilateralFilter(canvas, d = 3, sigmaColor = 20, sigmaSpace = 2) {
    const W = canvas.width, H = canvas.height;
    const dst = document.createElement('canvas');
    dst.width = W; dst.height = H;
    const src = canvas.getContext('2d').getImageData(0, 0, W, H);
    const out = dst.getContext('2d').createImageData(W, H);
    const sd = src.data, od = out.data;

    // 공간 가중치 사전계산 (변하지 않으므로 루프 밖에서)
    const spatialW = [];
    const ss2 = 2 * sigmaSpace * sigmaSpace;
    for (let dy = -d; dy <= d; dy++)
        for (let dx = -d; dx <= d; dx++)
            spatialW.push(Math.exp(-(dx*dx + dy*dy) / ss2));

    const sc2 = 2 * sigmaColor * sigmaColor;

    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const pi  = (y * W + x) * 4;
            const cR  = sd[pi], cG = sd[pi+1], cB = sd[pi+2];
            let sR = 0, sG = 0, sB = 0, sw = 0, si = 0;

            for (let dy = -d; dy <= d; dy++) {
                for (let dx = -d; dx <= d; dx++) {
                    const nx = Math.min(W-1, Math.max(0, x+dx));
                    const ny = Math.min(H-1, Math.max(0, y+dy));
                    const ni = (ny * W + nx) * 4;
                    const dR = sd[ni]-cR, dG = sd[ni+1]-cG, dB = sd[ni+2]-cB;
                    const w  = spatialW[si++] * Math.exp(-(dR*dR+dG*dG+dB*dB) / sc2);
                    sR += sd[ni]*w; sG += sd[ni+1]*w; sB += sd[ni+2]*w; sw += w;
                }
            }
            od[pi] = sR/sw; od[pi+1] = sG/sw; od[pi+2] = sB/sw; od[pi+3] = 255;
        }
    }
    dst.getContext('2d').putImageData(out, 0, 0);
    return dst;
}

// ── 솔 조각 템플릿 매칭 시스템 ────────────────────────────────────────────────
// Tesseract 대신 픽셀폰트 전용 매칭 → 훨씬 정확하고 빠름
// 보정(✏️) 버튼으로 맞는 값 입력 시 자동으로 숫자 템플릿 학습

const TMPL_W = 7, TMPL_H = 11;  // 정규화 템플릿 크기 (픽셀)
const TMPL_KEY      = 'maple-sol-tmpl-v2';   // v2: 4x 업스케일 기준
const MESO_TMPL_KEY = 'maple-meso-tmpl-v2';  // v2: 4x 업스케일 기준
let solTemplates  = {};  // { '0': Uint8Array, ... '9': Uint8Array }
let mesoTemplates = {};  // { '0'-'9', '억', '만': Uint8Array }

function loadSolTemplates() {
    try {
        const raw = localStorage.getItem(TMPL_KEY);
        if (!raw) return;
        for (const [k, v] of Object.entries(JSON.parse(raw)))
            solTemplates[k] = new Uint8Array(v);
    } catch {}
}

function loadMesoTemplates() {
    try {
        const raw = localStorage.getItem(MESO_TMPL_KEY);
        if (!raw) return;
        for (const [k, v] of Object.entries(JSON.parse(raw)))
            mesoTemplates[k] = new Uint8Array(v);
    } catch {}
}

function saveMesoTemplates() {
    try {
        const obj = {};
        for (const [k, v] of Object.entries(mesoTemplates)) obj[k] = Array.from(v);
        localStorage.setItem(MESO_TMPL_KEY, JSON.stringify(obj));
    } catch {}
}

function saveSolTemplates() {
    try {
        const obj = {};
        for (const [k, v] of Object.entries(solTemplates)) obj[k] = Array.from(v);
        localStorage.setItem(TMPL_KEY, JSON.stringify(obj));
    } catch {}
}

/** 이진 캔버스에서 연결된 검정 픽셀 덩어리를 추출, x좌표 순 정렬 */
function extractDigitComponents(binaryCanvas, minPx = 8) {
    const W = binaryCanvas.width, H = binaryCanvas.height;
    const data = binaryCanvas.getContext('2d').getImageData(0, 0, W, H).data;
    const visited = new Uint8Array(W * H);
    const comps = [];

    for (let start = 0; start < W * H; start++) {
        if (visited[start] || data[start * 4] >= 128) continue;
        let minX = W, maxX = 0, minY = H, maxY = 0;
        const queue = [start];
        visited[start] = 1;
        let cnt = 0;

        while (queue.length) {
            const cur = queue.pop();
            const cx = cur % W, cy = (cur / W) | 0;
            cnt++;
            if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
            if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
            for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
                const nx = cx+dx, ny = cy+dy;
                if (nx>=0 && nx<W && ny>=0 && ny<H) {
                    const ni = ny*W+nx;
                    if (!visited[ni] && data[ni*4] < 128) { visited[ni] = 1; queue.push(ni); }
                }
            }
        }
        if (cnt >= minPx) comps.push({ minX, maxX, minY, maxY });
    }
    return comps.sort((a, b) => a.minX - b.minX);
}

/** 컴포넌트를 TMPL_W × TMPL_H 이진 배열로 정규화 */
function normalizeComp(binaryCanvas, comp) {
    const { minX, minY, maxX, maxY } = comp;
    const w = maxX - minX + 1, h = maxY - minY + 1;
    const tmp = document.createElement('canvas');
    tmp.width = TMPL_W; tmp.height = TMPL_H;
    const ctx = tmp.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(binaryCanvas, minX, minY, w, h, 0, 0, TMPL_W, TMPL_H);
    const id = ctx.getImageData(0, 0, TMPL_W, TMPL_H).data;
    const arr = new Uint8Array(TMPL_W * TMPL_H);
    for (let i = 0; i < arr.length; i++) arr[i] = id[i*4] < 128 ? 0 : 1;
    return arr;
}

/** 두 정규화 배열 간 유사도 (0~1) */
function tmplSimilarity(a, b) {
    let match = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) match++;
    return match / a.length;
}

/**
 * 템플릿 매칭으로 솔 카운트 인식
 * 템플릿이 없거나 신뢰도 낮으면 null 반환 → Tesseract 폴백
 */
function recognizeSolByTemplate(binaryCanvas) {
    const known = Object.keys(solTemplates).length;
    if (known < 3) return null;  // 템플릿 3개 이상 있어야 시도

    const comps = extractDigitComponents(binaryCanvas);
    if (comps.length === 0 || comps.length > 3) return null;

    let result = '';
    for (const comp of comps) {
        const norm = normalizeComp(binaryCanvas, comp);
        let bestDigit = null, bestScore = 0;
        for (const [digit, tmpl] of Object.entries(solTemplates)) {
            const score = tmplSimilarity(norm, tmpl);
            if (score > bestScore) { bestScore = score; bestDigit = digit; }
        }
        if (bestDigit === null || bestScore < 0.68) return null;  // 신뢰도 부족 → 폴백
        result += bestDigit;
    }
    const val = parseInt(result, 10);
    return isNaN(val) || val <= 0 ? null : val;
}

/**
 * 보정값 입력 시 호출 — 현재 이진화 이미지에서 각 자리 숫자 템플릿 학습
 * 컴포넌트 수 == 자릿수일 때만 학습 (불일치 시 무시)
 */
function learnSolTemplates(binaryCanvas, correctValue) {
    const comps = extractDigitComponents(binaryCanvas);
    const digits = String(correctValue).split('');
    if (comps.length !== digits.length) return false;
    comps.forEach((comp, i) => {
        solTemplates[digits[i]] = normalizeComp(binaryCanvas, comp);
    });
    saveSolTemplates();
    updateTmplDots();
    setStatus(`✅ 솔 템플릿 학습 완료 (${Object.keys(solTemplates).length}개 숫자 저장됨)`);
    return true;
}

// ── TensorFlow.js CNN — 솔 조각 숫자 인식 ────────────────────────────────────
// 템플릿 매칭보다 압축·스케일 변화에 강함
// 학습 데이터: 기존 솔 템플릿(7×11) + 데이터 증강(노이즈·밝기·재이진화)
// 5개 이상 숫자 자동학습 완료 시 백그라운드에서 CNN 자동 학습

const SOL_ML_KEY   = 'maple-sol-ml-v2';  // v2: 합성 데이터 사전학습
const CNN_H = 22, CNN_W = 14;   // 입력 크기 (TMPL_H×2, TMPL_W×2)

// ── 5×7 비트맵 폰트 (MapleStory 아이템 카운트 폰트 근사) ─────────────────────
// 1=픽셀 채워짐(텍스트), 0=배경
// 이 패턴으로 합성 학습 데이터 생성 → 틀린 OCR 결과로 학습하는 문제 완전 제거
const DIGIT_BM_W = 5, DIGIT_BM_H = 7;
const SOL_DIGIT_BITMAPS = {
    '0': [0,1,1,1,0, 1,0,0,0,1, 1,0,0,1,1, 1,0,1,0,1, 1,1,0,0,1, 1,0,0,0,1, 0,1,1,1,0],
    '1': [0,0,1,0,0, 0,1,1,0,0, 0,0,1,0,0, 0,0,1,0,0, 0,0,1,0,0, 0,0,1,0,0, 0,1,1,1,0],
    '2': [0,1,1,1,0, 1,0,0,0,1, 0,0,0,0,1, 0,0,0,1,0, 0,0,1,0,0, 0,1,0,0,0, 1,1,1,1,1],
    '3': [1,1,1,1,0, 0,0,0,0,1, 0,0,0,0,1, 0,1,1,1,0, 0,0,0,0,1, 0,0,0,0,1, 1,1,1,1,0],
    '4': [0,0,0,1,0, 0,0,1,1,0, 0,1,0,1,0, 1,0,0,1,0, 1,1,1,1,1, 0,0,0,1,0, 0,0,0,1,0],
    '5': [1,1,1,1,1, 1,0,0,0,0, 1,0,0,0,0, 1,1,1,1,0, 0,0,0,0,1, 0,0,0,0,1, 1,1,1,1,0],
    '6': [0,1,1,1,0, 1,0,0,0,0, 1,0,0,0,0, 1,1,1,1,0, 1,0,0,0,1, 1,0,0,0,1, 0,1,1,1,0],
    '7': [1,1,1,1,1, 0,0,0,0,1, 0,0,0,1,0, 0,0,0,1,0, 0,0,1,0,0, 0,0,1,0,0, 0,0,1,0,0],
    '8': [0,1,1,1,0, 1,0,0,0,1, 1,0,0,0,1, 0,1,1,1,0, 1,0,0,0,1, 1,0,0,0,1, 0,1,1,1,0],
    '9': [0,1,1,1,0, 1,0,0,0,1, 1,0,0,0,1, 0,1,1,1,1, 0,0,0,0,1, 0,0,0,0,1, 0,1,1,1,0],
};
let solCNN         = null;       // 학습된 모델
let solCNNReady    = false;      // 추론 가능 여부
let solCNNTraining = false;      // 학습 중 플래그

/** CNN 모델 구조 정의 */
async function buildSolCNN() {
    const model = tf.sequential();
    model.add(tf.layers.conv2d({
        inputShape: [CNN_H, CNN_W, 1], filters: 16,
        kernelSize: 3, padding: 'same', activation: 'relu',
    }));
    model.add(tf.layers.maxPooling2d({ poolSize: 2 }));
    model.add(tf.layers.conv2d({ filters: 32, kernelSize: 3, padding: 'same', activation: 'relu' }));
    model.add(tf.layers.flatten());
    model.add(tf.layers.dropout({ rate: 0.25 }));
    model.add(tf.layers.dense({ units: 64, activation: 'relu' }));
    model.add(tf.layers.dense({ units: 10, activation: 'softmax' }));
    model.compile({ optimizer: 'adam', loss: 'categoricalCrossentropy', metrics: ['accuracy'] });
    return model;
}

/** localStorage 또는 임베디드 사전학습 가중치에서 모델 로드 */
async function loadSolCNN() {
    if (typeof tf === 'undefined') return;
    // 1) localStorage (이전 인브라우저 학습 결과)
    try {
        solCNN      = await tf.loadLayersModel('localstorage://' + SOL_ML_KEY);
        solCNNReady = true;
        setStatus('🧠 솔 ML 모델 로드됨');
        return;
    } catch { /* fall through */ }
    // 2) 임베디드 사전학습 가중치 (sol-cnn-weights.js)
    if (typeof SOL_CNN_MODEL_TOPOLOGY !== 'undefined' &&
        typeof SOL_CNN_WEIGHT_SPECS   !== 'undefined' &&
        typeof SOL_CNN_WEIGHTS_B64    !== 'undefined') {
        try {
            const b64    = SOL_CNN_WEIGHTS_B64;
            const binary = atob(b64);
            const buf    = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
            solCNN      = await tf.loadLayersModel(
                tf.io.fromMemory({
                    modelTopology: SOL_CNN_MODEL_TOPOLOGY,
                    weightSpecs:   SOL_CNN_WEIGHT_SPECS,
                    weightData:    buf.buffer
                })
            );
            solCNNReady = true;
            setStatus('🧠 솔 사전학습 모델 로드됨');
            return;
        } catch (e) { console.warn('CNN embed load fail', e); }
    }
    solCNNReady = false;
}

/**
 * 템플릿 Uint8Array → CNN 입력 텐서 [CNN_H, CNN_W, 1]
 * 0=검정(텍스트) → 1.0, 1=흰색(배경) → 0.0 (CNN은 텍스트=밝음 기대)
 * 호출자가 반환된 텐서를 dispose 해야 함
 */
// ── MapleStory 실제 폰트 스프라이트 fetch ─────────────────────────────────────
const MAPLE_DIGIT_URL = 'https://maplestory.io/api/wz/img/GMS/208.2.0/UI/Basic.img/itemNo/';

/**
 * maplestory.io API에서 숫자 스프라이트 PNG fetch → Canvas 반환
 * 실패 시 null
 */
async function fetchMapleDigitSprite(digit) {
    try {
        const res = await fetch(MAPLE_DIGIT_URL + digit);
        if (!res.ok) return null;
        const blob = await res.blob();
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
                const c = document.createElement('canvas');
                c.width = img.width; c.height = img.height;
                c.getContext('2d').drawImage(img, 0, 0);
                URL.revokeObjectURL(img.src);
                resolve(c);
            };
            img.onerror = () => resolve(null);
            img.src = URL.createObjectURL(blob);
        });
    } catch { return null; }
}

/**
 * 스프라이트 Canvas → TMPL_W×TMPL_H Uint8Array
 * 알파채널 기반: 불투명 + 밝음(흰색 fill) → 텍스트(0), 나머지 → 배경(1)
 */
function spriteCanvasToTmplArr(spriteCanvas) {
    const W = spriteCanvas.width, H = spriteCanvas.height;
    const id = spriteCanvas.getContext('2d').getImageData(0, 0, W, H);
    const d  = id.data;

    const markC = document.createElement('canvas');
    markC.width = W; markC.height = H;
    const mCtx = markC.getContext('2d');
    const mId  = mCtx.createImageData(W, H);
    const md   = mId.data;

    for (let i = 0; i < d.length; i += 4) {
        const v      = Math.max(d[i], d[i+1], d[i+2]) / 255;
        const alpha  = d[i+3] / 255;
        // 불투명 AND 밝음 → 흰색 fill (숫자 픽셀)
        const isText = alpha > 0.4 && v > 0.55;
        md[i] = md[i+1] = md[i+2] = isText ? 0 : 255;
        md[i+3] = 255;
    }
    mCtx.putImageData(mId, 0, 0);

    const out = document.createElement('canvas');
    out.width = TMPL_W; out.height = TMPL_H;
    const oCtx = out.getContext('2d');
    oCtx.imageSmoothingEnabled = false;
    oCtx.drawImage(markC, 0, 0, TMPL_W, TMPL_H);

    const od  = oCtx.getImageData(0, 0, TMPL_W, TMPL_H).data;
    const arr = new Uint8Array(TMPL_W * TMPL_H);
    for (let i = 0; i < arr.length; i++) arr[i] = od[i*4] < 128 ? 0 : 1;
    return arr;
}

/**
 * 비트맵 폰트 → TMPL_W×TMPL_H Uint8Array (templateMatching 포맷과 동일)
 * 0=텍스트, 1=배경
 */
function renderDigitBitmap(digit) {
    const bm = SOL_DIGIT_BITMAPS[digit];
    if (!bm) return null;
    // 5×7 비트맵을 TMPL_W×TMPL_H 캔버스에 스케일업 (no smoothing)
    const small = document.createElement('canvas');
    small.width = DIGIT_BM_W; small.height = DIGIT_BM_H;
    const sCtx = small.getContext('2d');
    const id = sCtx.createImageData(DIGIT_BM_W, DIGIT_BM_H);
    for (let i = 0; i < bm.length; i++) {
        const v = bm[i] === 1 ? 0 : 255;  // 텍스트=검정, 배경=흰색
        id.data[i*4] = id.data[i*4+1] = id.data[i*4+2] = v;
        id.data[i*4+3] = 255;
    }
    sCtx.putImageData(id, 0, 0);

    const out = document.createElement('canvas');
    out.width = TMPL_W; out.height = TMPL_H;
    const oCtx = out.getContext('2d');
    oCtx.imageSmoothingEnabled = false;
    oCtx.drawImage(small, 0, 0, TMPL_W, TMPL_H);

    const data = oCtx.getImageData(0, 0, TMPL_W, TMPL_H).data;
    const arr = new Uint8Array(TMPL_W * TMPL_H);
    for (let i = 0; i < arr.length; i++) arr[i] = data[i*4] < 128 ? 0 : 1;
    return arr;
}

/**
 * CNN 사전학습
 * 1순위: maplestory.io API에서 실제 게임 폰트 스프라이트 fetch
 * 2순위: 하드코딩 비트맵 폰트 (API 실패 시 폴백)
 * → 두 경우 모두 대량 증강(스케일·노이즈·밝기) 적용 후 학습
 */
async function trainSolCNNFromSynthetic() {
    if (typeof tf === 'undefined' || solCNNTraining) return false;
    solCNNTraining = true;

    try {
        // ── 1단계: 스프라이트 소스 결정 ──────────────────────────────────────
        setStatus('🌐 MapleStory 폰트 스프라이트 다운로드 중... (0~9)');
        const tmplSources = {};
        let useRealFont   = false;
        let fetchedCount  = 0;

        for (let d = 0; d <= 9; d++) {
            const sprite = await fetchMapleDigitSprite(d);
            if (sprite) {
                tmplSources[String(d)] = spriteCanvasToTmplArr(sprite);
                fetchedCount++;
            }
        }

        if (fetchedCount >= 8) {
            useRealFont = true;
            setStatus(`✅ 실제 게임 폰트 ${fetchedCount}/10개 로드 완료 → CNN 학습 시작`);
        } else {
            // API 실패 → 비트맵 폴백
            for (const d of Object.keys(SOL_DIGIT_BITMAPS)) {
                if (!tmplSources[d]) tmplSources[d] = renderDigitBitmap(d);
            }
            setStatus(`⚠ API ${fetchedCount}개만 로드 — 비트맵 폰트로 보완 → CNN 학습 시작`);
        }

        // ── 2단계: 증강 + 텐서 생성 ──────────────────────────────────────────
        const AUG  = useRealFont ? 80 : 60;  // 실제 폰트면 증강 더 많이
        const allX = [], allY = [];

        for (const [digit, tmplArr] of Object.entries(tmplSources)) {
            const cls  = parseInt(digit);
            const base = tmplToTensor(tmplArr);

            for (let a = 0; a < AUG; a++) {
                const aug = tf.tidy(() => {
                    let t = base;
                    // 창 크기별 픽셀 수 차이 시뮬레이션
                    const sh = Math.round(CNN_H * (0.60 + Math.random() * 0.80));
                    const sw = Math.round(CNN_W * (0.60 + Math.random() * 0.80));
                    t = tf.image.resizeBilinear(t.expandDims(0), [sh, sw]).squeeze([0]);
                    t = tf.image.resizeBilinear(t.expandDims(0), [CNN_H, CNN_W]).squeeze([0]);
                    // H.264 압축 아티팩트 시뮬레이션
                    t = t.mul(tf.scalar(0.55 + Math.random() * 0.90)).clipByValue(0, 1);
                    t = t.add(tf.randomNormal([CNN_H, CNN_W, 1], 0, 0.15)).clipByValue(0, 1);
                    // 다양한 임계값으로 재이진화
                    t = t.greater(tf.scalar(0.18 + Math.random() * 0.50)).toFloat();
                    return t;
                });
                allX.push(aug);
                allY.push(cls);
            }
            base.dispose();
        }

        // 셔플
        for (let i = allX.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [allX[i], allX[j]] = [allX[j], allX[i]];
            [allY[i], allY[j]] = [allY[j], allY[i]];
        }

        const xs = tf.stack(allX);
        const ys = tf.oneHot(allY, 10).toFloat();
        allX.forEach(t => t.dispose());

        // ── 3단계: 학습 ───────────────────────────────────────────────────────
        const model  = await buildSolCNN();
        let finalAcc = 0;

        const EPOCHS = 120;
        await model.fit(xs, ys, {
            epochs: EPOCHS,
            batchSize: 64,
            shuffle: true,
            validationSplit: 0.1,
            callbacks: {
                onEpochEnd: async (epoch, logs) => {
                    finalAcc = logs.acc || 0;
                    if (epoch % 30 === 29)
                        setStatus(`🧠 CNN 학습 중... ${epoch+1}/${EPOCHS}  정확도 ${(finalAcc*100).toFixed(0)}%`);
                    await tf.nextFrame();
                }
            }
        });

        xs.dispose(); ys.dispose();

        await model.save('localstorage://' + SOL_ML_KEY);
        if (solCNN) solCNN.dispose();
        solCNN      = model;
        solCNNReady = true;
        const src   = useRealFont ? '실제 게임 폰트' : '비트맵 폰트';
        setStatus(`✅ 솔 CNN 완료! [${src}] 정확도 ${(finalAcc*100).toFixed(1)}% — 즉시 인식 가능`);
    } catch (e) {
        console.error('CNN 학습 실패', e);
        setStatus('❌ CNN 학습 실패: ' + e.message, 'error');
    } finally {
        solCNNTraining = false;
    }
    return true;
}

function tmplToTensor(tmplArr) {
    const float = new Float32Array(TMPL_H * TMPL_W);
    for (let i = 0; i < tmplArr.length; i++) float[i] = tmplArr[i] === 0 ? 1.0 : 0.0;
    const raw     = tf.tensor3d(float, [TMPL_H, TMPL_W, 1]);
    const resized = tf.image.resizeBilinear(raw.expandDims(0), [CNN_H, CNN_W]).squeeze([0]);
    raw.dispose();
    return resized;
}

/**
 * 솔 템플릿으로 CNN 학습 (백그라운드 비동기)
 * - 숫자당 AUG개 증강 샘플 생성 (노이즈·밝기·재이진화)
 * - 100 에폭 학습 → localStorage 저장
 */
async function trainSolCNN() {
    if (typeof tf === 'undefined' || solCNNTraining) return false;
    const digits = Object.keys(solTemplates);
    if (digits.length < 5) return false;

    solCNNTraining = true;
    setStatus(`🧠 솔 CNN 학습 시작 (${digits.length}/10개 숫자)...`);

    try {
        const AUG  = 25;
        const allX = [], allY = [];

        for (const [digit, tmplArr] of Object.entries(solTemplates)) {
            const cls  = parseInt(digit);
            const base = tmplToTensor(tmplArr);

            for (let a = 0; a < AUG; a++) {
                const aug = tf.tidy(() => {
                    let t = base;
                    t = t.add(tf.randomNormal([CNN_H, CNN_W, 1], 0, 0.10)).clipByValue(0, 1);
                    t = t.mul(tf.scalar(0.75 + Math.random() * 0.50)).clipByValue(0, 1);
                    t = t.greater(tf.scalar(0.30 + Math.random() * 0.40)).toFloat();
                    return t;
                });
                allX.push(aug);
                allY.push(cls);
            }
            base.dispose();
        }

        const xs = tf.stack(allX);
        const ys = tf.oneHot(allY, 10).toFloat();
        allX.forEach(t => t.dispose());

        const model    = await buildSolCNN();
        let  finalAcc  = 0;

        await model.fit(xs, ys, {
            epochs: 100,
            batchSize: Math.min(64, allX.length),
            shuffle: true,
            callbacks: {
                onEpochEnd: async (epoch, logs) => {
                    finalAcc = logs.acc || 0;
                    if (epoch % 25 === 24)
                        setStatus(`🧠 CNN 학습 중... ${epoch + 1}/100  정확도 ${(finalAcc * 100).toFixed(0)}%`);
                    await tf.nextFrame();  // UI 블로킹 방지
                }
            }
        });

        xs.dispose(); ys.dispose();

        await model.save('localstorage://' + SOL_ML_KEY);
        if (solCNN) solCNN.dispose();
        solCNN      = model;
        solCNNReady = true;
        setStatus(`✅ 솔 CNN 완료! 정확도 ${(finalAcc * 100).toFixed(1)}% (${digits.length}개 숫자)`);
        updateTmplDots();
    } catch (e) {
        console.error('CNN 학습 실패', e);
        setStatus('❌ CNN 학습 실패: ' + e.message, 'error');
    } finally {
        solCNNTraining = false;
    }
    return true;
}

/** CNN으로 이진 캔버스 → 솔 개수 인식 (신뢰도 75% 미만 시 null 반환) */
function recognizeSolByML(binaryCanvas) {
    if (!solCNNReady || !solCNN || typeof tf === 'undefined') return null;
    const comps = extractDigitComponents(binaryCanvas);
    if (comps.length === 0 || comps.length > 3) return null;

    let result = '';
    for (const comp of comps) {
        const norm = normalizeComp(binaryCanvas, comp);
        const { digit, conf } = tf.tidy(() => {
            const t     = tmplToTensor(norm).expandDims(0);   // [1, CNN_H, CNN_W, 1]
            const out   = solCNN.predict(t);                   // [1, 10]
            const digit = out.argMax(-1).dataSync()[0];
            const conf  = out.max().dataSync()[0];
            return { digit, conf };
        });
        if (conf < 0.75) return null;   // 신뢰도 부족 → 폴백
        result += String(digit);
    }
    const val = parseInt(result, 10);
    return isNaN(val) || val <= 0 ? null : val;
}

/**
 * 메소 정수값 → 한글 표기 문자 배열
 * 예: 1308490078 → ['1','3','억','8','4','9','만','7','8']
 */
function koreanMesoChars(value) {
    value = Math.round(Math.abs(value));
    const eok  = Math.floor(value / 1e8);
    const man  = Math.floor((value % 1e8) / 1e4);
    const ones = value % 1e4;
    const chars = [];
    if (eok  > 0) { chars.push(...String(eok).split(''));  chars.push('억'); }
    if (man  > 0) { chars.push(...String(man).split(''));  chars.push('만'); }
    if (ones > 0 || chars.length === 0) chars.push(...String(ones).split(''));
    return chars;
}

/**
 * 열(column) 기반 문자 분리
 * 연결 성분 대신 열 gap으로 경계를 찾으므로 획이 여러 덩어리인 한글도 정확히 분리
 * 1~2px 내부 gap은 무시 (같은 문자 내 획 간 틈)
 */
function segmentByColumnGaps(binaryCanvas, minSegW = 3) {
    const W = binaryCanvas.width, H = binaryCanvas.height;
    const data = binaryCanvas.getContext('2d').getImageData(0, 0, W, H).data;

    const hasDark = new Uint8Array(W);
    for (let x = 0; x < W; x++)
        for (let y = 0; y < H; y++)
            if (data[(y * W + x) * 4] < 128) { hasDark[x] = 1; break; }

    // 1~2px gap 채우기 (한 글자 내부 미세 공백)
    const filled = hasDark.slice();
    for (let x = 1; x < W - 1; x++)
        if (!filled[x] && filled[x-1] && filled[x+1]) filled[x] = 1;
    for (let x = 1; x < W - 2; x++)
        if (!filled[x] && filled[x-1] && filled[x+2]) { filled[x] = 1; filled[x+1] = 1; }

    const segs = [];
    let start = -1;
    for (let x = 0; x <= W; x++) {
        const on = x < W && filled[x];
        if (on  && start === -1) start = x;
        if (!on && start !== -1) {
            if (x - start >= minSegW) segs.push({ x1: start, x2: x - 1 });
            start = -1;
        }
    }
    return segs;
}

/**
 * 열 세그먼트를 TMPL_W × TMPL_H 이진 배열로 정규화 (메소용)
 * 세그먼트의 전체 높이를 사용 (연결 성분 bounding box 대신)
 */
function normalizeSegment(binaryCanvas, seg) {
    const W = seg.x2 - seg.x1 + 1;
    const H = binaryCanvas.height;
    const tmp = document.createElement('canvas');
    tmp.width = TMPL_W; tmp.height = TMPL_H;
    const ctx = tmp.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(binaryCanvas, seg.x1, 0, W, H, 0, 0, TMPL_W, TMPL_H);
    const id = ctx.getImageData(0, 0, TMPL_W, TMPL_H).data;
    const arr = new Uint8Array(TMPL_W * TMPL_H);
    for (let i = 0; i < arr.length; i++) arr[i] = id[i*4] < 128 ? 0 : 1;
    return arr;
}

/**
 * 템플릿 매칭으로 메소 인식
 * 숫자 0~9 + 억/만 템플릿 필요 (최소 5개 이상)
 * null 반환 시 Tesseract 폴백
 */
function recognizeMesoByTemplate(binaryCanvas) {
    const knownDigits = '0123456789'.split('').filter(d => mesoTemplates[d]).length;
    if (knownDigits < 5) return null;

    const segs = segmentByColumnGaps(binaryCanvas);
    if (segs.length === 0 || segs.length > 15) return null;

    let str = '';
    for (const seg of segs) {
        const norm = normalizeSegment(binaryCanvas, seg);
        let best = null, bestScore = 0.62;
        for (const [ch, tmpl] of Object.entries(mesoTemplates)) {
            const s = tmplSimilarity(norm, tmpl);
            if (s > bestScore) { bestScore = s; best = ch; }
        }
        if (best === null) return null;  // 미인식 문자 → Tesseract 폴백
        str += best;
    }

    return parseKoreanMeso(str);
}

/**
 * 보정값 입력 시 호출 — 열 분리 결과로 메소 문자 템플릿 학습
 * 세그먼트 수 == 기대 문자 수일 때만 학습
 */
function learnMesoTemplates(binaryCanvas, correctValue) {
    const expected = koreanMesoChars(correctValue);
    const segs     = segmentByColumnGaps(binaryCanvas);
    if (segs.length !== expected.length) return false;

    expected.forEach((ch, i) => {
        mesoTemplates[ch] = normalizeSegment(binaryCanvas, segs[i]);
    });
    saveMesoTemplates();
    updateMesoTmplDots();
    setStatus(`✅ 메소 템플릿 학습 완료 (${Object.keys(mesoTemplates).length}개 문자 저장됨)`);
    return true;
}

/**
 * 자동 자기학습 — Tesseract OCR 성공 시 새로 발견된 digit만 저장
 * 기존 템플릿은 덮어쓰지 않음 (수동 학습 우선)
 */
function autoLearnSolTemplates(binaryCanvas, correctValue) {
    const comps  = extractDigitComponents(binaryCanvas);
    const digits = String(correctValue).split('');
    if (comps.length !== digits.length) return;

    let newCount = 0;
    comps.forEach((comp, i) => {
        if (!solTemplates[digits[i]]) {
            solTemplates[digits[i]] = normalizeComp(binaryCanvas, comp);
            newCount++;
        }
    });
    if (newCount > 0) {
        saveSolTemplates();
        updateTmplDots();
        const total = Object.keys(solTemplates).length;
        setStatus(`📚 솔 자동학습: ${newCount}개 추가됨 (${total}/10)`);
        if (document.getElementById('tmpl-modal')?.style.display !== 'none') {
            renderTmplDigitGrid('sol');
        }
    }
}

function autoLearnMesoTemplates(binaryCanvas, correctValue) {
    const expected = koreanMesoChars(correctValue);
    const segs     = segmentByColumnGaps(binaryCanvas);
    if (segs.length !== expected.length) return;

    let newCount = 0;
    expected.forEach((ch, i) => {
        if (!mesoTemplates[ch]) {
            mesoTemplates[ch] = normalizeSegment(binaryCanvas, segs[i]);
            newCount++;
        }
    });
    if (newCount > 0) {
        saveMesoTemplates();
        updateMesoTmplDots();
        const total = Object.keys(mesoTemplates).length;
        setStatus(`📚 메소 자동학습: ${newCount}개 추가됨 (${total}/12)`);
        if (document.getElementById('tmpl-modal')?.style.display !== 'none') {
            renderTmplDigitGrid('meso');
        }
    }
}

/**
 * 모폴로지 열기 (Opening = erode → dilate)
 * 노이즈 픽셀 제거 + 텍스트 획 복원
 */
function morphOpen(src, size = 1) {
    return morphOp(morphOp(src, size, 'erode'), size, 'dilate');
}

/**
 * 연결 픽셀 덩어리(Connected Component) 분석으로 숫자 크기 덩어리만 남김
 * - 너무 작은 덩어리 → 노이즈 제거
 * - 너무 큰 덩어리 → 아이콘/스프라이트 제거
 * - 적당한 크기     → 숫자 획으로 보존
 *
 * 3x 업스케일 기준 숫자 획 크기: 약 40~3000 px²
 * 스프라이트 잔상: 전체 면적의 20% 이상
 */
function filterDigitComponents(binaryCanvas, minArea = 40, maxAreaFrac = 0.20) {
    const W = binaryCanvas.width, H = binaryCanvas.height;
    const ctx  = binaryCanvas.getContext('2d');
    const id   = ctx.getImageData(0, 0, W, H);
    const data = id.data;
    const maxArea = W * H * maxAreaFrac;

    // labels: 0 = 배경(흰색), -1 = 미분류 검정, >0 = 컴포넌트 ID
    const labels = new Int32Array(W * H);
    for (let i = 0; i < W * H; i++) {
        labels[i] = data[i * 4] < 128 ? -1 : 0;  // 검정=-1, 흰색=0
    }

    // BFS로 연결 덩어리 탐색
    let nextId = 1;
    const sizes = [0];  // sizes[id] = 픽셀 수

    for (let start = 0; start < W * H; start++) {
        if (labels[start] !== -1) continue;
        const id_ = nextId++;
        sizes.push(0);
        const queue = [start];
        labels[start] = id_;

        while (queue.length) {
            const cur = queue.pop();
            sizes[id_]++;
            const cx = cur % W, cy = (cur / W) | 0;
            for (let d = 0; d < 4; d++) {
                const nx = cx + (d === 0 ? -1 : d === 1 ? 1 : 0);
                const ny = cy + (d === 2 ? -1 : d === 3 ? 1 : 0);
                if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
                    const ni = ny * W + nx;
                    if (labels[ni] === -1) { labels[ni] = id_; queue.push(ni); }
                }
            }
        }
    }

    // 크기 범위 밖 덩어리 → 흰색(배경)으로 교체
    for (let i = 0; i < W * H; i++) {
        const lbl = labels[i];
        if (lbl > 0) {
            const sz = sizes[lbl];
            if (sz < minArea || sz > maxArea) {
                data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 255;
            }
        }
    }

    ctx.putImageData(id, 0, 0);
    return binaryCanvas;
}

/**
 * 자동 반전 — 이진화 후 배경이 어두운 경우(검정 픽셀 > 50%) 반전
 * Tesseract는 밝은 배경 + 어두운 텍스트를 선호
 * 게임 UI에 따라 밝은 배경/어두운 배경이 섞이므로 자동 감지 후 정규화
 */
function autoInvert(canvas) {
    const W = canvas.width, H = canvas.height;
    const ctx  = canvas.getContext('2d');
    const id   = ctx.getImageData(0, 0, W, H);
    const d    = id.data;
    let blacks = 0;
    for (let i = 0; i < d.length; i += 4) {
        if (d[i] < 128) blacks++;
    }
    // 검정 픽셀이 절반 초과 → 배경이 검정 → 반전
    if (blacks / (W * H) <= 0.5) return canvas;
    for (let i = 0; i < d.length; i += 4) {
        d[i] = d[i+1] = d[i+2] = d[i] < 128 ? 255 : 0;
    }
    ctx.putImageData(id, 0, 0);
    return canvas;
}

/**
 * 업스케일
 * binary=true  → nearest-neighbor (이진화 완료 이미지, 계단 방지)
 * binary=false → bicubic high (블러 이미지, 부드러운 보간으로 Tesseract 인식률 ↑)
 */
function upscale(canvas, scale, binary = true) {
    const up = document.createElement('canvas');
    up.width  = canvas.width  * scale;
    up.height = canvas.height * scale;
    const ctx = up.getContext('2d');
    if (binary) {
        ctx.imageSmoothingEnabled = false;
    } else {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
    }
    ctx.drawImage(canvas, 0, 0, up.width, up.height);
    return up;
}

// ── OCR 워커 초기화 ──────────────────────────────────────────────────────────
async function initWorkers() {
    setStatus('OCR 엔진 로딩 중... (최초 실행 시 잠시 걸립니다)');
    try {
        S.workerValue = await Tesseract.createWorker(['kor', 'eng'], 1, { logger: () => {} });
        await S.workerValue.setParameters({
            tessedit_pageseg_mode: '7',
        });
        S.workerReady = true;
        setStatus('OCR 준비 완료 — 화면 선택을 시작하세요');
    } catch (e) {
        setStatus('OCR 초기화 실패: ' + e.message, 'error');
    }
}

// ── 화면 캡처 ────────────────────────────────────────────────────────────────
async function startCapture() {
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                displaySurface: 'window',
                // frameRate 낮게 → 코덱이 프레임당 더 많은 비트 투자 → 텍스트 화질 ↑
                // 어차피 OCR은 1~5초 간격으로만 실행되므로 고프레임 불필요
                frameRate: { ideal: 2, max: 5 },
                width:  { ideal: 9999 },
                height: { ideal: 9999 },
            },
            audio: false,
        });
        S.stream = stream;
        S.isCapturing = true;

        // contentHint = 'detail' — 텍스트/화면 캡처임을 인코더에 알림
        // 동영상용 motion 압축 대신 디테일(텍스트 엣지) 보존 모드로 전환
        try {
            const track = stream.getVideoTracks()[0];
            if ('contentHint' in track) track.contentHint = 'detail';
        } catch {}

        D.video.srcObject = stream;
        // ImageCapture 초기화 (고화질 정지 프레임 캡처용)
        try {
            S.imageCapture = new ImageCapture(stream.getVideoTracks()[0]);
        } catch { S.imageCapture = null; }
        D.placeholder.style.display = 'none';
        stream.getVideoTracks()[0].addEventListener('ended', stopCapture);

        D.btnCapture.disabled = true;
        D.btnStop.disabled    = false;
        stepEnable(D.step2Box, true);
        D.btnSelMeso.disabled  = false;
        D.btnSelSol.disabled   = false;

        // 스트림 해상도 표시 (낮으면 OCR 품질 저하 원인 파악 가능)
        try {
            const settings = stream.getVideoTracks()[0].getSettings();
            const { width: sw, height: sh } = settings;
            const hint = sw >= 1280 ? '✅ 고화질' : sw >= 960 ? '⚠ 중화질' : '❌ 저화질';
            setStatus(`캡처 중 (${sw}×${sh} ${hint}) — 💰 메소 · 🔷 조각 위치를 지정하세요`);
        } catch {
            setStatus('화면 캡처 중 — 💰 메소 클릭 · 🔷 조각 클릭으로 위치를 지정하세요');
        }
        D.video.addEventListener('loadedmetadata', syncCanvas, { once: true });
    } catch (e) {
        if (e.name !== 'NotAllowedError') setStatus('캡처 실패: ' + e.message, 'error');
    }
}

function stopCapture() {
    if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
    S.imageCapture = null;
    D.video.srcObject = null;
    D.placeholder.style.display = '';
    S.isCapturing = false;
    S.regions     = { meso: null, sol: null };
    exitSelMode();

    D.btnCapture.disabled = false;
    D.btnStop.disabled    = true;
    D.btnSelMeso.disabled  = true;
    D.btnSelSol.disabled   = true;
    D.btnMonitor.disabled  = true;
    D.btnForce.disabled    = true;
    stepEnable(D.step2Box, false);
    stepEnable(D.step3Box, false);
    stopMonitoring();
    clearOverlay();
    setStatus('캡처 중지됨');
}

function syncCanvas() {
    const sync = () => {
        D.selCanvas.width  = D.video.clientWidth;
        D.selCanvas.height = D.video.clientHeight;
        drawRegions();
        updateBoxSizeDisplay();
        // 저장된 박스 위치가 있으면 Step2/3 자동 활성화
        updateSelStatus();
    };
    sync();
    new ResizeObserver(sync).observe(D.video);
}

// ── 박스 위치 저장/복원 (localStorage) ──────────────────────────────────────
const PRESET_KEY = 'maple-regions-v7';  // v7: 솔 80x12, 메소 104x12

function saveRegions() {
    try {
        localStorage.setItem(PRESET_KEY, JSON.stringify({
            regions: S.regions,
            boxPx:   S.boxPx,
        }));
    } catch {}
}

function loadRegions() {
    try {
        const raw = localStorage.getItem(PRESET_KEY);
        if (!raw) return;
        const { regions, boxPx } = JSON.parse(raw);
        if (regions) S.regions = regions;
        if (boxPx)   S.boxPx   = boxPx;
        S.boxPx.sol  = { w: 80,  h: 12 };  // 솔 80×12 고정
        S.boxPx.meso = { w: 104, h: 12 };  // 메소 104×12 고정
    } catch {}
}

// ── 클릭 위치 지정 ───────────────────────────────────────────────────────────

/** 현재 박스 크기 반환 (캔버스 px 절대값) */
function getBoxSize(type) {
    const p = S.boxPx[type];
    return { w: p.w, h: p.h };
}

/** 박스 크기 +/- 조절 (4px 단위)
 *  솔: 아이템 슬롯이 정사각형이므로 가로/세로 동일하게 조절
 *  메소: 가로만 주로 늘어남 (텍스트가 옆으로 길어짐)
 */
function resizeBox(type, delta) {
    return;  // 솔 24×24, 메소 104×12 고정
    // 이미 마킹된 위치가 있으면 중심 기준 박스 재생성
    const r = S.regions[type];
    if (r) {
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        S.regions[type] = { x: cx - p.w / 2, y: cy - p.h / 2, w: p.w, h: p.h };
        drawRegions();
    }
    updateBoxSizeDisplay();
    saveRegions();
}

function updateBoxSizeDisplay() {}  // 크기 고정으로 표시 불필요

function enterSelMode(type) {
    S.selMode = type;
    D.selCanvas.classList.add('selecting');
    D.btnSelMeso.classList.toggle('active', type === 'meso');
    D.btnSelSol.classList.toggle('active',  type === 'sol');
    const label = type === 'meso' ? '💰 메소 숫자' : '🔷 조각 아이템 슬롯 중앙';
    setStatus(`${label}을 클릭하세요`);
}

function exitSelMode() {
    S.selMode = null;
    D.selCanvas.classList.remove('selecting');
    D.btnSelMeso.classList.remove('active');
    D.btnSelSol.classList.remove('active');
}

function relCoords(e) {
    const r = D.selCanvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/** 좌표가 박스 내부인지 확인 → 해당 타입 반환, 없으면 null */
function hitTest(pt) {
    for (const [type, r] of Object.entries(S.regions)) {
        if (r && pt.x >= r.x && pt.x <= r.x + r.w &&
                 pt.y >= r.y && pt.y <= r.y + r.h) return type;
    }
    return null;
}

function onMouseDown(e) {
    const pt = relCoords(e);

    // ── 기존 박스 위 클릭 → 드래그 시작
    const hit = !S.selMode && hitTest(pt);
    if (hit) {
        S.dragBox    = hit;
        S.dragOffset = { dx: pt.x - S.regions[hit].x, dy: pt.y - S.regions[hit].y };
        D.selCanvas.style.cursor = 'grabbing';
        e.preventDefault();
        return;
    }

    // ── 위치 지정 모드 → 클릭 위치에 박스 생성
    if (!S.selMode) return;
    e.preventDefault();
    const { w, h } = getBoxSize(S.selMode);
    S.regions[S.selMode] = { x: pt.x - w / 2, y: pt.y - h / 2, w, h };
    S.prevMeso = null; S.prevSol = null;
    S.candidate = { meso: null, sol: null };
    S.candCount  = { meso: 0,    sol: 0 };
    exitSelMode();
    drawRegions();
    updateSelStatus();
    saveRegions();
}

function onMouseMove(e) {
    const pt = relCoords(e);

    // 드래그 중 → 박스 위치 갱신
    if (S.dragBox) {
        const r = S.regions[S.dragBox];
        S.regions[S.dragBox] = { x: pt.x - S.dragOffset.dx, y: pt.y - S.dragOffset.dy, w: r.w, h: r.h };
        drawRegions();
        return;
    }

    // 박스 위 호버 시 커서 변경
    if (!S.selMode) {
        D.selCanvas.style.cursor = hitTest(pt) ? 'move' : '';
    }
}

function onMouseUp(e) {
    if (!S.dragBox) return;
    S.dragBox    = null;
    S.dragOffset = null;
    D.selCanvas.style.cursor = '';
    S.prevMeso = null;
    S.prevSol  = null;
    S.candidate = { meso: null, sol: null };
    S.candCount  = { meso: 0,    sol: 0 };
    saveRegions();  // 드래그 이동 완료 후 저장
}

// ── 오버레이 그리기 ──────────────────────────────────────────────────────────
const COLORS = { meso: '#ffd966', sol: '#56c8f5' };

function drawRegions() {
    const ctx = D.selCanvas.getContext('2d');
    ctx.clearRect(0, 0, D.selCanvas.width, D.selCanvas.height);
    for (const [type, r] of Object.entries(S.regions)) {
        if (r) drawBox(ctx, r, COLORS[type], type === 'meso' ? '💰 메소' : '🔷 조각');
    }
}

function drawBox(ctx, r, color, label) {
    ctx.fillStyle   = color + '20';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    // 모서리 핸들
    const hs = 5;
    ctx.fillStyle = color;
    [[r.x, r.y], [r.x+r.w-hs, r.y], [r.x, r.y+r.h-hs], [r.x+r.w-hs, r.y+r.h-hs]]
        .forEach(([cx, cy]) => ctx.fillRect(cx, cy, hs, hs));

    if (label) {
        ctx.font      = 'bold 10px Segoe UI';
        ctx.fillStyle = color;
        ctx.fillText(label, r.x + 3, r.y > 14 ? r.y - 3 : r.y + r.h + 11);
    }
}

function clearOverlay() {
    D.selCanvas.getContext('2d').clearRect(0, 0, D.selCanvas.width, D.selCanvas.height);
}

// ── 영역 캡처 & 전처리 ───────────────────────────────────────────────────────

/**
 * object-fit: contain 으로 렌더링된 비디오의 실제 콘텐츠 영역 계산
 * 캡처한 창이 16:9가 아니면 검은 여백(레터박스/필러박스)이 생겨서
 * 마우스 좌표와 실제 비디오 픽셀 좌표가 어긋남.
 */
function getVideoLayout() {
    const v   = D.video;
    const eW  = v.clientWidth;
    const eH  = v.clientHeight;
    const vW  = v.videoWidth;
    const vH  = v.videoHeight;
    const scale   = Math.min(eW / vW, eH / vH);  // contain 스케일
    const rendW   = vW * scale;
    const rendH   = vH * scale;
    const offsetX = (eW - rendW) / 2;             // 필러박스 여백
    const offsetY = (eH - rendH) / 2;             // 레터박스 여백
    return { scale, offsetX, offsetY, rendW, rendH };
}

/**
 * sel: 선택 캔버스 좌표계 { x, y, w, h }
 * → 레터박스 오프셋 제거 → 비디오 픽셀 좌표로 변환 → 단일 프레임 캡처
 */
function captureRaw(sel) {
    const v = D.video;
    if (!sel || !v.videoWidth) return null;
    const { scale, offsetX, offsetY } = getVideoLayout();
    const sx = (sel.x - offsetX) / scale;
    const sy = (sel.y - offsetY) / scale;
    const sw = sel.w / scale;
    const sh = sel.h / scale;
    const cW = Math.max(1, Math.round(sw));
    const cH = Math.max(1, Math.round(sh));
    const c  = document.createElement('canvas');
    c.width  = cW; c.height = cH;
    c.getContext('2d').drawImage(v, sx, sy, sw, sh, 0, 0, cW, cH);
    return c;
}

/**
 * ImageCapture.grabFrame() — 비디오 렌더링 파이프라인을 거치지 않고
 * 네이티브 해상도 정지 프레임을 직접 캡처 → 비디오 원소 읽기보다 선명
 * 미지원 브라우저에서는 null 반환 (→ captureRaw 폴백)
 */
async function grabNativeFrame() {
    if (!S.imageCapture) return null;
    try {
        const bm = await S.imageCapture.grabFrame();
        const c  = document.createElement('canvas');
        c.width  = bm.width; c.height = bm.height;
        c.getContext('2d').drawImage(bm, 0, 0);
        bm.close();
        return c;
    } catch { return null; }
}

/**
 * sel 영역 캡처 (우선순위: grabFrame > video 읽기)
 * 정확히 박스 범위만 캡처 — 이후 cropTextColumns로 좌우 여백 자동 제거
 */
async function captureAvg(sel) {
    if (!sel || !D.video.videoWidth) return null;
    const { scale, offsetX, offsetY } = getVideoLayout();

    const sx = (sel.x - offsetX) / scale;
    const sy = (sel.y - offsetY) / scale;
    const sw = sel.w / scale;
    const sh = sel.h / scale;
    const cW = Math.max(1, Math.round(sw));
    const cH = Math.max(1, Math.round(sh));

    // ── grabFrame 시도 (고화질 정지 프레임)
    const frame = await grabNativeFrame();
    if (frame) {
        const c = document.createElement('canvas');
        c.width = cW; c.height = cH;
        c.getContext('2d').drawImage(frame, sx, sy, sw, sh, 0, 0, cW, cH);
        return c;
    }

    // ── 폴백: video 원소에서 5프레임 평균 (프레임 노이즈 감소)
    const N_FRAMES = 5;
    const bufs = [];
    for (let i = 0; i < N_FRAMES; i++) {
        const tmp = document.createElement('canvas');
        tmp.width = cW; tmp.height = cH;
        tmp.getContext('2d').drawImage(D.video, sx, sy, sw, sh, 0, 0, cW, cH);
        bufs.push(tmp.getContext('2d').getImageData(0, 0, cW, cH));
        if (i < N_FRAMES - 1) await new Promise(r => setTimeout(r, 30));
    }
    const out = document.createElement('canvas');
    out.width = cW; out.height = cH;
    const ctx = out.getContext('2d');
    const avg = ctx.createImageData(cW, cH);
    for (let i = 0; i < avg.data.length; i += 4) {
        for (let c = 0; c < 3; c++) {
            avg.data[i+c] = bufs.reduce((s, b) => s + b.data[i+c], 0) / N_FRAMES;
        }
        avg.data[i+3] = 255;
    }
    ctx.putImageData(avg, 0, 0);
    return out;
}

/**
 * 이진화 이미지에서 텍스트가 있는 수평 범위(좌~우)를 잘라냄
 * 좌우 여백(텍스트 픽셀 밀도 < threshold인 열)을 제거해 Tesseract에 깨끗한 입력 전달
 * 자릿수 변화로 박스 안에 빈 공간이 생겨도 OCR 혼란을 방지
 */
/**
 * 캔버스의 왼쪽·아래쪽 일부만 잘라냄
 * 메이플 아이템 슬롯에서 수량 숫자는 항상 왼쪽 아래 코너에 위치
 * leftFrac=0.65, bottomFrac=0.50 → 왼쪽 65%, 아래 50% 영역만 반환
 */
function cropBottomLeft(canvas, leftFrac = 0.65, bottomFrac = 0.50) {
    const W = canvas.width, H = canvas.height;
    const y  = Math.floor(H * (1 - bottomFrac));
    const cW = Math.min(W, Math.floor(W * leftFrac) + 4);  // 4px 여유 — "1" 잘림 방지
    const cH = H - y;
    if (cW <= 0 || cH <= 0) return canvas;
    const out = document.createElement('canvas');
    out.width = cW; out.height = cH;
    out.getContext('2d').drawImage(canvas, 0, y, cW, cH, 0, 0, cW, cH);
    return out;
}

/**
 * 캔버스의 아래쪽만 잘라냄 (전체 너비 유지)
 * 솔 조각: 자릿수가 늘어도 숫자는 항상 슬롯 하단에 고정
 * 전체 너비를 유지해야 2~3자리 숫자가 잘리지 않음
 */
function cropBottom(canvas, bottomFrac = 0.40) {
    const W = canvas.width, H = canvas.height;
    const y  = Math.floor(H * (1 - bottomFrac));
    const cH = H - y;
    if (cH <= 0) return canvas;
    const out = document.createElement('canvas');
    out.width = W; out.height = cH;
    out.getContext('2d').drawImage(canvas, 0, y, W, cH, 0, 0, W, cH);
    return out;
}

function cropTextColumns(binaryCanvas, threshold = 0.04) {
    const W = binaryCanvas.width, H = binaryCanvas.height;
    const data = binaryCanvas.getContext('2d').getImageData(0, 0, W, H).data;

    // 각 열의 검정(텍스트) 픽셀 밀도
    const colDensity = new Float32Array(W);
    for (let x = 0; x < W; x++) {
        let black = 0;
        for (let y = 0; y < H; y++) {
            if (data[(y * W + x) * 4] === 0) black++;
        }
        colDensity[x] = black / H;
    }

    // 텍스트가 있는 열 범위 탐색 (좌→우, 우→좌)
    let left = 0, right = W - 1;
    while (left  < W && colDensity[left]  < threshold) left++;
    while (right > 0 && colDensity[right] < threshold) right--;

    // 텍스트 없으면 원본 반환
    if (left >= right) return binaryCanvas;

    // 2px 여유 추가
    left  = Math.max(0, left  - 2);
    right = Math.min(W - 1, right + 2);
    const newW = right - left + 1;

    const out = document.createElement('canvas');
    out.width = newW; out.height = H;
    out.getContext('2d').drawImage(binaryCanvas, left, 0, newW, H, 0, 0, newW, H);
    return out;
}

/**
 * 방법 2: autoInvert 후 텍스트(검정) 픽셀 밀도가 높은 수평 띠 추출
 * autoInvert로 항상 밝은배경+어두운텍스트 정규화 → 검정=텍스트 보장
 */
function extractTextRow(binaryCanvas, targetH) {
    // autoInvert는 호출 전에 이미 적용됨

    const W = binaryCanvas.width, H = binaryCanvas.height;
    const data = binaryCanvas.getContext('2d').getImageData(0, 0, W, H).data;

    // 각 행의 검정(텍스트) 픽셀 밀도 계산
    const rowDensity = new Float32Array(H);
    for (let y = 0; y < H; y++) {
        let black = 0;
        for (let x = 0; x < W; x++) {
            if (data[(y * W + x) * 4] === 0) black++;
        }
        rowDensity[y] = black / W;
    }

    // 슬라이딩 윈도우로 텍스트 밀도 합이 최대인 행 범위 찾기
    const winH = Math.max(1, Math.round(targetH));
    let maxSum = -1, bestY = 0;
    for (let y = 0; y <= H - winH; y++) {
        let sum = 0;
        for (let r = y; r < y + winH; r++) sum += rowDensity[r];
        if (sum > maxSum) { maxSum = sum; bestY = y; }
    }

    // 텍스트 픽셀이 너무 적으면 원본 그대로 반환
    if (maxSum / winH < 0.01) return binaryCanvas;

    const out = document.createElement('canvas');
    out.width = W; out.height = winH;
    out.getContext('2d').drawImage(binaryCanvas, 0, bestY, W, winH, 0, 0, W, winH);
    return out;
}

/**
 * 캡처된 raw 이미지에 전략별 전처리 + Tesseract 적용
 * → { bestVal, bestScaled, bestText }
 */
async function runStrategies(raw, type, upscaleN = 4) {
    // 업스케일 배율에 비례해 노이즈 필터 면적 기준 조정
    // 3x 기준 60, 4x 기준 100, 5x 기준 156, 6x 기준 225
    const adaptMinArea = Math.round(100 * (upscaleN / 4) ** 2);

    const enhanced = enhanceContrast(raw);

    let strategies, stratNames;

    if (type === 'meso') {
        // 메소: HSV는 주변 금색 UI 요소에 오반응 → 적응형 먼저, HSV는 마지막 폴백
        const postBin = c => cropTextColumns(filterDigitComponents(morphOpen(autoInvert(c), 1), adaptMinArea, 0.25));
        strategies = [
            () => postBin(adaptiveThreshold(unsharpMask(bilateralFilter(raw), 0.8, 4.5), null, 8)),  // 1) 양방향필터+샤프닝+적응형
            () => postBin(adaptiveThreshold(enhanced, null, 6)),                                       // 2) 대비+적응형
            () => postBin(otsuBinarize(enhanced, false)),                                              // 3) Otsu
            () => postBin(colorFilterHSV(enhanced, type)),                                             // 4) HSV 금색 (폴백)
            () => { const c = document.createElement('canvas'); c.width = raw.width; c.height = raw.height; c.getContext('2d').drawImage(raw, 0, 0); return c; },
        ];
        stratNames = ['양방향필터+샤프닝+적응형', '대비+적응형', 'Otsu', 'HSV+열기', '원본'];
    } else {
        // 솔 조각: ① 크롭 먼저(스프라이트 대부분 제거) → ② 흰색 HSV 필터(그림자·잔존 스프라이트 제거)
        // 그림자(V<0.50) · 스프라이트(S>0.30) 모두 흰색 기준(S<0.25, V>0.60) 미충족 → 제거
        // 숫자 흰색 fill(H.264 압축 후 V≈0.65~1.0) 만 검정으로 유지
        const solMinArea = Math.round(15 * (upscaleN / 4) ** 2);
        const crop    = cropBottomLeft(raw, 0.65, 0.40);
        const cropEnh = enhanceContrast(crop);
        const post    = c => filterDigitComponents(morphOpen(c, 1), solMinArea, 0.35);
        strategies = [
            () => post(brightThreshold(crop, 228)),                                // 1) 크롭→밝기임계값
            () => post(brightThreshold(cropEnh, 210)),                             // 2) 크롭→대비→밝기임계값
            () => post(colorFilterHSV(crop, 'sol')),                               // 3) 크롭→HSV(폴백)
            () => post(autoInvert(adaptiveThreshold(cropEnh, null, 6))),           // 4) 크롭→적응형 (폴백)
            () => { const c = document.createElement('canvas'); c.width = crop.width; c.height = crop.height; c.getContext('2d').drawImage(crop, 0, 0); return c; },
        ];
        stratNames = ['크롭+밝기임계값', '크롭+대비+밝기', '크롭+흰색HSV', '크롭+적응형', '크롭원본'];
    }
    const parseFunc  = type === 'meso' ? parseKoreanMeso : parseSolCount;

    let bestVal = null, bestScaled = null, bestText = '';

    for (let si = 0; si < strategies.length; si++) {
        const proc = strategies[si]();
        const { data: { text } } = await S.workerValue.recognize(proc);
        const val = parseFunc(text);
        if (val !== null) {
            bestVal = val; bestScaled = proc;
            bestText = `[${stratNames[si]} ✓] ${text.trim()}`;
            break;
        }
        if (!bestScaled) {
            bestScaled = proc;
            bestText   = `[${stratNames[si]} ✗] ${text.trim()}`;
        }
    }
    return { bestVal, bestScaled, bestText };
}

/**
 * 솔 ROI 캔버스를 OCR 서버로 전송하여 숫자 인식
 * 성공 시 정수 반환, 실패 시 null
 */
async function ocrViaSolServer(rawSmall) {
    if (!OCR_SERVER_URL || OCR_SERVER_URL.includes('your-ocr-server')) return null;
    try {
        // canvas → JPEG blob (80% 품질로 크기 최소화)
        const blob = await new Promise(resolve =>
            rawSmall.toBlob(resolve, 'image/jpeg', 0.9)
        );
        const form = new FormData();
        form.append('file', blob, 'sol.jpg');
        form.append('client_id', 'sol');

        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 1500);  // 1.5초 타임아웃

        const res = await fetch(`${OCR_SERVER_URL}/ocr`, {
            method: 'POST',
            body: form,
            signal: ctrl.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) return null;
        const json = await res.json();

        if (json.value !== null && json.confidence >= 0.4) {
            return json.value;
        }
        return null;
    } catch {
        return null;  // 서버 다운 시 로컬 폴백으로 자동 전환
    }
}

async function ocrRegion(type) {
    const rawTarget  = type === 'meso' ? D.ocrMesoRawCanvas : D.ocrSolRawCanvas;
    const procTarget = type === 'meso' ? D.ocrMesoCanvas    : D.ocrSolCanvas;
    const parsed     = type === 'meso' ? D.parsedMeso       : D.parsedSol;
    const rawText    = type === 'meso' ? D.rawMesoText      : D.rawSolText;

    // Tesseract 파라미터 설정
    await S.workerValue.setParameters(type === 'meso'
        ? { tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789억만 ' }
        : { tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789' });

    // ── 1차 시도: 현재 박스 크기로 캡처
    let sel = S.regions[type];
    let rawSmall = await captureAvg(sel);
    if (!rawSmall) return null;

    // ── 솔: 서버 OCR 우선 시도 (EasyOCR)
    if (type === 'sol') {
        const serverVal = await ocrViaSolServer(rawSmall);
        if (serverVal !== null) {
            D.curSol.textContent = serverVal;
            if (rawTarget) { const ctx = rawTarget.getContext('2d'); rawTarget.width = rawSmall.width; rawTarget.height = rawSmall.height; ctx.drawImage(rawSmall, 0, 0); }
            if (parsed)    parsed.textContent = serverVal;
            return serverVal;
        }
        // 서버 실패 → 로컬 Tesseract 폴백
    }

    // 어댑티브 업스케일 — 창 크기(픽셀 수)에 따라 4~6배 자동 조정
    // 창이 작을수록 rawSmall 픽셀이 적으므로 더 높은 배율로 보정
    const targetH  = type === 'meso' ? 72 : 100;
    const upscaleN = Math.max(4, Math.min(6,
        Math.ceil(targetH / Math.max(rawSmall.height, 1))));
    const adaptMinArea = Math.round(100 * (upscaleN / 4) ** 2);

    // 창이 너무 작으면 경고 (메소: rawSmall.height < 8, 솔: < 14)
    const minH = type === 'meso' ? 8 : 14;
    if (rawSmall.height < minH) {
        setStatus(`⚠ 캡처 픽셀(${rawSmall.width}×${rawSmall.height})이 너무 작습니다 — 메이플 창을 더 크게 키워주세요`, 'error');
    }

    let raw = upscale(rawSmall, upscaleN, false);

    // 템플릿 매칭 먼저 시도 (Tesseract보다 빠르고 픽셀폰트에 정확)
    let tmplVal = null, tmplBin = null;
    if (type === 'sol') {
        const bin = cropTextColumns(filterDigitComponents(
            morphOpen(autoInvert(adaptiveThreshold(bilateralFilter(raw), null, 8)), 1), adaptMinArea, 0.25));
        S.lastSolBinary = bin;
        tmplBin = bin;
        tmplVal = recognizeSolByTemplate(bin);
    } else if (type === 'meso') {
        const bin = cropTextColumns(filterDigitComponents(
            morphOpen(autoInvert(adaptiveThreshold(bilateralFilter(raw), null, 8)), 1), adaptMinArea, 0.25));
        S.lastMesoBinary = bin;
        tmplBin = bin;
        tmplVal = recognizeMesoByTemplate(bin);
    }

    // ── 2순위: CNN 추론 (솔 전용 — 템플릿 매칭 실패 시)
    if (tmplVal === null && type === 'sol' && tmplBin && solCNNReady) {
        const mlVal = recognizeSolByML(tmplBin);
        if (mlVal !== null) {
            tmplVal = mlVal;
            if (!tmplBin.__mlLabel) {
                const origText = `[CNN ✓] ${mlVal} (${upscaleN}x)`;
                tmplBin.__mlLabel = origText;
            }
        }
    }

    let bestVal, bestScaled, bestText;
    if (tmplVal !== null) {
        bestVal    = tmplVal;
        bestScaled = tmplBin;
        bestText   = tmplBin?.__mlLabel ?? `[템플릿 ✓] ${tmplVal} (${upscaleN}x)`;
    } else {
        ({ bestVal, bestScaled, bestText } = await runStrategies(raw, type, upscaleN));
        // Tesseract 성공: bestScaled를 템플릿 학습용으로 갱신
        if (type === 'sol'  && bestScaled) S.lastSolBinary  = bestScaled;
        if (type === 'meso' && bestScaled) S.lastMesoBinary = bestScaled;

        // 자동 자기학습: OCR 성공 시 새 digit 자동 저장
        if (bestVal !== null) {
            if (type === 'sol'  && S.lastSolBinary)  autoLearnSolTemplates(S.lastSolBinary,  bestVal);
            if (type === 'meso' && S.lastMesoBinary) autoLearnMesoTemplates(S.lastMesoBinary, bestVal);
        }
    }

    // ── 자동 확장 재시도: 메소 전용 (솔은 80×12 고정)
    const EXPAND_PX   = 20;
    const MAX_RETRIES = 0;  // 박스 크기 고정 — 자동 확장 비활성화

    for (let retry = 1; retry <= MAX_RETRIES && bestVal === null; retry++) {
        const exp = EXPAND_PX * retry;
        const expandedSel = {
            x: sel.x - exp,
            y: sel.y,
            w: sel.w + exp * 2,
            h: sel.h,
        };

        const expSmall = await captureAvg(expandedSel);
        if (!expSmall) break;
        const expRaw = upscale(expSmall, 3, false);
        const res    = await runStrategies(expRaw, type);

        if (res.bestVal !== null) {
            bestVal    = res.bestVal;
            bestScaled = res.bestScaled;
            bestText   = `[확장+${exp}px ✓] ${res.bestText.replace(/^\[.*?\]\s*/, '')}`;

            // 성공한 크기로 박스 영구 업데이트
            S.regions[type] = expandedSel;
            S.boxPx[type]   = { w: expandedSel.w, h: expandedSel.h };
            drawRegions();
            updateBoxSizeDisplay();
            saveRegions();
            rawSmall = expSmall;  // 미리보기도 확장된 캡처로 교체
        } else if (!res.bestScaled) {
            // 이 크기도 완전 실패 — 그나마 나온 결과 보존
        } else {
            bestText = `[확장+${exp}px ✗] ${res.bestText.replace(/^\[.*?\]\s*/, '')}`;
            bestScaled = res.bestScaled;
        }
    }

    // ── 원본 미리보기
    rawTarget.width  = rawSmall.width;
    rawTarget.height = rawSmall.height;
    rawTarget.getContext('2d').drawImage(rawSmall, 0, 0);

    // ── 학습된 수정 우선 적용
    const rawOCR = bestText.replace(/^\[.*?\]\s*/, '').trim();
    S.lastRaw[type] = rawOCR;
    const learned = lookupCorrection(type, rawOCR);
    if (learned !== null) {
        bestVal  = learned;
        bestText = `[학습됨 ✓] ${rawOCR}`;
    }

    // ── 전처리 미리보기
    procTarget.width  = bestScaled.width;
    procTarget.height = bestScaled.height;
    procTarget.getContext('2d').drawImage(bestScaled, 0, 0);

    rawText.textContent = bestText.trim() || '(없음)';
    parsed.textContent  = bestVal !== null
        ? (type === 'meso' ? `✅ ${fmtMeso(bestVal)}` : `✅ ${bestVal}개`)
        : `❌ 파싱 실패`;

    return bestVal;
}

// ── 인식 사이클 ──────────────────────────────────────────────────────────────
async function runOCR(force = false) {
    if (S.ocrRunning || !S.workerReady || !S.isCapturing) return;
    if (!S.regions.meso && !S.regions.sol) return;

    S.ocrRunning = true;
    setStatus('값 인식 중...', 'processing');

    try {
        const rawMeso = S.regions.meso ? await ocrRegion('meso') : null;
        const rawSol  = S.regions.sol  ? await ocrRegion('sol')  : null;

        // 화면 표시는 raw 값으로 즉시 업데이트
        if (rawMeso !== null) D.curMeso.textContent = fmtMeso(rawMeso);
        if (rawSol  !== null) D.curSol.textContent  = rawSol;

        // 2회 연속 같은 값이어야 확정 (OCR 노이즈로 인한 가짜 delta 방지)
        const confMeso = tryConfirm('meso', rawMeso);
        const confSol  = tryConfirm('sol',  rawSol);

        const hasBaseline = S.prevMeso !== null || S.prevSol !== null;

        if (hasBaseline) {
            const gainMeso = (confMeso !== null && S.prevMeso !== null) ? confMeso - S.prevMeso : 0;
            // 메소 변화 감지 → 세션 시작 + idle 타이머 리셋 (기록은 10분마다)
            if (gainMeso > 0) {
                startSessionIfNeeded();
                resetIdleTimer();
            }
            setStatus('인식 완료', S.isMonitoring ? 'active' : '');
        } else if (confMeso !== null || confSol !== null) {
            // 첫 기준값 확정 → checkpoint 초기화
            if (S.lastRecordedMeso === null && confMeso !== null) {
                S.lastRecordedMeso = confMeso;
                S.lastRecordedSol  = confSol ?? 0;
            }
            setStatus('기준값 확정 — 변화량 추적 시작', 'active');
        } else {
            setStatus('기준값 확인 중... (안정화 대기)', S.isMonitoring ? 'active' : '');
        }

        // 확정된 값만 기준으로 저장 (raw 값 저장 시 가짜 delta 발생)
        if (confMeso !== null) S.prevMeso = confMeso;
        if (confSol  !== null) S.prevSol  = confSol;

    } finally {
        S.ocrRunning = false;
    }
}

// ── 모니터링 ─────────────────────────────────────────────────────────────────
function startMonitoring() {
    if (S.isMonitoring) return;
    S.isMonitoring = true;
    // 세션 시작은 첫 메소 변화 감지 시점으로 — addEntry() 에서 처리
    runOCR(true);
    S.monitorTimer = setInterval(() => runOCR(), parseInt(D.intervalSel.value, 10));
    D.btnMonitor.textContent = '■ 중지';
    D.btnMonitor.className   = 'btn btn-danger';
    setStatus('모니터링 중', 'active');
}

function stopMonitoring() {
    if (!S.isMonitoring) return;
    S.isMonitoring = false;
    clearInterval(S.monitorTimer);
    S.monitorTimer = null;
    D.btnMonitor.textContent = '▶ 시작';
    D.btnMonitor.className   = 'btn btn-success';
    setStatus('모니터링 중지됨');
}

function tickSession() {
    if (!S.sessionStart) return;
    const sec = Math.floor((Date.now() - S.sessionStart) / 1000);
    D.sessionTime.textContent =
        `${String(Math.floor(sec/3600)).padStart(2,'0')}:` +
        `${String(Math.floor((sec%3600)/60)).padStart(2,'0')}:` +
        `${String(sec%60).padStart(2,'0')}`;
    updateRates();
}

// ── 데이터 ──────────────────────────────────────────────────────────────────
const IDLE_TIMEOUT_MS  = 30_000;   // 30초 무변화 → 세션 종료
const RECORD_INTERVAL_MS = 10 * 60 * 1000;  // 10분마다 기록

// ── 세션 시작 (첫 메소 변화 시 호출) ─────────────────────────────────────────
function startSessionIfNeeded() {
    if (!S.sessionStart) {
        S.sessionStart = Date.now();
        S.sessionTimer = setInterval(tickSession, 1000);
    } else if (!S.sessionTimer) {
        // idle로 멈췄다가 재개
        S.sessionTimer = setInterval(tickSession, 1000);
    }
    // 10분 기록 타이머 시작 (최초 1회)
    if (!S.recordTimer) {
        S.recordTimer = setInterval(record10min, RECORD_INTERVAL_MS);
    }
}

// ── 10분 누적 기록 ────────────────────────────────────────────────────────────
function record10min() {
    if (S.prevMeso === null) return;
    const gainMeso = S.lastRecordedMeso !== null ? Math.max(0, S.prevMeso - S.lastRecordedMeso) : 0;
    const gainSol  = S.lastRecordedSol  !== null ? Math.max(0, (S.prevSol ?? 0) - S.lastRecordedSol) : 0;
    if (gainMeso > 0 || gainSol > 0) {
        addEntry(gainMeso, gainSol, S.prevMeso);
    }
    // 변화 없어도 checkpoint 갱신
    S.lastRecordedMeso = S.prevMeso;
    S.lastRecordedSol  = S.prevSol ?? 0;
}

function resetIdleTimer() {
    clearTimeout(S.idleTimer);
    S.idleTimer = setTimeout(() => {
        setStatus('⏹ 30초간 변화 없음 — 세션 종료', '');
        endSession();
    }, IDLE_TIMEOUT_MS);
}

function endSession() {
    clearInterval(S.sessionTimer);
    clearTimeout(S.idleTimer);
    S.sessionTimer = null;
    S.idleTimer    = null;
    // 세션 시작시간은 유지 (기록 보존), 타이머만 멈춤
    // 저장 버튼은 활성 상태 유지
}

function addEntry(gainMeso, gainSol, currentMeso) {
    if (gainMeso > 0) S.totalGainMeso += gainMeso;
    if (gainSol  > 0) S.totalGainSol  += gainSol;
    const e = { time: new Date(), gainMeso, gainSol, currentMeso,
                cumMeso: S.totalGainMeso, cumSol: S.totalGainSol };
    S.logs.push(e);
    D.logEmpty.style.display = 'none';
    D.btnSaveSession.disabled = false;
    const tr = document.createElement('tr');
    tr.innerHTML =
        `<td>${hms(e.time)}</td>` +
        `<td class="${clsM(gainMeso)}">${signMeso(gainMeso)}</td>` +
        `<td class="${clsS(gainSol)}">${gainSol !== 0 ? signSol(gainSol) : '-'}</td>` +
        `<td class="td-muted">${currentMeso !== null ? fmtMeso(currentMeso) : '-'}</td>` +
        `<td>${fmtMeso(S.totalGainMeso)}</td>` +
        `<td>${fmt(S.totalGainSol)}</td>`;
    D.logBody.prepend(tr);
    D.statMeso.textContent = fmtMeso(S.totalGainMeso);
    D.statSol.textContent  = fmt(S.totalGainSol);
    updateRates();
}

function updateRates() {}

function clearLog() {
    if (!confirm('기록을 초기화하시겠습니까?\n세션 시간과 기준값도 리셋됩니다.')) return;
    S.logs = []; S.totalGainMeso = 0; S.totalGainSol = 0;
    S.prevMeso = null; S.prevSol = null;
    clearInterval(S.sessionTimer);
    clearInterval(S.recordTimer);
    clearTimeout(S.idleTimer);
    S.sessionStart = null; S.sessionTimer = null;
    S.idleTimer    = null; S.recordTimer  = null;
    S.lastRecordedMeso = null; S.lastRecordedSol = null;
    D.btnSaveSession.disabled = true;
    D.sessionTime.textContent = '00:00:00';
    D.logBody.innerHTML = ''; D.logEmpty.style.display = '';
    ['curMeso','curSol','statMeso','statSol']
        .forEach(k => D[k].textContent = k.startsWith('cur') ? '-' : '0');
    stopMonitoring(); setStatus('기록 초기화 완료');
}

// ── 엑셀 가계부 스타일 내보내기 ──────────────────────────────────────────────
// ── 세션 저장 (Firestore) ─────────────────────────────────────────────────────
async function saveSession() {
    if (!S.logs.length) { alert('저장할 기록이 없습니다.'); return; }

    const now     = new Date();
    const start   = S.sessionStart ? new Date(S.sessionStart) : S.logs[0].time;
    const durationSec = Math.floor((now - start) / 1000);
    const dateStr = start.toISOString().slice(0, 10);   // "2026-04-16"

    const sessionData = {
        date:          dateStr,
        startTime:     start.toISOString(),
        endTime:       now.toISOString(),
        durationSec,
        totalGainMeso: S.totalGainMeso,
        totalGainSol:  S.totalGainSol,
        logCount:      S.logs.length,
        logs: S.logs.map(e => ({
            time:        e.time.toISOString(),
            gainMeso:    e.gainMeso,
            gainSol:     e.gainSol,
            currentMeso: e.currentMeso ?? null,
            cumMeso:     e.cumMeso,
            cumSol:      e.cumSol,
        })),
    };

    D.btnSaveSession.disabled = true;
    D.btnSaveSession.textContent = '저장 중...';
    try {
        await dbSaveSession(sessionData);
        setStatus('☁️ 저장 완료!');
        D.btnSaveSession.textContent = '✅ 저장됨';
    } catch (err) {
        alert('저장 실패: ' + err.message);
        D.btnSaveSession.disabled    = false;
        D.btnSaveSession.textContent = '💾 저장';
    }
}

// ── 기록 이력 모달 ────────────────────────────────────────────────────────────
function openHistory() {
    document.getElementById('history-modal').style.display = 'flex';
    loadHistory();
}
function closeHistory() {
    document.getElementById('history-modal').style.display = 'none';
}

async function loadHistory() {
    const content = document.getElementById('history-content');
    content.innerHTML = '<div class="history-loading">불러오는 중...</div>';
    try {
        const sessions = await dbLoadSessions();
        renderHistory(sessions, content);
    } catch (err) {
        content.innerHTML = `<div class="history-loading" style="color:var(--red)">오류: ${err.message}</div>`;
    }
}

function renderHistory(sessions, container) {
    if (!sessions.length) {
        container.innerHTML = '<div class="history-loading">저장된 기록이 없습니다</div>';
        return;
    }

    // 날짜별 그룹핑
    const byDate = {};
    sessions.forEach(s => {
        if (!byDate[s.date]) byDate[s.date] = [];
        byDate[s.date].push(s);
    });

    let html = '';
    Object.keys(byDate).sort((a, b) => b.localeCompare(a)).forEach(date => {
        const daySessions = byDate[date];
        const dayMeso = daySessions.reduce((sum, s) => sum + (s.totalGainMeso || 0), 0);
        const daySol  = daySessions.reduce((sum, s) => sum + (s.totalGainSol  || 0), 0);

        html += `
        <div class="hist-date-group">
            <div class="hist-date-header">
                <span class="hist-date">${formatDate(date)}</span>
                <span class="hist-date-sum">
                    <span class="hist-sum-meso">💰 ${fmtMeso(dayMeso)}</span>
                    <span class="hist-sum-sol">🔷 ${daySol}개</span>
                    <span class="hist-session-cnt">${daySessions.length}세션</span>
                </span>
            </div>`;

        daySessions.forEach(s => {
            const dur = fmtDuration(s.durationSec || 0);
            const start = new Date(s.startTime).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
            const end   = new Date(s.endTime  ).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
            html += `
            <div class="hist-session" data-id="${s.id}">
                <div class="hist-session-row">
                    <span class="hist-time">${start} ~ ${end}</span>
                    <span class="hist-dur">⏱ ${dur}</span>
                    <span class="hist-meso">💰 ${fmtMeso(s.totalGainMeso)}</span>
                    <span class="hist-sol">🔷 ${s.totalGainSol}개</span>
                    <span class="hist-cnt">${s.logCount}건</span>
                    <button class="hist-btn-toggle btn btn-sm" onclick="toggleSessionDetail('${s.id}')">▼</button>
                    <button class="hist-btn-del btn btn-sm btn-danger-sm" onclick="deleteSessionUI('${s.id}')">삭제</button>
                </div>
                <div class="hist-detail" id="hist-detail-${s.id}" style="display:none">
                    ${renderSessionLogs(s.logs || [])}
                </div>
            </div>`;
        });

        html += `</div>`;
    });

    container.innerHTML = html;
}

function renderSessionLogs(logs) {
    if (!logs.length) return '<div class="hist-no-log">로그 없음</div>';
    let rows = '';
    logs.forEach((e, i) => {
        const t = new Date(e.time).toLocaleTimeString('ko-KR');
        rows += `<tr>
            <td>${i + 1}</td>
            <td>${t}</td>
            <td class="td-gain-meso">${fmtMeso(e.gainMeso)}</td>
            <td class="${e.gainSol > 0 ? 'td-gain-sol' : 'td-muted'}">${e.gainSol > 0 ? '+' + e.gainSol : '-'}</td>
            <td class="td-muted">${e.currentMeso != null ? fmtMeso(e.currentMeso) : '-'}</td>
            <td>${fmtMeso(e.cumMeso)}</td>
        </tr>`;
    });
    return `<table class="log-table hist-log-table">
        <thead><tr>
            <th class="th-left">#</th><th class="th-left">시간</th>
            <th>메소 획득</th><th>조각</th><th>메소 잔액</th><th>누적 메소</th>
        </tr></thead>
        <tbody>${rows}</tbody>
    </table>`;
}

function toggleSessionDetail(id) {
    const el  = document.getElementById('hist-detail-' + id);
    const btn = el.previousElementSibling.querySelector('.hist-btn-toggle');
    const open = el.style.display === 'none';
    el.style.display = open ? 'block' : 'none';
    btn.textContent  = open ? '▲' : '▼';
}

async function deleteSessionUI(id) {
    if (!confirm('이 세션을 삭제하시겠습니까?')) return;
    try {
        await dbDeleteSession(id);
        document.querySelector(`.hist-session[data-id="${id}"]`).remove();
    } catch (err) {
        alert('삭제 실패: ' + err.message);
    }
}

function formatDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
}

function fmtDuration(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}시간 ${String(m).padStart(2,'0')}분`;
    return `${m}분 ${String(s).padStart(2,'0')}초`;
}

function exportExcel() {
    if (!S.logs.length) { alert('저장할 기록이 없습니다.'); return; }

    // ── 날짜/시간 계산 ────────────────────────────────────────────────────────
    const now     = new Date();
    const dateStr = now.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
    const sec  = S.sessionStart ? Math.floor((Date.now() - S.sessionStart) / 1000) : 0;
    const hh   = String(Math.floor(sec / 3600)).padStart(2, '0');
    const mm   = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const ss   = String(sec % 60).padStart(2, '0');
    const dur  = `${hh}:${mm}:${ss}`;
    const hrs  = sec / 3600;

    // ── 레퍼런스 스타일 팔레트 ────────────────────────────────────────────────
    // 색상: 사냥 수익 일지 레퍼런스 파일과 동일한 팔레트
    const BD  = c => ({ style: 'thin', color: { rgb: c } });
    const bG  = { top: BD('9DC08B'), bottom: BD('9DC08B'), left: BD('9DC08B'), right: BD('9DC08B') };   // green border
    const bB  = { top: BD('8FB4D4'), bottom: BD('8FB4D4'), left: BD('8FB4D4'), right: BD('8FB4D4') };   // blue border
    const bGo = { top: BD('C9A800'), bottom: BD('C9A800'), left: BD('C9A800'), right: BD('C9A800') };   // gold border
    const bPu = { top: BD('9A6BB0'), bottom: BD('9A6BB0'), left: BD('9A6BB0'), right: BD('9A6BB0') };   // purple border
    const bGr = { top: BD('C8C8C8'), bottom: BD('C8C8C8'), left: BD('C8C8C8'), right: BD('C8C8C8') };   // gray border

    const F   = (name, sz, bold, rgb) => ({ name, sz, bold: !!bold, color: { rgb: rgb || '000000' } });
    const FIL = rgb => ({ patternType: 'solid', fgColor: { rgb } });
    const AL  = (h, v) => ({ horizontal: h || 'center', vertical: v || 'center' });

    const ST = {
        // ── 타이틀: Do Hyeon 20pt, B0DB9C 초록 배경
        title:     { font: F('Do Hyeon', 20, false, '1A3A00'), fill: FIL('B0DB9C'), alignment: AL('center') },
        // ── 날짜/시간 정보 행: Noto Sans KR, C4E59F 연초록
        infoHdr:   { font: F('Noto Sans KR', 10, true,  '2C5A00'), fill: FIL('C4E59F'), alignment: AL('center'), border: bG },
        infoVal:   { font: F('Noto Sans KR', 10, false, '2C2C2C'), fill: FIL('E2EFD9'), alignment: AL('center'), border: bG },
        // ── 컬럼 헤더 (왼쪽: 연초록 / 오른쪽: 연파랑)
        hdrGreen:  { font: F('Noto Sans KR', 11, true,  '1A4000'), fill: FIL('C4E59F'), alignment: AL('center'), border: bG },
        hdrBlue:   { font: F('Noto Sans KR', 11, true,  '0D3557'), fill: FIL('BDD6EE'), alignment: AL('center'), border: bB },
        // ── 데이터 행: E2EFD9 연초록 (홀수) / FFFFFF 흰색 (짝수)
        rowOdd:    { font: F('Noto Sans KR', 10, false, '2C2C2C'), fill: FIL('E2EFD9'), alignment: AL('center'), border: bGr },
        rowEven:   { font: F('Noto Sans KR', 10, false, '2C2C2C'), fill: FIL('FFFFFF'), alignment: AL('center'), border: bGr },
        rowOddR:   { font: F('Noto Sans KR', 10, false, '2C2C2C'), fill: FIL('E2EFD9'), alignment: AL('right'),  border: bGr },
        rowEvenR:  { font: F('Noto Sans KR', 10, false, '2C2C2C'), fill: FIL('FFFFFF'), alignment: AL('right'),  border: bGr },
        // ── 메소 셀: 금색 계열 (홀수: FFFDE7 / 짝수: FEF2CB)
        mesoOdd:   { font: F('Noto Sans KR', 10, true,  '7A5000'), fill: FIL('FFFDE7'), alignment: AL('right'),  border: bGo },
        mesoEven:  { font: F('Noto Sans KR', 10, true,  '7A5000'), fill: FIL('FEF2CB'), alignment: AL('right'),  border: bGo },
        // ── 조각 셀: 파란색 계열 (홀수: DEEAF6 / 짝수: BDD6EE)
        solOdd:    { font: F('Noto Sans KR', 10, true,  '0D3557'), fill: FIL('DEEAF6'), alignment: AL('center'), border: bB },
        solEven:   { font: F('Noto Sans KR', 10, true,  '0D3557'), fill: FIL('BDD6EE'), alignment: AL('center'), border: bB },
        // ── 합계 행: FFD965 금색
        totalHdr:  { font: F('Noto Sans KR', 11, true,  '5C3D00'), fill: FIL('FFD965'), alignment: AL('center'), border: bGo },
        totalMeso: { font: F('Noto Sans KR', 11, true,  '5C3D00'), fill: FIL('FFD965'), alignment: AL('right'),  border: bGo },
        totalSol:  { font: F('Noto Sans KR', 11, true,  '0D3557'), fill: FIL('FFD965'), alignment: AL('center'), border: bGo },
        // ── 요약 시트 스타일
        sumHdr:    { font: F('Noto Sans KR', 10, true,  '2C5A00'), fill: FIL('A8D08D'), alignment: AL('center'), border: bG },
        sumVal:    { font: F('Noto Sans KR', 10, false, '2C2C2C'), fill: FIL('E2EFD9'), alignment: AL('right'),  border: bGr },
        sumUnit:   { font: F('Noto Sans KR', 10, false, '888888'), fill: FIL('E2EFD9'), alignment: AL('center'), border: bGr },
        sumGoldH:  { font: F('Noto Sans KR', 10, true,  '5C3D00'), fill: FIL('FFD965'), alignment: AL('center'), border: bGo },
        sumGoldV:  { font: F('Noto Sans KR', 10, false, '5C3D00'), fill: FIL('FEF2CB'), alignment: AL('right'),  border: bGo },
        sumGoldU:  { font: F('Noto Sans KR', 10, false, '888888'), fill: FIL('FEF2CB'), alignment: AL('center'), border: bGo },
        sumPuH:    { font: F('Noto Sans KR', 10, true,  '4A1F6A'), fill: FIL('B686DA'), alignment: AL('center'), border: bPu },
        sumPuV:    { font: F('Noto Sans KR', 10, false, '4A1F6A'), fill: FIL('E4D2F2'), alignment: AL('right'),  border: bPu },
        sumPuU:    { font: F('Noto Sans KR', 10, false, '888888'), fill: FIL('E4D2F2'), alignment: AL('center'), border: bPu },
        sumBlueH:  { font: F('Noto Sans KR', 10, true,  '0D3557'), fill: FIL('BDD6EE'), alignment: AL('center'), border: bB },
        sumBlueV:  { font: F('Noto Sans KR', 10, false, '0D3557'), fill: FIL('DEEAF6'), alignment: AL('right'),  border: bB },
        sumBlueU:  { font: F('Noto Sans KR', 10, false, '888888'), fill: FIL('DEEAF6'), alignment: AL('center'), border: bB },
    };

    // ── 셀 생성 헬퍼 ─────────────────────────────────────────────────────────
    const C = (v, s, z) => {
        const t = typeof v === 'number' ? 'n' : 's';
        const c = { v: v ?? '', t: v == null ? 's' : t, s };
        if (z) c.z = z;
        return c;
    };
    const NFMT = '#,##0';

    // ════════════════════════════════════════════════════════════════════════
    // Sheet 1: 파밍 기록
    // ════════════════════════════════════════════════════════════════════════
    const aoa1 = [];

    // 행1: 타이틀 (전체 병합)
    aoa1.push([
        C('🍁  메이플 루트 트래커  ─  파밍 가계부', ST.title),
        ...Array(6).fill(C('', ST.title)),
    ]);

    // 행2: 세션 정보
    aoa1.push([
        C('기록 날짜',    ST.infoHdr),
        C(dateStr,        ST.infoVal),
        C('',             ST.infoVal),
        C('세션 시간',    ST.infoHdr),
        C(dur,            ST.infoVal),
        C('기록 횟수',    ST.infoHdr),
        C(S.logs.length,  { ...ST.infoVal, alignment: AL('right') }, NFMT),
    ]);

    // 행3: 컬럼 헤더 (번호·시간 = 초록 / 나머지 = 파랑)
    aoa1.push([
        C('번호',     ST.hdrGreen),
        C('시간',     ST.hdrGreen),
        C('메소 획득', ST.hdrBlue),
        C('조각 획득', ST.hdrBlue),
        C('메소 잔액', ST.hdrBlue),
        C('누적 메소', ST.hdrBlue),
        C('누적 조각', ST.hdrBlue),
    ]);

    // 데이터 행
    S.logs.forEach((e, i) => {
        const odd  = i % 2 === 0;
        const base = odd ? ST.rowOdd   : ST.rowEven;
        const bR   = odd ? ST.rowOddR  : ST.rowEvenR;
        const meso = odd ? ST.mesoOdd  : ST.mesoEven;
        const sol  = odd ? ST.solOdd   : ST.solEven;
        aoa1.push([
            C(i + 1,                          base),
            C(e.time.toLocaleString('ko-KR'), base),
            C(e.gainMeso,                     meso, NFMT),
            e.gainSol > 0 ? C(e.gainSol, sol, NFMT) : C('', base),
            e.currentMeso != null ? C(e.currentMeso, bR, NFMT) : C('', base),
            C(e.cumMeso,                      bR,   NFMT),
            C(e.cumSol,                       base, NFMT),
        ]);
    });

    // 합계 행: FFD965 금색
    aoa1.push([
        C('',              ST.totalHdr),
        C('합  계',        ST.totalHdr),
        C(S.totalGainMeso, ST.totalMeso, NFMT),
        C(S.totalGainSol,  ST.totalSol,  NFMT),
        C('',              ST.totalHdr),
        C('',              ST.totalHdr),
        C('',              ST.totalHdr),
    ]);

    const ws1 = XLSX.utils.aoa_to_sheet(aoa1);
    ws1['!cols']   = [{ wch:5 }, { wch:22 }, { wch:16 }, { wch:10 }, { wch:18 }, { wch:16 }, { wch:10 }];
    ws1['!rows']   = [{ hpt:36 }, { hpt:18 }, { hpt:22 }];
    ws1['!merges'] = [
        { s:{ r:0, c:0 }, e:{ r:0, c:6 } },
        { s:{ r:1, c:1 }, e:{ r:1, c:2 } },
    ];
    ws1['!freeze'] = { xSplit: 0, ySplit: 3 };

    // ════════════════════════════════════════════════════════════════════════
    // Sheet 2: 세션 요약 (3열: 항목 / 값 / 단위)
    // ════════════════════════════════════════════════════════════════════════
    const aoa2 = [
        // 타이틀
        [C('🍁  세션 요약', ST.title), C('', ST.title), C('', ST.title)],
        // 헤더
        [C('항  목', ST.hdrGreen), C('값', ST.hdrBlue), C('단위', ST.hdrBlue)],
        // ── 초록 섹션: 시간
        [C('세션 시간',   ST.sumHdr),  C(dur,        { ...ST.sumVal, alignment: AL('center') }), C('hh:mm:ss', ST.sumUnit)],
        [C('기록 횟수',   ST.sumHdr),  C(S.logs.length, ST.sumVal, NFMT),                        C('회',       ST.sumUnit)],
        // ── 금색 섹션: 메소
        [C('총 획득 메소', ST.sumGoldH), C(S.totalGainMeso,                                           ST.sumGoldV, NFMT), C('메소',      ST.sumGoldU)],
        [C('시간당 메소',  ST.sumGoldH), C(hrs > 0 ? Math.round(S.totalGainMeso / hrs) : 0,           ST.sumGoldV, NFMT), C('메소/시간', ST.sumGoldU)],
        // ── 파랑 섹션: 조각
        [C('총 획득 조각', ST.sumBlueH), C(S.totalGainSol,                                            ST.sumBlueV, NFMT), C('개',       ST.sumBlueU)],
        [C('시간당 조각',  ST.sumBlueH), C(hrs > 0 ? Math.round(S.totalGainSol  / hrs) : 0,           ST.sumBlueV, NFMT), C('개/시간',  ST.sumBlueU)],
        // ── 보라 섹션: 효율
        [C('세션 효율',   ST.sumPuH), C(
            hrs > 0 ? `${(S.totalGainMeso / 100_000_000 / hrs).toFixed(2)} 억/시간` : '-',
            { ...ST.sumPuV, alignment: AL('center') }
        ), C('종합', ST.sumPuU)],
    ];

    const ws2 = XLSX.utils.aoa_to_sheet(aoa2);
    ws2['!cols']   = [{ wch:16 }, { wch:20 }, { wch:10 }];
    ws2['!rows']   = [{ hpt:36 }, { hpt:22 }];
    ws2['!merges'] = [{ s:{ r:0, c:0 }, e:{ r:0, c:2 } }];

    // ── 워크북 생성 & 다운로드 ────────────────────────────────────────────────
    const wb   = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, '파밍 기록');
    XLSX.utils.book_append_sheet(wb, ws2, '세션 요약');
    const name = `메이플_루트_${now.toISOString().slice(0, 10)}.xlsx`;

    const wbOut = XLSX.write(wb, { bookType: 'xlsx', type: 'array', cellStyles: true });
    const blob  = new Blob([wbOut], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url   = URL.createObjectURL(blob);
    const a     = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);

    setStatus(`엑셀 저장 완료 → ${name}`);
}

// ── 이벤트 바인딩 ────────────────────────────────────────────────────────────
// ── 수동 수정 UI ─────────────────────────────────────────────────────────────

/**
 * 수정 팝업 열기
 * parsed-meso / parsed-sol 옆 ✏️ 버튼 클릭 시 호출
 */
function openCorrection(type) {
    const wrap   = document.getElementById(`corr-wrap-${type}`);
    const input  = document.getElementById(`corr-input-${type}`);
    const parsed = type === 'meso' ? D.parsedMeso : D.parsedSol;
    // 현재 인식된 숫자만 추출해서 기본값으로
    const cur = type === 'meso' ? S.prevMeso : S.prevSol;
    input.value = cur !== null ? cur : '';
    wrap.style.display = 'flex';
    input.focus();
    input.select();
}

function closeCorrection(type) {
    document.getElementById(`corr-wrap-${type}`).style.display = 'none';
}

function applyCorrection(type) {
    const input = document.getElementById(`corr-input-${type}`);
    const raw   = input.value.replace(/[,，\s]/g, '');
    const val   = parseInt(raw, 10);
    if (isNaN(val) || val <= 0) { closeCorrection(type); return; }

    // 수정 저장 (학습)
    saveCorrection(type, S.lastRaw[type], val);

    // 픽셀 템플릿 학습 (다음부터 Tesseract 없이 인식)
    if (type === 'sol' && S.lastSolBinary) {
        const ok = learnSolTemplates(S.lastSolBinary, val);
        if (!ok) setStatus('솔 템플릿 학습 실패 — 자릿수 불일치');
    }
    if (type === 'meso' && S.lastMesoBinary) {
        const ok = learnMesoTemplates(S.lastMesoBinary, val);
        if (!ok) setStatus('메소 템플릿 학습 실패 — 문자 수 불일치');
    }

    // prevMeso/prevSol을 수정값으로 교체
    // → 다음 OCR 사이클에서 delta = 0 이 되어 획득량에 반영되지 않음
    if (type === 'meso') {
        S.prevMeso = val;
        D.curMeso.textContent    = fmtMeso(val);
        D.parsedMeso.textContent = `✅ ${fmtMeso(val)} (수정됨)`;
    } else {
        S.prevSol = val;
        D.curSol.textContent    = val;
        D.parsedSol.textContent = `✅ ${val}개 (수정됨)`;
    }

    const stats = correctionStats();
    setStatus(`수정 저장 완료 — 누적 학습: 메소 ${stats[0].count}건 · 조각 ${stats[1].count}건`);
    closeCorrection(type);
}

// ── 템플릿 설정 위자드 ────────────────────────────────────────────────────────

let tmplActiveTab = 'sol';  // 'sol' | 'meso'

const SOL_CHARS  = ['0','1','2','3','4','5','6','7','8','9'];
const MESO_CHARS = ['0','1','2','3','4','5','6','7','8','9','억','만'];

/** 솔/메소 dot 현황 갱신 */
function updateTmplDots() {
    const container = document.getElementById('tmpl-dots');
    if (!container) return;
    container.innerHTML = '';
    for (const d of SOL_CHARS) {
        const dot = document.createElement('div');
        dot.className = 'tmpl-dot ' + (solTemplates[d] ? 'tmpl-dot-learned' : 'tmpl-dot-missing');
        dot.textContent = d;
        dot.title = solTemplates[d] ? `${d}: 학습됨` : `${d}: 미학습`;
        container.appendChild(dot);
    }
}

function updateMesoTmplDots() {
    const container = document.getElementById('tmpl-meso-dots');
    if (!container) return;
    container.innerHTML = '';
    for (const ch of MESO_CHARS) {
        const dot = document.createElement('div');
        dot.className = 'tmpl-dot ' + (mesoTemplates[ch] ? 'tmpl-dot-learned' : 'tmpl-dot-missing');
        dot.textContent = ch;
        dot.title = mesoTemplates[ch] ? `${ch}: 학습됨` : `${ch}: 미학습`;
        container.appendChild(dot);
    }
}

/** 위자드 그리드 렌더링 (type: 'sol' | 'meso') */
function renderTmplDigitGrid(type = 'sol') {
    const isSol    = type === 'sol';
    const gridId   = isSol ? 'tmpl-digit-grid-sol'   : 'tmpl-digit-grid-meso';
    const fillId   = isSol ? 'tmpl-sol-progress'     : 'tmpl-meso-progress';
    const tmpls    = isSol ? solTemplates : mesoTemplates;
    const chars    = isSol ? SOL_CHARS    : MESO_CHARS;

    const grid = document.getElementById(gridId);
    if (!grid) return;
    grid.innerHTML = '';
    for (const ch of chars) {
        const learned = !!tmpls[ch];
        const div = document.createElement('div');
        div.className = 'tmpl-digit ' + (learned ? 'tmpl-digit-learned' : 'tmpl-digit-missing');
        div.textContent = ch;
        div.title = learned ? `${ch}: 학습됨` : `${ch}: 미학습`;
        grid.appendChild(div);
    }

    const learned = Object.keys(tmpls).length;
    const total   = chars.length;
    const fill    = document.getElementById(fillId);
    if (fill) fill.style.width = (learned / total * 100) + '%';

    // 메시지는 현재 활성 탭에만 표시
    if (type !== tmplActiveTab) return;
    const msg = document.getElementById('tmpl-msg');
    if (!msg) return;
    const missing = chars.filter(ch => !tmpls[ch]);
    if (learned === 0) {
        msg.textContent = '아직 학습된 문자가 없습니다.';
        msg.className = 'tmpl-msg';
    } else if (learned === total) {
        msg.textContent = `✅ 모두 학습 완료! Tesseract 없이 즉시 인식됩니다.`;
        msg.className = 'tmpl-msg tmpl-msg-ok';
    } else {
        msg.textContent = `${learned}/${total} 학습됨 — 미학습: ${missing.join(' ')}`;
        msg.className = 'tmpl-msg';
    }

    if (isSol) updateTmplDots();
    else       updateMesoTmplDots();
}

function switchTmplTab(tab) {
    tmplActiveTab = tab;
    document.querySelectorAll('.tmpl-tab').forEach(t =>
        t.classList.toggle('active', t.dataset.tab === tab));
    document.getElementById('tmpl-section-sol') .style.display = tab === 'sol'  ? '' : 'none';
    document.getElementById('tmpl-section-meso').style.display = tab === 'meso' ? '' : 'none';
    renderTmplDigitGrid(tab);
    document.getElementById('tmpl-msg').textContent = '';
}

function openTmplWizard(tab = 'sol') {
    if (!S.isCapturing) {
        alert('먼저 화면 캡처를 시작해주세요 (Step 1 → 화면 선택)');
        return;
    }
    const region = tab === 'sol' ? S.regions.sol : S.regions.meso;
    if (!region) {
        const label = tab === 'sol' ? '🔷 조각 슬롯' : '💰 메소 클릭';
        alert(`${label} 위치를 먼저 지정해주세요 (Step 2)`);
        return;
    }
    document.getElementById('tmpl-count-input').value = '';
    document.getElementById('tmpl-msg').textContent = '';
    document.getElementById('tmpl-modal').style.display = 'flex';
    switchTmplTab(tab);
    renderTmplDigitGrid('sol');
    renderTmplDigitGrid('meso');
    document.getElementById('tmpl-count-input').focus();
}

function closeTmplWizard() {
    document.getElementById('tmpl-modal').style.display = 'none';
}

async function captureAndLearnTmpl() {
    const type  = tmplActiveTab;
    const input = document.getElementById('tmpl-count-input');
    const msg   = document.getElementById('tmpl-msg');
    const rawInput = input.value.trim().replace(/[,，\s]/g, '');
    const val   = parseInt(rawInput, 10);

    if (isNaN(val) || val < 0) {
        msg.textContent = '올바른 숫자를 입력해주세요 (0 이상)';
        msg.className = 'tmpl-msg tmpl-msg-err'; return;
    }
    if (!S.isCapturing) {
        msg.textContent = '화면 캡처 중이어야 합니다';
        msg.className = 'tmpl-msg tmpl-msg-err'; return;
    }
    const region = type === 'sol' ? S.regions.sol : S.regions.meso;
    if (!region) {
        msg.textContent = '슬롯 위치가 지정되지 않았습니다';
        msg.className = 'tmpl-msg tmpl-msg-err'; return;
    }

    const btn = document.getElementById('btn-tmpl-capture');
    btn.disabled = true; btn.textContent = '캡처 중...';

    try {
        const rawSmall = await captureAvg(region);
        if (!rawSmall) throw new Error('캡처 실패');

        // 창 크기에 따른 어댑티브 업스케일 (ocrRegion과 동일 로직)
        const targetH2  = type === 'sol' ? 100 : 72;
        const upscaleN2 = Math.max(4, Math.min(6,
            Math.ceil(targetH2 / Math.max(rawSmall.height, 1))));
        const adaptMinArea2 = Math.round(100 * (upscaleN2 / 4) ** 2);
        const raw = upscale(rawSmall, upscaleN2, false);

        let bin, ok, expected, detected;
        if (type === 'sol') {
            // 크롭 먼저 → 흰색 HSV 필터
            const crop2 = cropBottom(raw, 0.42);
            const solMinArea2 = Math.round(15 * (upscaleN2 / 4) ** 2);
            bin = filterDigitComponents(morphOpen(colorFilterHSV(crop2, 'sol'), 1), solMinArea2, 0.35);
            S.lastSolBinary = bin;
            detected = extractDigitComponents(bin).length;
            expected = String(val).length;
            if (detected === 0) throw new Error('숫자 픽셀을 찾을 수 없습니다 — 조각 슬롯 위치를 확인해주세요');
            if (detected !== expected) throw new Error(`감지된 획 덩어리 ${detected}개 vs 입력 자릿수 ${expected}개`);
            ok = learnSolTemplates(bin, val);
        } else {
            bin = cropTextColumns(filterDigitComponents(
                morphOpen(autoInvert(adaptiveThreshold(bilateralFilter(raw), null, 8)), 1), adaptMinArea2, 0.25));
            S.lastMesoBinary = bin;
            const exp = koreanMesoChars(val);
            detected = segmentByColumnGaps(bin).length;
            expected = exp.length;
            if (detected === 0) throw new Error('텍스트 픽셀을 찾을 수 없습니다 — 메소 위치를 확인해주세요');
            if (detected !== expected) throw new Error(`감지된 세그먼트 ${detected}개 vs 기대 문자 수 ${expected}개 ["${exp.join('')}"]`);
            ok = learnMesoTemplates(bin, val);
        }

        if (ok) {
            input.value = '';
            renderTmplDigitGrid(type);
        } else {
            throw new Error('학습 실패 — 다시 시도해주세요');
        }
    } catch (e) {
        msg.textContent = '❌ ' + e.message;
        msg.className = 'tmpl-msg tmpl-msg-err';
    } finally {
        btn.disabled = false; btn.textContent = '📸 캡처 학습';
    }
}

function resetTmplWizard() {
    const type = tmplActiveTab;
    const name = type === 'sol' ? '솔 조각' : '메소';
    if (!confirm(`${name} 템플릿을 모두 초기화하시겠습니까?`)) return;
    if (type === 'sol')  { solTemplates  = {}; saveSolTemplates(); }
    else                 { mesoTemplates = {}; saveMesoTemplates(); }
    renderTmplDigitGrid(type);
}

// ── OCR 확대 팝업 ─────────────────────────────────────────────────────────────
function openZoomModal(srcCanvas, label) {
    const modal  = document.getElementById('ocr-zoom-modal');
    const canvas = document.getElementById('ocr-zoom-canvas');
    const lbl    = document.getElementById('ocr-zoom-label');
    lbl.textContent = label;
    canvas.width  = srcCanvas.width;
    canvas.height = srcCanvas.height;
    canvas.getContext('2d').drawImage(srcCanvas, 0, 0);
    modal.style.display = 'flex';
}

function closeZoomModal() {
    document.getElementById('ocr-zoom-modal').style.display = 'none';
}

function bindEvents() {
    D.btnCapture.addEventListener('click', startCapture);
    D.btnStop.addEventListener('click', stopCapture);

    // 영역 선택 모드 진입
    D.btnSelMeso.addEventListener('click', () => {
        if (S.selMode === 'meso') exitSelMode();
        else enterSelMode('meso');
    });
    D.btnSelSol.addEventListener('click', () => {
        if (S.selMode === 'sol') exitSelMode();
        else enterSelMode('sol');
    });

    // 캔버스 드래그 이벤트
    D.selCanvas.addEventListener('mousedown', onMouseDown);
    D.selCanvas.addEventListener('mousemove', onMouseMove);
    D.selCanvas.addEventListener('mouseup',   onMouseUp);

    D.btnMonitor.addEventListener('click', () => S.isMonitoring ? stopMonitoring() : startMonitoring());
    D.btnForce.addEventListener('click', () => runOCR(true));
    D.btnClearLog.addEventListener   ('click', clearLog);
    D.btnSaveSession.addEventListener('click', saveSession);
    D.btnHistory.addEventListener    ('click', openHistory);
    document.getElementById('btn-history-close') .addEventListener('click', closeHistory);
    document.getElementById('history-backdrop')  .addEventListener('click', closeHistory);

    // 방법 3: OCR 미리보기 클릭 → 확대 팝업
    D.ocrMesoRawCanvas.addEventListener('click', () => openZoomModal(D.ocrMesoRawCanvas, '💰 메소 — 원본'));
    D.ocrMesoCanvas.addEventListener   ('click', () => openZoomModal(D.ocrMesoCanvas,    '💰 메소 — 전처리 후'));
    D.ocrSolRawCanvas.addEventListener ('click', () => openZoomModal(D.ocrSolRawCanvas,  '🔷 조각 — 원본'));
    D.ocrSolCanvas.addEventListener    ('click', () => openZoomModal(D.ocrSolCanvas,     '🔷 조각 — 전처리 후'));

    // 팝업 닫기
    document.getElementById('ocr-zoom-backdrop').addEventListener('click', closeZoomModal);
    document.getElementById('ocr-zoom-canvas').addEventListener('click', closeZoomModal);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeZoomModal(); });

    // 수동 수정 버튼
    ['meso', 'sol'].forEach(type => {
        document.getElementById(`btn-corr-${type}`)
            .addEventListener('click', () => openCorrection(type));
        document.getElementById(`btn-corr-ok-${type}`)
            .addEventListener('click', () => applyCorrection(type));
        document.getElementById(`btn-corr-cancel-${type}`)
            .addEventListener('click', () => closeCorrection(type));
        document.getElementById(`corr-input-${type}`)
            .addEventListener('keydown', e => {
                if (e.key === 'Enter')  applyCorrection(type);
                if (e.key === 'Escape') closeCorrection(type);
            });
    });
    D.intervalSel.addEventListener('change', () => {
        if (S.isMonitoring) { stopMonitoring(); startMonitoring(); }
    });

    // 템플릿 위자드
    document.getElementById('btn-tmpl-open')     .addEventListener('click', () => openTmplWizard('sol'));
    document.getElementById('btn-tmpl-open-meso').addEventListener('click', () => openTmplWizard('meso'));
    document.getElementById('btn-tmpl-close')    .addEventListener('click', closeTmplWizard);
    document.getElementById('tmpl-backdrop')     .addEventListener('click', closeTmplWizard);
    document.getElementById('btn-tmpl-capture')  .addEventListener('click', captureAndLearnTmpl);
    document.getElementById('btn-tmpl-reset')    .addEventListener('click', resetTmplWizard);
    document.getElementById('tmpl-count-input')  .addEventListener('keydown', e => {
        if (e.key === 'Enter')  captureAndLearnTmpl();
        if (e.key === 'Escape') closeTmplWizard();
    });
    document.querySelectorAll('.tmpl-tab').forEach(tab =>
        tab.addEventListener('click', () => switchTmplTab(tab.dataset.tab)));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Auth UI
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function showAuthOverlay(show, section) {
    document.getElementById('auth-overlay').style.display = show ? 'flex' : 'none';
    if (show && section) setAuthSection(section);
}

function setAuthSection(id) {
    ['auth-login','auth-signup'].forEach(s =>
        document.getElementById(s).style.display = s === id ? '' : 'none');
}

function authErr(id, msg) {
    document.getElementById(id).textContent = msg;
}

// 로그인 버튼
document.getElementById('btn-login').addEventListener('click', async () => {
    const email = document.getElementById('login-email').value.trim();
    const pw    = document.getElementById('login-pw').value;
    authErr('login-err', '');
    try {
        await authSignIn(email, pw);
    } catch (e) {
        console.error('login error:', e);
        const msg = e.code ? authErrMsg(e.code) : (e.message || JSON.stringify(e));
        authErr('login-err', msg);
    }
});
document.getElementById('login-email').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('btn-login').click(); });
document.getElementById('login-pw').addEventListener('keydown',    e => { if (e.key === 'Enter') document.getElementById('btn-login').click(); });

// 로그인 ↔ 회원가입 전환
document.getElementById('goto-signup').addEventListener('click', () => setAuthSection('auth-signup'));
document.getElementById('goto-login') .addEventListener('click', () => setAuthSection('auth-login'));

// 회원가입 Step 1 → Step 2
document.getElementById('btn-signup-next').addEventListener('click', () => {
    const email = document.getElementById('signup-email').value.trim();
    const pw    = document.getElementById('signup-pw').value;
    authErr('signup-err', '');
    if (!email || !pw) { authErr('signup-err', '이메일과 비밀번호를 입력해주세요.'); return; }
    if (pw.length < 6)  { authErr('signup-err', '비밀번호는 6자 이상이어야 합니다.'); return; }
    document.getElementById('signup-step1').style.display = 'none';
    document.getElementById('signup-step2').style.display = '';
    document.getElementById('nick-input').focus();
});

// 닉네임 입력 후 가입 완료
document.getElementById('btn-nick-confirm').addEventListener('click', doSignUp);
document.getElementById('nick-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSignUp(); });

async function doSignUp() {
    const nickname = document.getElementById('nick-input').value.trim();
    const email    = document.getElementById('signup-email').value.trim();
    const pw       = document.getElementById('signup-pw').value;
    authErr('signup-err', '');
    if (!nickname) { authErr('signup-err', '닉네임을 입력해주세요.'); return; }
    const btn = document.getElementById('btn-nick-confirm');
    btn.disabled = true; btn.textContent = '가입 중...';
    try {
        await authSignUp(email, pw, nickname);
    } catch (e) {
        console.error('signup error:', e);
        const msg = e.code ? authErrMsg(e.code) : (e.message || JSON.stringify(e));
        authErr('signup-err', msg);
        btn.disabled = false; btn.textContent = '✅ 가입 완료';
    }
}

// 헤더 로그인/회원가입 버튼
document.getElementById('btn-header-login') .addEventListener('click', () => showAuthOverlay(true, 'auth-login'));
document.getElementById('btn-header-signup').addEventListener('click', () => showAuthOverlay(true, 'auth-signup'));

// 모달 닫기 (✕ 버튼, 배경 클릭)
document.getElementById('btn-auth-close').addEventListener('click',  () => showAuthOverlay(false));
document.getElementById('auth-backdrop').addEventListener('click',   () => showAuthOverlay(false));

// 로그아웃
document.getElementById('btn-logout').addEventListener('click', async () => {
    await authSignOut();
});

function authErrMsg(code) {
    const map = {
        'auth/email-already-in-use':   '이미 사용 중인 이메일입니다.',
        'auth/invalid-email':           '유효하지 않은 이메일 형식입니다.',
        'auth/weak-password':           '비밀번호가 너무 짧습니다. (6자 이상)',
        'auth/user-not-found':          '존재하지 않는 계정입니다.',
        'auth/wrong-password':          '비밀번호가 올바르지 않습니다.',
        'auth/invalid-credential':      '이메일 또는 비밀번호가 올바르지 않습니다.',
        'auth/too-many-requests':       '너무 많은 시도입니다. 잠시 후 다시 시도해주세요.',
    };
    return map[code] || `오류: ${code}`;
}

// ── Auth 상태 감지 → 앱 진입 or 로그인 화면 ────────────────────────────────
async function init() {
    // 저장된 박스 위치 복원 — 화면 선택 전에 미리 로드
    loadRegions();
    updateBoxSizeDisplay();
    loadSolTemplates();   // 솔 픽셀 템플릿 복원
    loadMesoTemplates();  // 메소 픽셀 템플릿 복원
    updateTmplDots();
    updateMesoTmplDots();
    loadSolCNN().then(() => {
        // CNN 없으면 합성 데이터로 사전학습 (틀린 OCR 오염 없이 항상 정확)
        if (!solCNNReady) setTimeout(() => trainSolCNNFromSynthetic(), 1500);
    });

    bindEvents();
    await initWorkers();

    authOnChange(user => {
        if (user) {
            // 로그인됨 → 모달 닫고 유저 배지 표시
            showAuthOverlay(false);
            const nick = user.displayName || user.email;
            document.getElementById('user-nick').textContent = nick;
            document.getElementById('user-badge').style.display  = 'flex';
            document.getElementById('auth-buttons').style.display = 'none';
        } else {
            // 비로그인 → 헤더 버튼 표시 (모달은 자동으로 열지 않음)
            document.getElementById('user-badge').style.display  = 'none';
            document.getElementById('auth-buttons').style.display = 'flex';
        }
    });
}

init();

