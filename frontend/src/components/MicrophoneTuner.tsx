import { createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import { Button } from "~/components/button";
import { createMicrophonePitchDetector, MICROPHONE_WINDOW_SIZE, type MicrophonePitch } from "~/lib/microphonePitch";
import { noteName } from "~/lib/pitchNotes";

type MicrophoneState = "off" | "pending" | "listening";
const CENTS_LIMIT = 25;

const MicrophoneTuner: Component<{ onSample?: (pitch: MicrophonePitch | null, listening: boolean) => void }> = props => {
  const [state, setState] = createSignal<MicrophoneState>("off");
  const [pitch, setPitch] = createSignal<MicrophonePitch | null>(null);
  const [error, setError] = createSignal("");
  const [selectedDevice, setSelectedDevice] = createSignal("");
  const [devices, setDevices] = createSignal<MediaDeviceInfo[]>([]);
  const [deviceNamesAvailable, setDeviceNamesAvailable] = createSignal(false);
  let deviceListGeneration = 0;
  let disposed = false;
  let generation = 0;
  let context: AudioContext | undefined;
  let stream: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let analyser: AnalyserNode | undefined;
  let frame: number | undefined;

  const stop = () => {
    generation++;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    source?.disconnect();
    analyser?.disconnect();
    source = undefined;
    analyser = undefined;
    if (stream) for (const track of stream.getTracks()) { track.onended = null; track.stop(); }
    stream = undefined;
    if (context && context.state !== "closed") void context.close().catch(() => {});
    context = undefined;
    setPitch(null);
    setState("off");
    props.onSample?.(null, false);
  };
  const refreshDevices = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const revision = ++deviceListGeneration;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      if (disposed || revision !== deviceListGeneration) return;
      const seen = new Set<string>();
      const inputs = all.filter(device => {
        if (device.kind !== "audioinput" || !device.deviceId || device.deviceId === "default" || device.deviceId === "communications" || seen.has(device.deviceId)) return false;
        seen.add(device.deviceId);
        return true;
      });
      setDevices(inputs);
      setDeviceNamesAvailable(true);
      const selected = selectedDevice();
      if (selected && !inputs.some(device => device.deviceId === selected) && state() !== "off") {
        stop();
        setError("The selected microphone is unavailable or disconnected. Choose another input to continue.");
      }
    } catch {
      // Capture can still work if the browser does not expose a device list.
    }
  };
  const visibility = () => { if (document.hidden) stop(); };
  const deviceChange = () => { if (deviceNamesAvailable()) void refreshDevices(); };
  onMount(() => {
    document.addEventListener("visibilitychange", visibility);
    navigator.mediaDevices?.addEventListener?.("devicechange", deviceChange);
  });
  onCleanup(() => {
    disposed = true;
    deviceListGeneration++;
    navigator.mediaDevices?.removeEventListener?.("devicechange", deviceChange);
    document.removeEventListener("visibilitychange", visibility);
    stop();
  });

  const start = () => {
    if (state() !== "off") return;
    setError("");
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
      setError("Microphone pitch detection requires HTTPS and browser microphone support.");
      return;
    }
    const attempt = ++generation;
    setState("pending");
    props.onSample?.(null, false);
    try {
      const current = new AudioContext();
      context = current;
      // Both operations begin in the click gesture, before any asynchronous wait.
      const resumed = current.resume().then(() => null, () => "Microphone audio could not start.");
      const deviceId = selectedDevice();
      const requested = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, video: false });
      void (async () => {
        try {
          const incoming = await requested;
          if (attempt !== generation) { for (const track of incoming.getTracks()) track.stop(); return; }
          stream = incoming;
          const resumeError = await resumed;
          if (attempt !== generation) return;
          if (resumeError || current.state !== "running") throw new Error(resumeError ?? "Microphone audio could not start.");
          source = current.createMediaStreamSource(incoming);
          analyser = current.createAnalyser();
          analyser.fftSize = MICROPHONE_WINDOW_SIZE;
          source.connect(analyser); // Deliberately never connected to the audio output.
          const samples = new Float32Array(MICROPHONE_WINDOW_SIZE);
          const detect = createMicrophonePitchDetector();
          for (const track of incoming.getAudioTracks()) track.onended = () => {
            if (attempt === generation) { stop(); setError("Microphone input stopped. Start it again to continue."); }
          };
          setState("listening");
          void refreshDevices();
          let last = 0;
          const update = (time: number) => {
            if (attempt !== generation || !analyser) return;
            if (time - last >= 50) {
              last = time;
              analyser.getFloatTimeDomainData(samples);
              const next = detect(samples, current.sampleRate);
              props.onSample?.(next, true);
              setPitch(previous => previous?.midi === next?.midi && previous?.cents === next?.cents ? previous : next);
            }
            frame = requestAnimationFrame(update);
          };
          frame = requestAnimationFrame(update);
        } catch (cause) {
          if (attempt !== generation) return;
          stop();
          const name = typeof cause === "object" && cause !== null && "name" in cause && typeof cause.name === "string" ? cause.name : "";
          setError(name === "NotAllowedError" || name === "SecurityError"
            ? "Microphone permission was denied. Allow access and try again."
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? selectedDevice() ? "The selected microphone is unavailable or disconnected. Choose another input to continue." : "No microphone was found. Connect one and try again."
            : "Microphone pitch detection could not start. Check your browser and microphone settings.");
        }
      })();
    } catch {
      if (attempt === generation) { stop(); setError("Microphone pitch detection could not start. Check your browser and microphone settings."); }
    }
  };
  const toggle = () => {
    if (state() !== "off") { stop(); setError(""); }
    else start();
  };
  const selectDevice = (deviceId: string) => {
    if (deviceId === selectedDevice()) return;
    const active = state() !== "off";
    if (active) stop();
    setSelectedDevice(deviceId);
    setError("");
    if (active) start();
  };
  const gauge = () => Math.max(-CENTS_LIMIT, Math.min(CENTS_LIMIT, pitch()?.cents ?? 0));
  return <section class="mic-tuner" aria-label="Live microphone pitch">
    <Button type="button" variant="outline" class="mic-tuner-button" aria-label={state() === "off" ? "Start microphone pitch detection" : "Stop microphone pitch detection"}
      aria-pressed={state() !== "off"} onClick={toggle}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
      </svg>
    </Button>
    <label class="mic-tuner-device">
      <span class="sr-only">Microphone input</span>
      <select aria-label="Microphone input" title={deviceNamesAvailable() ? undefined : "Microphone names become available after permission is granted."} value={selectedDevice()} onChange={event => selectDevice(event.currentTarget.value)}>
        <option value="" selected={!selectedDevice()}>System default</option>
        <Show when={selectedDevice() && !devices().some(device => device.deviceId === selectedDevice())}>
          <option value={selectedDevice()} selected>Selected microphone unavailable</option>
        </Show>
        <For each={devices()}>{(device, index) => <option value={device.deviceId} selected={selectedDevice() === device.deviceId}>{device.label || `Microphone ${index() + 1}`}</option>}</For>
      </select>
    </label>
    <div class="mic-tuner-display">
      <div class="mic-tuner-reading">
        <Show when={pitch()} fallback={<span>{state() === "pending" ? "Waiting for microphone…" : state() === "listening" ? "Listening for a clear note…" : "Microphone off"}</span>}>
          {value => <><strong>{noteName(value().midi)}</strong><span>{value().cents > 0 ? "+" : ""}{value().cents} cents</span></>}
        </Show>
      </div>
      <div class="mic-tuner-scale" aria-hidden="true">
        <span>−{CENTS_LIMIT}</span><div class="mic-tuner-track"><span class="mic-tuner-center" />
          <Show when={pitch()}><span class="mic-tuner-fill" style={{ left: `${50 + Math.min(gauge(), 0) / CENTS_LIMIT * 50}%`, width: `${Math.abs(gauge()) / CENTS_LIMIT * 50}%` }} /></Show>
        </div><span>+{CENTS_LIMIT}</span>
      </div>
    </div>
    <Show when={error()}><p role="alert" class="mic-tuner-error">{error()}</p></Show>
  </section>;
};

export default MicrophoneTuner;
