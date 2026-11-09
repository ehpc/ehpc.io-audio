import { createSignal, onCleanup, onMount, Show, type Component } from "solid-js";
import type { JobDTO } from "./api";
import { getCurrentJob, listJobs } from "./api";
import SubmitForm from "./components/SubmitForm";
import QueueStatus from "./components/QueueStatus";
import ResultsView from "./components/ResultsView";
import HistoryView from "./components/HistoryView";
import { useAuth } from "./AuthProvider";
import ProfileView from "./ProfileView";
import AdminView from "./AdminView";
import { Button } from "~/components/button";

const App: Component = () => {
  const [job, setJob] = createSignal<JobDTO | null>(null);
  const [history, setHistory] = createSignal<JobDTO[]>([]);
  const auth = useAuth();
  const [tab, setTab] = createSignal<"workspace" | "profile" | "people">("workspace");
  const [accountError, setAccountError] = createSignal("");

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
      <nav class="account-nav" aria-label="Account navigation">
        <div class="account-tabs">
          <Button variant={tab() === "workspace" ? "secondary" : "ghost"} aria-pressed={tab() === "workspace"} onClick={() => setTab("workspace")}>Workspace</Button>
          <Button variant={tab() === "profile" ? "secondary" : "ghost"} aria-pressed={tab() === "profile"} onClick={() => setTab("profile")}>Profile</Button>
          <Show when={auth.profile().is_admin}><Button variant={tab() === "people" ? "secondary" : "ghost"} aria-pressed={tab() === "people"} onClick={() => setTab("people")}>People</Button></Show>
        </div>
        <div class="account-actions"><span>{auth.profile().email}</span><Button variant="outline" onClick={() => { setAccountError(""); void auth.logout().catch((error) => setAccountError(error instanceof Error ? error.message : "Could not sign out.")); }}>Sign out</Button></div>
      </nav>
      <Show when={accountError()}><p role="alert" class="auth-error">{accountError()}</p></Show>
      <Show when={tab() === "profile"}><ProfileView profile={auth.profile()} refresh={auth.refresh} /></Show>
      <Show when={tab() === "people" && auth.profile().is_admin}><AdminView /></Show>
      <div hidden={tab() !== "workspace"}>

      <SubmitForm onSubmitted={onSubmitted} />

      <Show when={isActive()}>
        <QueueStatus job={job()!} onTerminal={onTerminal} />
      </Show>

      <Show when={isDone()}>
        <ResultsView job={job()!} onReset={() => setJob(null)} />
      </Show>

      <HistoryView jobs={history()} onSelect={setJob} onRetried={onSubmitted} />
      </div>
    </main>
  );
};

export default App;
