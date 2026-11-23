import connection from "../config/connectDB.js";

// ─── Color / Size mappings ───────────────────────────────────────────────────
const COLOR_MAP = {
    0: 'red-violet', 1: 'green', 2: 'red', 3: 'green',
    4: 'red',        5: 'green-violet', 6: 'red', 7: 'green',
    8: 'red',        9: 'green'
};
const SIZE_MAP  = { 0:'small',1:'small',2:'small',3:'small',4:'small',
                    5:'big',  6:'big',  7:'big',  8:'big',  9:'big' };

// Numbers that carry each color signal
const RED_NUMS    = [0,2,4,6,8];
const GREEN_NUMS  = [1,3,5,7,9];
const VIOLET_NUMS = [0,5];

// ─── Core prediction engine ──────────────────────────────────────────────────

function buildMarkov1(history) {
    // 1st-order Markov: P(next | last)
    const counts = {};
    for (let n = 0; n < 10; n++) counts[n] = new Float64Array(10);
    for (let i = 0; i < history.length - 1; i++) {
        counts[history[i]][history[i + 1]]++;
    }
    const prob = {};
    for (let n = 0; n < 10; n++) {
        const sum = counts[n].reduce((a, b) => a + b, 0);
        prob[n] = sum === 0
            ? new Float64Array(10).fill(0.1)
            : counts[n].map(c => (c + 0.1) / (sum + 1)); // Laplace smoothing
    }
    return prob;
}

function buildMarkov2(history) {
    // 2nd-order Markov: P(next | prev2, prev1)
    const counts = {};
    for (let a = 0; a < 10; a++)
        for (let b = 0; b < 10; b++)
            counts[`${a}-${b}`] = new Float64Array(10);

    for (let i = 0; i < history.length - 2; i++) {
        counts[`${history[i]}-${history[i+1]}`][history[i+2]]++;
    }
    const prob = {};
    for (const key of Object.keys(counts)) {
        const sum = counts[key].reduce((a, b) => a + b, 0);
        prob[key] = sum === 0
            ? new Float64Array(10).fill(0.1)
            : counts[key].map(c => (c + 0.1) / (sum + 1));
    }
    return prob;
}

function frequencyDeviation(history, window = 50) {
    // Over-due / over-represented relative to uniform (0.1 each)
    const slice = history.slice(-window);
    const freq  = new Float64Array(10);
    slice.forEach(n => freq[n]++);
    const scores = new Float64Array(10);
    for (let n = 0; n < 10; n++) {
        const expected = slice.length / 10;
        scores[n] = (expected - freq[n]) / (expected + 1); // positive = overdue
    }
    return scores;
}

function gapScore(history) {
    // Reward numbers that haven't appeared for a long time
    const lastSeen = new Int32Array(10).fill(-1);
    history.forEach((n, i) => { lastSeen[n] = i; });
    const len = history.length;
    const scores = new Float64Array(10);
    for (let n = 0; n < 10; n++) {
        scores[n] = lastSeen[n] === -1 ? 2 : (len - 1 - lastSeen[n]) / 10;
    }
    return scores;
}

function streakPattern(history) {
    // Detect repeating sub-sequences of length 2-5 and project forward
    const scores = new Float64Array(10);
    if (history.length < 10) return scores;

    for (let len = 2; len <= 5; len++) {
        const tail = history.slice(-(len - 1)).join(',');
        for (let i = 0; i <= history.length - len; i++) {
            const seg = history.slice(i, i + len - 1).join(',');
            if (seg === tail && i + len - 1 < history.length) {
                scores[history[i + len - 1]] += 1 / len;
            }
        }
    }
    return scores;
}

function hotColdBalance(history, hotW = 20, coldW = 100) {
    // Blend hot (last 20) and cold (last 100) frequencies
    const hot  = new Float64Array(10);
    const cold = new Float64Array(10);
    history.slice(-hotW).forEach(n => hot[n]++);
    history.slice(-coldW).forEach(n => cold[n]++);

    const scores = new Float64Array(10);
    for (let n = 0; n < 10; n++) {
        // Cold: overdue boost; Hot: momentum signal (inverse for mean-reversion)
        scores[n] = (cold[n] === 0 ? 1 : 0) + (hot[n] < hotW / 10 ? 0.5 : 0);
    }
    return scores;
}

