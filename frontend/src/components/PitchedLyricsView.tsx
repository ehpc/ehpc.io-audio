import { createMemo, createSignal, For, type Component } from "solid-js";
import type { JobDTO } from "~/api";
import { pitchedLyricsDownloadUrl } from "~/api";
import { displayOutputLabel } from "~/lib/expectedStems";

const PitchedLyricsView: Component<{ job: JobDTO }> = (props) => {
  const [label, setLabel] = createSignal(props.job.pitched_lyrics?.[0]?.label ?? "");
  const track = createMemo(() => props.job.pitched_lyrics?.find(item => item.label === label()) ?? props.job.pitched_lyrics?.[0]);
  const textRuns = createMemo(() => {
    const selected = track();
    if (!selected) return [];
    const wide = new Set(selected.wide_characters);
    const runs: { text: string; wide: boolean }[] = [];
    let plain = "";
    for (const char of selected.text) {
      if (wide.has(char)) {
        if (plain) runs.push({ text: plain, wide: false });
        plain = "";
        runs.push({ text: char, wide: true });
      } else {
        plain += char;
      }
    }
    if (plain) runs.push({ text: plain, wide: false });
    return runs;
  });
  return (
    <section class="pitched-lyrics-view" aria-label="Lyrics with pitches">
      <h3 class="text-base font-semibold">Lyrics with pitches</h3>
      <div class="pitch-controls">
        <label>Vocal stem
          <select aria-label="Pitched lyrics vocal stem" value={track()?.label} onChange={event => setLabel(event.currentTarget.value)}>
            <For each={props.job.pitched_lyrics}>{item => <option value={item.label}>{displayOutputLabel(item.label, props.job.options)}</option>}</For>
          </select>
        </label>
        <a href={pitchedLyricsDownloadUrl(props.job.id, track()?.label ?? "")} download=""
          class="text-sm font-medium text-primary hover:underline">Download lyrics with pitches TXT</a>
        <a href={pitchedLyricsDownloadUrl(props.job.id, track()?.label ?? "", "odt")} download=""
          class="text-sm font-medium text-primary hover:underline">Download lyrics with pitches ODT</a>
      </div>
      <p class="text-sm text-muted-foreground">Output clock · pitch {props.job.options.pitch_semitones >= 0 ? "+" : ""}{props.job.options.pitch_semitones} semitones · tempo {props.job.options.tempo_percent}%. Source detections projected, not re-measured.</p>
      <p class="text-sm text-muted-foreground">Notes above whole words; multiple notes stay together over one word. Long lines continue as aligned pairs. Scroll horizontally on small screens. ODT keeps each pair together on the page, ready to import into Google Docs. ? means unknown, not a rest. Detected melody estimates may be wrong.</p>
      <pre class="pitched-lyrics-text" tabIndex={0} role="region" aria-label="Aligned pitch and lyric text">
        <For each={textRuns()}>{run => run.wide
          ? <span style={{ display: "inline-block", width: "2ch" }}>{run.text}</span>
          : run.text}</For>
      </pre>
    </section>
  );
};

export default PitchedLyricsView;
