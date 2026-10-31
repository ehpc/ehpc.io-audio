import { createSignal, onCleanup, onMount, Show, type Component } from "solid-js";
import type { JobDTO } from "./api";
import { getCurrentJob, listJobs } from "./api";
import SubmitForm from "./components/SubmitForm";
import QueueStatus from "./components/QueueStatus";
import ResultsView from "./components/ResultsView";
import HistoryView from "./components/HistoryView";

const App: Component = () => {
  const [job, setJob] = createSignal<JobDTO | null>(null);
  const [history, setHistory] = createSignal<JobDTO[]>([]);

  onMount(() => {
    const pauseOtherAudio = (event: Event) => {
      const current = event.target;
      if (!(current instanceof HTMLAudioElement)) return;
      document.querySelectorAll("audio").forEach((audio) => {
        if (audio !== current && !audio.paused) audio.pause();
      });
    };
    document.addEventListener("play", pauseOtherAudio, true);
    onCleanup(() => document.removeEventListener("play", pauseOtherAudio, true));
  });

  const refreshHistory = async () => {
    try {
      setHistory(await listJobs());
    } catch {
      // leave the previous list in place if this refresh fails
    }
  };

  onMount(async () => {
    try {
      setJob(await getCurrentJob());
    } catch {
      setJob(null);
    }
    refreshHistory();
  });

  const onSubmitted = (newJob: JobDTO) => {
    setJob(newJob);
    refreshHistory();
  };

  const onTerminal = (finished: JobDTO) => {
    setJob(finished);
    refreshHistory();
  };

  const isActive = () => job()?.status === "queued" || job()?.status === "running";
  const isDone = () => job()?.status === "done";

  return (
    <main class="app-shell">
      <header class="app-header">
        <h1>ehpc's Vocal Tools</h1>
        <p>Your audio workspace</p>
      </header>

      <SubmitForm onSubmitted={onSubmitted} />

      <Show when={isActive()}>
        <QueueStatus job={job()!} onTerminal={onTerminal} />
      </Show>

      <Show when={isDone()}>
        <ResultsView job={job()!} onReset={() => setJob(null)} />
      </Show>

      <HistoryView jobs={history()} onSelect={setJob} onRetried={onSubmitted} />
    </main>
  );
};

export default App;
