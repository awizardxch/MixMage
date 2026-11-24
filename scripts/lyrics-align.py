"""Find when each lyric line is sung in a song file, locally (faster-whisper, no upload).

Usage:
  .venv-whisper/Scripts/python.exe scripts/lyrics-align.py <audio> <lyrics.txt> <out.json> [model]

lyrics.txt: the lyrics, one line per sung line; [Section] headers are kept as section marks and
lines in parentheses or brackets are ignored for matching. model: tiny/base/small/medium (default
small; medium is slower and better on dense singing).

How: Whisper transcribes the singing with a time for every word. Each lyric line is then matched,
in order, to the stretch of transcribed words that best shares its words (fuzzy, so misheard
words still count), searching forward from the previous line. Lines it cannot find (score under
0.34) get a time between their neighbors and are marked guessed. Prints a table and writes JSON:
  {"words": [[t, word], ...], "lines": [{"section", "text", "start", "end", "score", "guessed"}]}
Sung music is harder than speech: check the scores, and a low run means a section was misheard.
"""
import json
import re
import sys
from difflib import SequenceMatcher

from faster_whisper import WhisperModel


def norm(s):
    s = s.lower().replace("’", "'")
    s = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", s)
    return [w for w in re.sub(r"[^a-z0-9' ]+", " ", s).split() if w]


def word_sim(a, b):
    if a == b:
        return 1.0
    return SequenceMatcher(None, a, b).ratio() if min(len(a), len(b)) > 2 else 0.0


def line_score(line_words, heard):
    # How many of the line's words have a close match in the heard window (each heard word once).
    used = set()
    total = 0.0
    for w in line_words:
        best, bj = 0.0, -1
        for j, h in enumerate(heard):
            if j in used:
                continue
            s = word_sim(w, h)
            if s > best:
                best, bj = s, j
        if best >= 0.6:
            used.add(bj)
            total += best
    return total / max(1, len(line_words))


def main():
    audio, lyrics_path, out_path = sys.argv[1:4]
    model_name = sys.argv[4] if len(sys.argv) > 4 else "small"
    lines, section = [], ""
    for raw in open(lyrics_path, encoding="utf-8").read().splitlines():
        t = raw.strip()
        if not t:
            continue
        m = re.fullmatch(r"\[([^\]]+)\]", t)
        if m:
            section = m.group(1)
            continue
        if norm(t):
            lines.append({"section": section, "text": t, "words": norm(t)})
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    prompt = " ".join(l["text"] for l in lines)[:600]
    segs, _ = model.transcribe(audio, word_timestamps=True, vad_filter=False, initial_prompt=prompt, language="en")
    words = []
    for seg in segs:
        for w in seg.words or []:
            nw = norm(w.word)
            if nw:
                words.append((w.start, w.end, nw[0]))
    heard = [w[2] for w in words]
    # Dynamic programming over the whole song: every line either takes a window of heard words
    # after the previous line's window, or is skipped (left for interpolation). The total score is
    # maximized globally, so one false match early on cannot push the rest of the song off track
    # (a greedy forward search did exactly that on repeated choruses).
    W = len(words)
    cands = []  # per line: [(score, i, j)] candidate windows worth keeping
    for line in lines:
        n = len(line["words"])
        c = []
        for i in range(W):
            for span in (n - 1, n, n + 1):
                if span < 1 or i + span > W:
                    continue
                s = line_score(line["words"], heard[i:i + span])
                if s >= 0.34:
                    c.append((s, i, i + span))
        c.sort(reverse=True)
        cands.append(c[:60])
    # best[k] = {end_index: (total, back)}; skipping a line keeps the end index.
    NEG = -1e9
    states = {0: (0.0, None)}
    history = []
    for k, line in enumerate(lines):
        nxt = {}
        for end, (tot, _) in states.items():
            if tot > nxt.get(end, (NEG,))[0]:
                nxt[end] = (tot, (end, None))
            for s, i, j in cands[k]:
                if i >= end and tot + s > nxt.get(j, (NEG,))[0]:
                    nxt[j] = (tot + s, (end, (s, i, j)))
        # Keep the strongest states only, so this stays fast.
        states = dict(sorted(nxt.items(), key=lambda kv: -kv[1][0])[:400])
        history.append(states)
    end = max(states, key=lambda e: states[e][0])
    for k in range(len(lines) - 1, -1, -1):
        prev_end, pick = history[k][end][1]
        line = lines[k]
        if pick:
            s, i, j = pick
            line["score"] = round(s, 2)
            line["start"], line["end"], line["guessed"] = words[i][0], words[j - 1][1], False
        else:
            line["score"] = 0.0
            line["start"] = line["end"] = None
            line["guessed"] = True
        end = prev_end
    # Fill unmatched lines between their neighbors.
    known = [k for k, l in enumerate(lines) if l["start"] is not None]
    for k, l in enumerate(lines):
        if l["start"] is not None:
            continue
        prev = max([j for j in known if j < k], default=None)
        nxt = min([j for j in known if j > k], default=None)
        a = lines[prev]["end"] if prev is not None else 0.0
        b = lines[nxt]["start"] if nxt is not None else (words[-1][1] if words else a + 4)
        lo = prev if prev is not None else -1
        hi = nxt if nxt is not None else len(lines)
        f = (k - lo) / (hi - lo)
        l["start"] = l["end"] = round(a + (b - a) * f, 2)
    for l in lines:
        l.pop("words", None)
        l["start"], l["end"] = round(l["start"], 2), round(l["end"], 2)
        flag = "guess" if l["guessed"] else f"{l['score']:.2f}"
        print(f"{l['start']:7.2f} {flag:>6}  [{l['section']}] {l['text']}")
    json.dump({"words": [[round(w[0], 2), w[2]] for w in words], "lines": lines}, open(out_path, "w"), indent=1)
    print(f"wrote {out_path}: {len(lines)} lines, {sum(not l['guessed'] for l in lines)} found, {len(words)} words heard")


if __name__ == "__main__":
    main()