function moduloPattern(history) {
    // Check whether recent results follow a modulo pattern (e.g., +2, +3 steps)
    const scores = new Float64Array(10);
    if (history.length < 6) return scores;
    const recent = history.slice(-6);
    for (let step = 1; step <= 5; step++) {
        let consistent = true;
        for (let i = 0; i < recent.length - 1; i++) {
            if ((recent[i] + step) % 10 !== recent[i + 1]) { consistent = false; break; }
        }
        if (consistent) {
            const predicted = (recent[recent.length - 1] + step) % 10;
            scores[predicted] += 2;
        }
    }
    return scores;
}

function normalize(arr) {
    const sum = arr.reduce((a, b) => a + b, 0);
    if (sum === 0) return arr.map(() => 0.1);
    return Array.from(arr).map(v => v / sum);
}

function weightedEnsemble(scores, weights) {
    const combined = new Float64Array(10);
    for (let s = 0; s < scores.length; s++) {
        for (let n = 0; n < 10; n++) {
            combined[n] += scores[s][n] * weights[s];
        }
    }
    return normalize(combined);
}

function topN(probs, n) {
    return probs
        .map((p, i) => ({ num: i, prob: p }))
        .sort((a, b) => b.prob - a.prob)
        .slice(0, n);
}

// ─── Confidence calibration ───────────────────────────────────────────────────

function colorConfidence(probs) {
    const redP    = RED_NUMS.reduce((s, n)    => s + probs[n], 0);
    const greenP  = GREEN_NUMS.reduce((s, n)  => s + probs[n], 0);
    const violetP = VIOLET_NUMS.reduce((s, n) => s + probs[n], 0);
    const total   = redP + greenP; // violet overlaps — project onto red vs green
    return {
        red:    Math.round((redP   / 1) * 100),
        green:  Math.round((greenP / 1) * 100),
        violet: Math.round((violetP) * 100),
        winner: redP >= greenP ? 'red' : 'green',
        confidence: Math.round(Math.max(redP, greenP) * 100)
    };
}

function sizeConfidence(probs) {
    const small = [0,1,2,3,4].reduce((s, n) => s + probs[n], 0);
    const big   = [5,6,7,8,9].reduce((s, n) => s + probs[n], 0);
    return {
        winner: big >= small ? 'big' : 'small',
        confidence: Math.round(Math.max(big, small) * 100)
    };
}

// ─── Main predict function ───────────────────────────────────────────────────

async function computePrediction(game, historyLimit = 200) {
    const [rows] = await connection.query(
        `SELECT amount FROM wingo WHERE status != 0 AND game = ? ORDER BY id DESC LIMIT ?`,
        [game, historyLimit]
    );
    if (rows.length < 5) {
        return { error: 'Not enough history', status: false };
    }

    // History oldest→newest
    const history = rows.map(r => Number(r.amount)).reverse();
    const last  = history[history.length - 1];
    const prev2 = history.length >= 2 ? history[history.length - 2] : last;

    // ── Signal computation ──────────────────────────────────────────────────
    const m1    = buildMarkov1(history);
    const m2    = buildMarkov2(history);
    const freqD = frequencyDeviation(history);
    const gap   = gapScore(history);
    const streak= streakPattern(history);
    const hc    = hotColdBalance(history);
    const modulo= moduloPattern(history);

    const m1Probs = Array.from(m1[last]);
    const m2Key   = `${prev2}-${last}`;
    const m2Probs = m2[m2Key]
        ? Array.from(m2[m2Key])
        : Array.from(m1[last]); // fallback

    // Normalize gap, streak, hc, modulo, freqD to [0,1] range
    const norm = arr => normalize(arr.map(v => Math.max(0, v)));

    const signals = [
        norm(m1Probs),          // Markov-1
        norm(m2Probs),          // Markov-2
        norm(Array.from(freqD)),// Frequency deviation
        norm(Array.from(gap)),  // Gap score
        norm(Array.from(streak)),// Streak pattern
        norm(Array.from(hc)),   // Hot/cold
        norm(Array.from(modulo)) // Modulo pattern
    ];

    // Dynamic weights: upweight Markov when history is rich
    const historyRatio = Math.min(history.length / historyLimit, 1);
    const weights = [
        0.30 * historyRatio + 0.15, // m1
        0.25 * historyRatio + 0.10, // m2
        0.15,                        // freqD
        0.12,                        // gap
        0.15,                        // streak
        0.08,                        // hotCold
        0.10                         // modulo
    ];
    // Renormalize weights to sum = 1
    const wSum = weights.reduce((a, b) => a + b, 0);
    const normW = weights.map(w => w / wSum);

    const finalProbs = weightedEnsemble(signals, normW);

    // ── Top picks ────────────────────────────────────────────────────────────
    const top3 = topN(finalProbs, 3);
    const top1  = top3[0];

    const colorInfo = colorConfidence(finalProbs);
    const sizeInfo  = sizeConfidence(finalProbs);

    // Individual signal breakdown for transparency
    const signalBreakdown = top3.map(({ num, prob }) => ({
        number:     num,
        color:      COLOR_MAP[num],
        size:       SIZE_MAP[num],
        probability: Math.round(prob * 100),
        m1_prob:    Math.round(m1Probs[num] * 100),
        m2_prob:    Math.round(m2Probs[num] * 100),
        gap_score:  +(gap[num]).toFixed(2),
        streak_hit: streak[num] > 0
    }));

    return {
        status: true,
        game,
        analysed_rounds: history.length,
        last_result: last,
        prediction: {
            top1: {
                number:     top1.num,
                color:      COLOR_MAP[top1.num],
                size:       SIZE_MAP[top1.num],
                confidence: Math.round(top1.prob * 100)
            },
            top3: signalBreakdown,
            color: colorInfo,
            size:  sizeInfo
        },
        signal_weights: {
            markov1:   Math.round(normW[0] * 100),
            markov2:   Math.round(normW[1] * 100),
            frequency: Math.round(normW[2] * 100),
            gap:       Math.round(normW[3] * 100),
            streak:    Math.round(normW[4] * 100),
            hotCold:   Math.round(normW[5] * 100),
            modulo:    Math.round(normW[6] * 100)
        }
    };
}

