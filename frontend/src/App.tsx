import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, type Component } from "solid-js";
import * as Dialog from "@kobalte/core/dialog";
import type { JobDTO, LibrarySort, SongDetail, SongSummary } from "./api";
import { getCurrentSong, getJob, getSong, listSongs, recordSongOpen, retryJob, subscribeToJob } from "./api";
import SubmitForm from "./components/SubmitForm";
import QueueStatus from "./components/QueueStatus";
import JobStatusDock from "./components/JobStatusDock";
import ResultsView, { type HistoryScrollRequest } from "./components/ResultsView";
import HistoryView from "./components/HistoryView";
import { useAuth } from "./AuthProvider";
import ProfileView from "./ProfileView";
import AdminView from "./AdminView";
import { Button } from "~/components/button";
import { pauseOtherMedia } from "~/lib/mediaSession";
import OutputsNavigation, { type OutputTarget } from "./components/OutputsNavigation";

const App: Component = () => {
  const [job, setJob] = createSignal<JobDTO | null>(null);
  const [trackedJob, setTrackedJob] = createSignal<JobDTO | null>(null);
  const [selectedId, setSelectedId] = createSignal<number | null>(null);
  const [detail, setDetail] = createSignal<SongDetail | null>(null);
  const [augmentation, setAugmentation] = createSignal<SongSummary | null>(null);
  const augmentationTarget = () => {
    const target = augmentation();
    return target && detail()?.summary.id === target.id ? detail()!.summary : target;
  };
  const [submissionNotice, setSubmissionNotice] = createSignal("");
  const [history, setHistory] = createSignal<SongSummary[]>([]);
  const [historyScrollRequest, setHistoryScrollRequest] = createSignal<HistoryScrollRequest | null>(null);
  const [resultsRefreshToken, setResultsRefreshToken] = createSignal(0);
  const [librarySort, setLibrarySort] = createSignal<LibrarySort>("usage");
  const [selectedJobRefreshError, setSelectedJobRefreshError] = createSignal<string | null>(null);
  const [retryingId, setRetryingId] = createSignal<number | null>(null);
  const [retryError, setRetryError] = createSignal<{ jobId: number; message: string } | null>(null);
  const auth = useAuth();
  const [tab, setTab] = createSignal<"workspace" | "profile" | "admin">("workspace");
  const [accountError, setAccountError] = createSignal("");
  const [mobileLibrary, setMobileLibrary] = createSignal(false);
  const [libraryOpen, setLibraryOpen] = createSignal(false);
  const [modalOpen, setModalOpen] = createSignal(false);
  const subscriptions = new Map<number, () => void>();
  const workSnapshots = new Map<number, JobDTO>();
  const workOwners = new Map<number, number>();
  const workRefreshVersions = new Map<number, number>();
  let trackedSongId: number | null = null;
  let selectedWorkId: number | null = null;
  const deletedSongIds = new Set<number>();
  const acknowledgedCounts = new Map<number, number>();
  let selectionGeneration = 0;
  let selectedRevision = 0;
  let historyRevision = 0;
  let sourceTarget: HTMLDivElement | undefined;
  let historyScrollToken = 0;
  let progressTarget: HTMLDivElement | undefined;
  let libraryTrigger: HTMLButtonElement | undefined;
  let selectedFromLibrary = false;
  let viewingFromLibrary = false;
  const orderedHistory = createMemo(() => [...history()].sort((a, b) =>
    (librarySort() === "usage" ? b.open_count - a.open_count : 0) ||
    b.created_at - a.created_at || b.id - a.id));

  onMount(() => {
    const query = window.matchMedia?.("(max-width: 1000px)");
    if (!query) return;
    const update = () => { setMobileLibrary(query.matches); if (!query.matches) setLibraryOpen(false); };
    update();
    query.addEventListener("change", update);
    onCleanup(() => query.removeEventListener("change", update));
  });
  onMount(() => {
    const update = () => setModalOpen(Boolean(document.fullscreenElement || document.querySelector('[role="dialog"][aria-modal="true"]')));
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("fullscreenchange", update);
    update();
    onCleanup(() => { observer.disconnect(); document.removeEventListener("fullscreenchange", update); });
  });

  onMount(() => {
    // Only announced starts may be preempted: a newer play() can precede its queued event.
    const playing = new Set<HTMLAudioElement>();
    const pauseOtherAudio = (event: Event) => {
      const current = event.target;
      if (!(current instanceof HTMLAudioElement) || current.paused) return;
      for (const audio of playing) if (audio.paused) playing.delete(audio);
      pauseOtherMedia(current, playing);
      playing.add(current);
    };
    const forgetPausedAudio = (event: Event) => {
      const current = event.target;
      if (current instanceof HTMLAudioElement && current.paused) playing.delete(current);
    };
    document.addEventListener("play", pauseOtherAudio, true);
    document.addEventListener("pause", forgetPausedAudio, true);
    onCleanup(() => {
      document.removeEventListener("play", pauseOtherAudio, true);
      document.removeEventListener("pause", forgetPausedAudio, true);
      playing.clear();
    });
  });

  const refreshHistory = async () => {
    const revision = ++historyRevision;
    const selected = selectedId();
    const selection = selectionGeneration;
    try {
      const songs = await listSongs(librarySort());
      if (revision !== historyRevision) return;
      setHistory(songs.filter(song => !deletedSongIds.has(song.id)).map(song => ({
        ...song, open_count: Math.max(song.open_count, acknowledgedCounts.get(song.id) ?? 0),
      })));
      if (selected !== null && selection === selectionGeneration && selectedId() === selected &&
        detail()?.summary.id === selected && !songs.some(song => song.id === selected)) {
        void refreshSelectedSong(selected);
      }
    } catch { /* Keep the last successful library listing. */ }
  };
  const adoptSong = (oldId: number, canonicalId: number) => {
    if (oldId === canonicalId) return;
    for (const [workId, owner] of workOwners) if (owner === oldId) workOwners.set(workId, canonicalId);
    if (trackedSongId === oldId) trackedSongId = canonicalId;
    if (selectedId() === oldId) {
      setSelectedId(canonicalId);
      setAugmentation(target => target?.id === oldId ? { ...target, id: canonicalId } : target);
      void refreshSelectedSong(canonicalId);
    }
    void refreshHistory();
  };

  const refreshSelectedSong = async (id: number, scrollToken?: number, refreshWork = false) => {
    const revision = ++selectedRevision;
    try {
      const next = await getSong(id);
      if (revision !== selectedRevision || selectedId() !== id || deletedSongIds.has(id)) return;
      selectedWorkId = next.summary.latest_work_id;
      for (const workId of next.summary.active_work_ids) watchWork(workId, id);
      setDetail(next);
      setSelectedJobRefreshError(null);
      if (refreshWork || job()?.id !== next.summary.latest_work_id) {
        const workId = next.summary.latest_work_id;
        const selection = selectionGeneration;
        const previousSnapshot = workSnapshots.get(workId);
        const workVersion = (workRefreshVersions.get(workId) ?? 0) + 1;
        workRefreshVersions.set(workId, workVersion);
        void getJob(workId).then(work => {
          if (selection !== selectionGeneration || selectedId() !== id || detail()?.summary.latest_work_id !== workId || workRefreshVersions.get(workId) !== workVersion) return;
          const currentSnapshot = workSnapshots.get(workId);
          const latest = currentSnapshot !== previousSnapshot ? currentSnapshot! : work;
          workSnapshots.set(workId, latest);
          if (latest.song_id != null && latest.song_id !== id) adoptSong(id, latest.song_id);
          setJob(latest);
          if (trackedJob()?.id === workId) setTrackedJob(latest);
        }).catch(() => {});
      }
      if (scrollToken !== undefined) setHistoryScrollRequest({ jobId: id, token: scrollToken });
      return next;
    } catch (error) {
      if (revision !== selectedRevision || selectedId() !== id) return;
      const workId = job()?.id ?? selectedWorkId;
      if (workId !== null) {
        try {
          const latest = await getJob(workId);
          if (revision !== selectedRevision || selectedId() !== id) return;
          if (latest.song_id != null && latest.song_id !== id) { adoptSong(id, latest.song_id); return; }
        } catch { /* Preserve the original refresh error. */ }
      }
      setSelectedJobRefreshError(`Could not refresh this song. ${error instanceof Error ? error.message : ""}`);
    }
  };

  const watchWork = (workId: number, songId: number) => {
    workOwners.set(workId, songId);
    if (subscriptions.has(workId)) return;
    let valid = true;
    let version = 0;
    const apply = (next: JobDTO) => {
      const owner = workOwners.get(workId) ?? songId;
      if (!valid || next.id !== workId || deletedSongIds.has(owner)) return;
      if (next.song_id != null && next.song_id !== owner) adoptSong(owner, next.song_id);
      const canonicalId = workOwners.get(workId) ?? owner;
      version++;
      workSnapshots.set(workId, next);
      if (selectedId() === canonicalId && job()?.id === workId) setJob(next);
      if (trackedJob()?.id === workId) setTrackedJob(next);
      if (next.status === "done" || next.status === "failed") {
        subscriptions.delete(workId);
        valid = false;
        void refreshHistory();
        if (selectedId() === canonicalId) void refreshSelectedSong(canonicalId);
      }
    };
    const close = subscribeToJob(workId, apply, async () => {
      const previous = version;
      try {
        const snapshot = await getJob(workId);
        if (version === previous) apply(snapshot);
      } catch { /* Retain the last known state. */ }
    });
    subscriptions.set(workId, () => { valid = false; close(); });
  };
  let initialLibrarySort = true;
  createEffect(() => {
    librarySort();
    if (initialLibrarySort) { initialLibrarySort = false; return; }
    void refreshHistory();
  });
  onCleanup(() => {
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
  });

  onMount(() => {
    const root = document.documentElement;
    const action = document.querySelector<HTMLElement>(".workspace-action");
    const updateAction = () => {
      const rect = action?.getBoundingClientRect();
      const sticky = action && rect && getComputedStyle(action).position === "sticky" &&
        rect.bottom >= innerHeight - 1 && rect.top < innerHeight && rect.bottom <= innerHeight + 1;
      root.style.setProperty("--job-action-height", sticky ? `${rect.height}px` : "0px");
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateAction);
    if (action) observer?.observe(action);
    window.addEventListener("scroll", updateAction, { passive: true });
    window.addEventListener("resize", updateAction);
    let focusFrame = 0;
    const updateAfterFocus = () => {
      cancelAnimationFrame(focusFrame);
      focusFrame = requestAnimationFrame(updateAction);
    };
    document.addEventListener("focusin", updateAfterFocus);
    document.addEventListener("focusout", updateAfterFocus);
    updateAction();
    createEffect(() => {
      tab();
      const frame = requestAnimationFrame(updateAction);
      onCleanup(() => cancelAnimationFrame(frame));
    });
    onCleanup(() => {
      observer?.disconnect();
      window.removeEventListener("scroll", updateAction);
      window.removeEventListener("resize", updateAction);
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("focusin", updateAfterFocus);
      document.removeEventListener("focusout", updateAfterFocus);
      root.style.removeProperty("--job-action-height");
    });
  });

  const selectSong = (song: SongSummary, scroll = false) => {
    setResultsRefreshToken(value => value + 1);
    selectionGeneration++;
    selectedWorkId = song.latest_work_id;
    if (selectedId() !== song.id) {
      selectedRevision++;
      setDetail(null);
      setJob(null);
      setSelectedId(song.id);
    }
    setAugmentation(null);
    setSubmissionNotice("");
    setHistoryScrollRequest(null);
    void refreshSelectedSong(song.id, scroll ? ++historyScrollToken : undefined, true);
    for (const workId of song.active_work_ids) watchWork(workId, song.id);
  };
  const viewTrackedJob = () => {
    const tracked = trackedJob();
    const songId = trackedSongId;
    const selection = selectionGeneration;
    if (!tracked || songId === null) return;
    const open = (song: SongSummary) => {
      if (selection !== selectionGeneration || trackedSongId !== songId || trackedJob()?.id !== tracked.id) return;
      selectSong(song);
      setJob(trackedJob());
      setTab("workspace");
      if (libraryOpen()) { viewingFromLibrary = true; selectedFromLibrary = false; setLibraryOpen(false); }
      else requestAnimationFrame(() => { progressTarget?.scrollIntoView({ block: "start", behavior: "auto" }); progressTarget?.focus({ preventScroll: true }); });
    };
    const song = history().find(item => item.id === songId);
    if (song) open(song);
    else void getSong(songId).then(result => open(result.summary)).catch(() => setSelectedJobRefreshError("Could not open the tracked song."));
  };
  onMount(async () => {
    const revision = selectedRevision;
    try {
      const current = await getCurrentSong();
      if (current && revision === selectedRevision && selectedId() === null) {
        selectSong(current);
        const work = await getJob(current.latest_work_id);
        if (!trackedJob()) {
          setTrackedJob(workSnapshots.get(work.id) ?? work);
          trackedSongId = current.id;
        }
      }
    } catch { /* A failed initial load leaves the workspace empty. */ }
    void refreshHistory();
  });
  const onSubmitted = (newJob: JobDTO | null, songId: number, token?: number, targetSongId?: number) => {
    const select = token === undefined || token === selectionGeneration;
    if (select) {
      selectionGeneration++;
      selectedWorkId = newJob?.id ?? (selectedId() === songId ? selectedWorkId : null);
      if (selectedId() !== songId) { selectedRevision++; setDetail(null); setSelectedId(songId); }
      setSubmissionNotice(newJob ? "" : "Those outputs are already available.");
      setJob(newJob);
      setLibraryOpen(false);
      setHistoryScrollRequest(null);
      if (targetSongId !== undefined) {
        setAugmentation(target => target && (target.id === targetSongId || target.id === songId) ? { ...target, id: songId } : target);
      }
      void refreshSelectedSong(songId);
    }
    if (newJob) {
      trackedSongId = songId;
      setTrackedJob(newJob);
      if (newJob.status === "queued" || newJob.status === "running") watchWork(newJob.id, songId);
    }
    void refreshHistory();
  };
  const retrySelectedJob = async () => {
    const failed = job();
    if (!failed || failed.status !== "failed" || retryingId() !== null) return;
    const token = selectionGeneration;
    setRetryingId(failed.id);
    setRetryError(null);
    try {
      const result = await retryJob(failed.id);
      onSubmitted(result.work_id === null ? null : { ...failed, id: result.work_id, song_id: result.song_id, status: result.status, position: result.position, progress: result.progress, error_message: null }, result.song_id, token);
    } catch (error) {
      setRetryError({ jobId: failed.id, message: error instanceof Error ? error.message : "Could not retry this job." });
    } finally { setRetryingId(null); }
  };
  const onHistorySelect = (selected: SongSummary) => {
    void recordSongOpen(selected.id).then(({ id, open_count }) => {
      if (deletedSongIds.has(id)) return;
      acknowledgedCounts.set(id, Math.max(acknowledgedCounts.get(id) ?? 0, open_count));
      setHistory(items => items.map(item => item.id === id ? { ...item, open_count: Math.max(item.open_count, open_count) } : item));
      void refreshHistory();
    }).catch(() => {});
    selectSong(selected, true);
    if (libraryOpen()) { selectedFromLibrary = true; setLibraryOpen(false); }
  };
  const onReset = () => {
    selectionGeneration++;
    selectedRevision++;
    selectedWorkId = null;
    setSelectedId(null);
    setDetail(null);
    setJob(null);
    setAugmentation(null);
    setSelectedJobRefreshError(null);
    setHistoryScrollRequest(null);
  };
  const isActive = () => job()?.status === "queued" || job()?.status === "running";
  const onDeleted = (id: number) => {
    deletedSongIds.add(id);
    acknowledgedCounts.delete(id);
    historyRevision++;
    setHistory(items => items.filter(item => item.id !== id));
    if (trackedSongId === id) { setTrackedJob(null); trackedSongId = null; }
    if (selectedId() === id) onReset();
  };
  const selectTab = (next: "workspace" | "profile" | "admin") => {
    setTab(next);
    if (next === "workspace") {
      setResultsRefreshToken(value => value + 1);
      void refreshHistory();
      const id = selectedId();
      if (id !== null) void refreshSelectedSong(id, undefined, true);
    }
  };
  const LibraryHistory = () => <HistoryView jobs={orderedHistory()} selectedId={selectedId()} sort={librarySort()} onSortChange={setLibrarySort} onSelect={onHistorySelect} onDeleted={onDeleted} />;
  const outputTargets = createMemo<OutputTarget[]>(() => {
    const song = detail();
    if (!song) return [];
    const targets: OutputTarget[] = [];
    if (song.variants.some(v => v.karaoke_work_id !== null)) targets.push({ kind: "karaoke", id: "song-karaoke" });
    if (song.variants.some(v => v.pitched_lyrics_work_id !== null)) targets.push({ kind: "pitched-lyrics", id: "song-pitched-lyrics" });
    if (song.variants.some(v => v.lyrics_work_id !== null)) targets.push({ kind: "lyrics", id: "song-lyrics" });
    if (song.summary.has_original || song.variants.some(v => v.outputs.length)) targets.push({ kind: "audio", id: "song-audio" });
    return targets;
  });

  return (
    <main class="app-shell">
      <header class="app-header">
        <h1>ehpc's Vocal Tools</h1>
      </header>
      <nav class="account-nav" aria-label="Account navigation">
        <div class="account-tabs">
          <Button variant={tab() === "workspace" ? "secondary" : "ghost"} aria-pressed={tab() === "workspace"} onClick={() => selectTab("workspace")}>Workspace</Button>
          <Button variant={tab() === "profile" ? "secondary" : "ghost"} aria-pressed={tab() === "profile"} onClick={() => selectTab("profile")}>Profile</Button>
          <Show when={auth.profile().is_admin}><Button variant={tab() === "admin" ? "secondary" : "ghost"} aria-pressed={tab() === "admin"} onClick={() => selectTab("admin")}>Admin</Button></Show>
        </div>
        <div class="account-actions"><span>{auth.profile().email}</span><Button variant="outline" onClick={() => { setAccountError(""); void auth.logout().catch((error) => setAccountError(error instanceof Error ? error.message : "Could not sign out.")); }}>Sign out</Button></div>
      </nav>
      <Show when={accountError()}><p role="alert" class="auth-error">{accountError()}</p></Show>
      <Show when={tab() === "profile"}><ProfileView profile={auth.profile()} refresh={auth.refresh} /></Show>
      <Show when={tab() === "admin" && auth.profile().is_admin}><AdminView /></Show>
      <div hidden={tab() !== "workspace"}>
      <div class="library-workspace">
        <Show when={!mobileLibrary()}>
          <aside class="library-rail" aria-label="Library"><h2>Library</h2><LibraryHistory /></aside>
        </Show>
        <div class="library-main">
          <Show when={mobileLibrary()}>
            <Dialog.Root open={libraryOpen()} onOpenChange={setLibraryOpen}>
              <Dialog.Trigger as={Button} ref={libraryTrigger} type="button" variant="outline" class="library-trigger">Library <span aria-hidden="true">Browse ›</span></Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay class="library-overlay" />
                <Dialog.Content class="library-drawer" onCloseAutoFocus={event => {
                  if (viewingFromLibrary) {
                    event.preventDefault();
                    viewingFromLibrary = false;
                    requestAnimationFrame(() => {
                      progressTarget?.scrollIntoView({ block: "start", behavior: "auto" });
                      progressTarget?.focus({ preventScroll: true });
                    });
                  } else if (selectedFromLibrary) {
                    event.preventDefault();
                    selectedFromLibrary = false;
                    libraryTrigger?.focus({ preventScroll: true });
                  }
                }}>
                  <div class="library-drawer-header"><Dialog.Title>Library</Dialog.Title><Dialog.CloseButton as={Button} type="button" variant="outline" aria-label="Close library">Close</Dialog.CloseButton></div>
                  <Dialog.Description class="sr-only">Choose a song to open its results.</Dialog.Description>
                  <Show when={trackedJob()}>{tracked => <Button type="button" variant="outline" onClick={viewTrackedJob}>View {tracked().status === "done" ? "result" : tracked().status === "failed" ? "error" : "progress"}</Button>}</Show>
                  <LibraryHistory />
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          </Show>
          <Show when={selectedJobRefreshError()}><p role="alert" class="auth-error">{selectedJobRefreshError()}</p></Show>
          <Show when={submissionNotice()}><p role="status">{submissionNotice()}</p></Show>
      <div ref={sourceTarget} tabIndex={-1}>
        <SubmitForm onSubmitted={onSubmitted} selectionToken={() => selectionGeneration} target={augmentationTarget()} onClearTarget={() => setAugmentation(null)} />
      </div>

      <Show when={selectedId() !== null}>
        <div class="processing-results" ref={progressTarget} tabIndex={-1}>
          <Show when={detail()}>{song => <Button type="button" variant="outline" onClick={() => {
            setAugmentation(song().summary);
            requestAnimationFrame(() => {
              sourceTarget?.scrollIntoView({ block: "start", behavior: "instant" });
              sourceTarget?.focus({ preventScroll: true });
            });
          }}>Add outputs</Button>}</Show>
          <Show when={isActive()}>
            <QueueStatus job={job()!} />
          </Show>
          <Show when={detail()}>{song =>
            <ResultsView detail={song()} onReset={onReset} scrollRequest={historyScrollRequest()} refreshToken={resultsRefreshToken()} onStaleDetail={id => { if (selectedId() === id) void refreshSelectedSong(id); }} />
          }</Show>
          <Show when={job()?.status === "failed"}>
            <section role="alert">
              <h2>Processing failed</h2>
              <p>{job()?.error_message || "The job failed."}</p>
              <Show when={detail()?.summary.has_original || detail()?.variants.length}><p>Previously generated outputs remain available.</p></Show>
              <Show when={retryError()?.jobId === job()?.id}><p>{retryError()!.message}</p></Show>
              <Button type="button" variant="outline" class="min-h-11" disabled={retryingId() !== null} onClick={() => void retrySelectedJob()}>
                {retryingId() === job()?.id ? "Retrying..." : "Retry"}
              </Button>
            </section>
          </Show>
        </div>
      </Show>
        </div>
      </div>


      </div>
      <OutputsNavigation targets={outputTargets()} visible={tab() === "workspace" && !libraryOpen() && !modalOpen()} />
      <Show when={trackedJob()}>{tracked => <JobStatusDock job={tracked()} onView={viewTrackedJob} />}</Show>
    </main>
  );
};

export default App;
