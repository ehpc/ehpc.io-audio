import { createSignal, For, Show, type Component } from "solid-js";
import type { SongMatch } from "~/api";
import { Button } from "~/components/button";

const exactPlays = new Intl.NumberFormat();
const approximatePlays = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 });

const SongResults: Component<{
  songs: SongMatch[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onClear: () => void;
}> = (props) => (
  <fieldset class="song-results">
    <legend>Song versions</legend>
    <p class="workspace-helper">Up to 3 matching versions · sorted by YouTube Music plays when available.</p>
    <For each={props.songs}>{(match, index) => {
      const [artworkFailed, setArtworkFailed] = createSignal(false);
      const seconds = match.duration_seconds === null ? null : Math.round(match.duration_seconds);
      return <div class="song-match" classList={{ "song-match-selected": props.selectedIndex === index() }}>
        <label class="song-choice">
          <input type="radio" name="song-version" checked={props.selectedIndex === index()}
            onChange={() => props.onSelect(index())}
            onKeyDown={event => {
              if (event.key === "Enter") {
                event.preventDefault();
                props.onSelect(index());
              }
            }} />
          <Show when={match.thumbnail_url && !artworkFailed()} fallback={<span class="song-artwork song-artwork-empty" aria-hidden="true" />}>
            <img class="song-artwork" src={match.thumbnail_url!} alt="" width="48" height="48"
              referrerpolicy="no-referrer" onError={() => setArtworkFailed(true)} />
          </Show>
          <span class="song-details">
            <strong>{match.title}</strong>
            <span class="song-artists">{match.artists.join(", ")}</span>
            <span class="song-metadata">
              <span>{seconds === null ? "Duration unavailable" : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}</span>
              <span>{match.play_count === null ? "Plays unavailable" :
                `${match.play_count_approximate ? `About ${approximatePlays.format(match.play_count)}` : exactPlays.format(match.play_count)} YouTube Music plays`}</span>
            </span>
          </span>
        </label>
        <a href={match.url} target="_blank" rel="noopener noreferrer" aria-label={`Verify ${match.title} on YouTube Music`}>YouTube Music</a>
      </div>;
    }}</For>
    <Button type="button" variant="ghost" class="song-clear" onClick={props.onClear}>Clear selection</Button>
  </fieldset>
);

export default SongResults;