// ─── Express handler ─────────────────────────────────────────────────────────

const getPrediction = async (req, res) => {
    let { typeid } = req.body;
    if (![1, 3, 5, 10].includes(Number(typeid))) {
        return res.status(200).json({ message: 'Invalid typeid', status: false });
    }
    const gameMap = { 1: 'wingo', 3: 'wingo3', 5: 'wingo5', 10: 'wingo10' };
    const result = await computePrediction(gameMap[Number(typeid)]);
    return res.status(200).json(result);
};

const getMultiModePrediction = async (req, res) => {
    let { typeid } = req.body;
    if (![1, 3, 5, 10].includes(Number(typeid))) {
        return res.status(200).json({ message: 'Invalid typeid', status: false });
    }
    const gameMap = { 1: 'wingo', 3: 'wingo3', 5: 'wingo5', 10: 'wingo10' };
    const game = gameMap[Number(typeid)];

    // Run with 3 different window sizes and ensemble them
    const [r50, r100, r200] = await Promise.all([
        computePrediction(game, 50),
        computePrediction(game, 100),
        computePrediction(game, 200)
    ]);

    if (!r50.status) return res.status(200).json(r50);

    // Merge top1 votes with inverse-window weighting (recency matters more)
    const voteMap = new Float64Array(10);
    const results = [r50, r100, r200];
    const wts = [0.5, 0.3, 0.2];
    results.forEach((r, i) => {
        if (r.status) {
            r.prediction.top3.forEach(({ number, probability }) => {
                voteMap[number] += (probability / 100) * wts[i];
            });
        }
    });

    const normalised = normalize(voteMap);
    const top3 = topN(normalised, 3);

    // Use r100 for color/size (balanced window)
    const colorInfo = r100.prediction.color;
    const sizeInfo  = r100.prediction.size;

    return res.status(200).json({
        status: true,
        game,
        analysed_rounds: r200.analysed_rounds,
        last_result: r200.last_result,
        prediction: {
            top1: {
                number:     top3[0].num,
                color:      COLOR_MAP[top3[0].num],
                size:       SIZE_MAP[top3[0].num],
                confidence: Math.round(top3[0].prob * 100)
            },
            top3: top3.map(({ num, prob }) => ({
                number:      num,
                color:       COLOR_MAP[num],
                size:        SIZE_MAP[num],
                probability: Math.round(prob * 100)
            })),
            color: colorInfo,
            size:  sizeInfo
        },
        windows: { w50: r50.prediction.top1, w100: r100.prediction.top1, w200: r200.prediction.top1 }
    });
};

export default {
    getPrediction,
    getMultiModePrediction
};
