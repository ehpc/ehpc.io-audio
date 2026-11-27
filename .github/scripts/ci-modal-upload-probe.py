"""Temporary, CPU-only branch diagnostic for Modal Volume V2 staging."""
import hashlib
import importlib.metadata
import json
import os
import platform
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

RUN = os.environ['GITHUB_RUN_ID']
ATTEMPT = os.environ['GITHUB_RUN_ATTEMPT']
APP = f'audio-upload-diag-{RUN}-{ATTEMPT}'
ENVIRONMENT = 'ehpc-audio'
if not RUN.isdecimal() or not ATTEMPT.isdecimal() or os.environ.get('MODAL_APP_NAME') != APP or os.environ.get('MODAL_ENVIRONMENT') != ENVIRONMENT:
    raise RuntimeError('Diagnostic app/environment guard failed')
if APP in {'audio-inference-v3', 'audio-separator', 'audio-separator-v2'}:
    raise RuntimeError('Production target refused')
ROOT = Path(os.environ['GITHUB_WORKSPACE'])
PRIVATE = Path(os.environ['RUNNER_TEMP']) / f'audio-upload-diag-{RUN}-{ATTEMPT}'
ARTIFACT = ROOT / 'audio-upload-diagnostic'
OWNER = PRIVATE / 'owner.json'
TRACE = PRIVATE / 'trace.jsonl'
ACTIVE = None
APP_PROCESS = None
PRIVATE.mkdir(mode=0o700, parents=True, exist_ok=True)
ARTIFACT.mkdir(mode=0o700, exist_ok=True)
os.environ['DATA_DIR'] = str(PRIVATE / 'data')
os.environ['MODAL_INPUT_UPLOAD_TIMEOUT_S'] = '90'
sys.path.insert(0, str(ROOT))

INSTRUMENT = '''
import asyncio, json, os
from pathlib import Path
from modal._object import _Object
from modal.volume import _Volume, _VolumeUploadContextManager2
import modal.volume as volume
path = os.environ['DIAGNOSTIC_TRACE']
def mark(phase, method, stack=None):
 record={'phase': phase, 'method': method}
 if stack is not None: record['stack']=stack
 fd=os.open(path, os.O_WRONLY|os.O_CREAT|os.O_APPEND, 0o600)
 with os.fdopen(fd, 'a') as f: f.write(json.dumps(record)+'\\n')
async def watch():
 while True:
  await asyncio.sleep(5)
  for task in asyncio.all_tasks():
   coro=task.get_coro(); seen=set(); frames=[]
   while coro is not None and id(coro) not in seen and len(frames)<20:
    seen.add(id(coro)); code=getattr(coro,'cr_code',None) or getattr(coro,'ag_code',None) or getattr(coro,'gi_code',None)
    frame=getattr(coro,'cr_frame',None) or getattr(coro,'ag_frame',None) or getattr(coro,'gi_frame',None)
    if code: frames.append({'file':Path(code.co_filename).name,'method':code.co_name,'line':frame.f_lineno if frame else 0})
    coro=getattr(coro,'cr_await',None) or getattr(coro,'ag_await',None) or getattr(coro,'gi_yieldfrom',None)
   if frames: mark('snapshot','await',frames)
async def finish(task):
 task.cancel()
 try: await task
 except asyncio.CancelledError: pass
old_hydrate=_Object.hydrate
async def hydrate(self,*a,**kw):
 if not isinstance(self,_Volume): return await old_hydrate(self,*a,**kw)
 mark('hydrate','begin'); task=asyncio.create_task(watch())
 try: return await old_hydrate(self,*a,**kw)
 finally: await finish(task); mark('hydrate','end')
_Object.hydrate=hydrate
old_enter=_VolumeUploadContextManager2.__aenter__
async def enter(self,*a,**kw):
 mark('batch','enter'); self._probe_task=asyncio.create_task(watch()); return await old_enter(self,*a,**kw)
_VolumeUploadContextManager2.__aenter__=enter
old_exit=_VolumeUploadContextManager2.__aexit__
async def exit(self,*a,**kw):
 mark('batch','exit_begin')
 try: return await old_exit(self,*a,**kw)
 finally: await finish(self._probe_task); mark('batch','exit_end')
_VolumeUploadContextManager2.__aexit__=exit
old_put=_VolumeUploadContextManager2._put_file_specs
async def put(self,*a,**kw):
 mark('put_files','begin')
 try: return await old_put(self,*a,**kw)
 finally: mark('put_files','end')
_VolumeUploadContextManager2._put_file_specs=put
old_blocks=volume._put_missing_blocks
async def blocks(*a,**kw):
 mark('missing_blocks','begin')
 try: return await old_blocks(*a,**kw)
 finally: mark('missing_blocks','end')
volume._put_missing_blocks=blocks
'''


def emit(**event):
    with (ARTIFACT / 'events.jsonl').open('a') as output:
        output.write(json.dumps(event, sort_keys=True) + '\n')


def transfer_id(cycle):
    return hashlib.sha256(f'{RUN}:{ATTEMPT}:{cycle}'.encode()).hexdigest()[:32]


def request_for(cycle):
    from separator.inference import InferenceRequest
    seed = b'reused' if cycle % 2 == 0 else f'unique-{cycle}'.encode()
    audio = hashlib.shake_256(seed).digest(324315)
    return InferenceRequest('separation', audio, 'synthetic.mp3', 'a' * 64, {'model': 'cpu-diagnostic', 'iteration': cycle})


def name_for():
    from separator.inference_transport import transport_volume_name
    name = transport_volume_name(APP, ENVIRONMENT)
    if name == transport_volume_name('audio-inference-v3', ENVIRONMENT):
        raise RuntimeError('Production volume refused')
    return name


def owned_volume():
    import modal
    saved = json.loads(OWNER.read_text())
    if saved['name'] != name_for() or saved['app'] != APP:
        raise RuntimeError('Ownership receipt mismatch')
    volume = modal.Volume.from_name(saved['name'], environment_name=ENVIRONMENT, version=2)
    volume.hydrate()
    if volume.object_id != saved['id']:
        raise RuntimeError('Volume identity changed')
    return volume


def worker(phase, cycle):
    import modal
    from backend import config, modal_client
    if config.MODAL_APP_NAME != APP or config.MODAL_ENVIRONMENT != ENVIRONMENT:
        raise RuntimeError('Backend target mismatch')
    name = name_for()
    if phase == 'create':
        if OWNER.exists():
            raise RuntimeError('Ownership receipt already exists')
        modal.Volume.objects.create(name, environment_name=ENVIRONMENT, version=2, allow_existing=False)
        volume = modal.Volume.from_name(name, environment_name=ENVIRONMENT, version=2)
        volume.hydrate()
        fd = os.open(OWNER, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as output:
            json.dump({'app': APP, 'name': name, 'id': volume.object_id}, output)
            output.flush()
            os.fsync(output.fileno())
        return
    if phase == 'upload':
        owned_volume()
        # The parent already installed temporary instrumentation for this worker.
        # The production uploader starts another interpreter and inherits it.
        modal_client.stage_input(request_for(cycle), transfer_id(cycle))
        return
    if phase in {'check_app', 'stop_app'}:
        receipt_path = PRIVATE / 'app-owner.json'
        if phase == 'stop_app' and not receipt_path.exists():
            raise RuntimeError('Diagnostic app ownership unavailable')
        cli = str(Path(sys.executable).parent / 'modal')
        def apps():
            raw = subprocess.check_output([cli, 'app', 'list', '--json', '--env', ENVIRONMENT], timeout=15)
            return [row for row in json.loads(raw) if row['description'] == APP]
        matches = apps()
        if phase == 'check_app':
            if matches:
                raise RuntimeError('Diagnostic app name already exists')
            return
        receipt = json.loads(receipt_path.read_text())
        if receipt['name'] != APP or len(matches) != 1 or matches[0]['app_id'] != receipt['id']:
            raise RuntimeError('Diagnostic app identity mismatch')
        if matches[0]['state'] != 'stopped':
            subprocess.run([cli, 'app', 'stop', '-y', receipt['id'], '--env', ENVIRONMENT], check=True, capture_output=True, timeout=15)
        deadline = time.monotonic() + 45
        while True:
            matches = apps()
            if len(matches) != 1 or matches[0]['app_id'] != receipt['id']:
                raise RuntimeError('Diagnostic app identity changed')
            if matches[0]['state'] == 'stopped' and int(matches[0]['tasks']) == 0:
                return
            if time.monotonic() >= deadline:
                raise TimeoutError('Diagnostic app did not stop')
            time.sleep(2)
    volume = owned_volume()
    if phase == 'read':
        request = request_for(cycle)
        digest = hashlib.sha256()
        size = 0
        for chunk in volume.read_file('/' + transfer_id(cycle) + '/input.bin'):
            digest.update(chunk)
            size += len(chunk)
        metadata = json.loads(b''.join(volume.read_file('/' + transfer_id(cycle) + '/request.json')))
        if size != len(request.audio_bytes) or digest.digest() != hashlib.sha256(request.audio_bytes).digest() or metadata['request_fingerprint'] != request.fingerprint():
            raise RuntimeError('Readback integrity mismatch')
        if cycle >= 12 and b''.join(volume.read_file('/' + transfer_id(cycle) + '/cpu-control-marker')) != b'cpu-control-marker-v1':
            raise RuntimeError('Mounted control marker mismatch')
    elif phase == 'remove':
        volume.remove_file('/' + transfer_id(cycle), recursive=True)
        try:
            entries = list(volume.iterdir('/' + transfer_id(cycle), recursive=False))
        except modal.exception.NotFoundError:
            entries = []
        if entries:
            raise RuntimeError('Diagnostic transfer still exists')
    elif phase == 'cleanup':
        modal.Volume.objects.delete(name, environment_name=ENVIRONMENT)
        try:
            modal.Volume.from_name(name, environment_name=ENVIRONMENT).hydrate()
        except modal.exception.NotFoundError:
            return
        raise RuntimeError('Diagnostic volume still exists')
    else:
        raise ValueError('Unsupported phase')


def run_phase(phase, cycle, timeout):
    global ACTIVE
    started = time.monotonic()
    output = PRIVATE / f'{phase}-{cycle}.raw'
    instrumentation = PRIVATE / 'instrumentation'
    instrumentation.mkdir(mode=0o700, exist_ok=True)
    (instrumentation / 'sitecustomize.py').write_text(INSTRUMENT)
    child_env = os.environ.copy()
    child_env['DIAGNOSTIC_TRACE'] = str(TRACE)
    child_env['PYTHONPATH'] = str(instrumentation) + os.pathsep + str(ROOT)
    child_env['MODAL_LOGLEVEL'] = 'ERROR'
    with output.open('wb') as sink:
        ACTIVE = subprocess.Popen([sys.executable, __file__, 'worker', phase, str(cycle)], cwd=ROOT, env=child_env, stdout=sink, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            status = ACTIVE.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(ACTIVE.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            ACTIVE.wait()
            emit(phase=phase, method='timeout', cycle=cycle, elapsed=round(time.monotonic()-started, 3), exception_class='TimeoutExpired')
            return False
        finally:
            ACTIVE = None
    exception = None
    if status != 0:
        matches = re.findall(r'^DIAG_EXCEPTION ([A-Za-z][A-Za-z0-9_]*)$', output.read_text(errors='replace'), re.MULTILINE)
        exception = matches[-1] if matches else 'WorkerFailure'
    emit(phase=phase, method='success' if status == 0 else 'failure', cycle=cycle, elapsed=round(time.monotonic()-started, 3), exception_class=exception)
    return status == 0


def publish_trace(cycle):
    if not TRACE.exists():
        return
    safe_phases = {'hydrate', 'batch', 'put_files', 'missing_blocks', 'snapshot'}
    safe_methods = {'begin', 'end', 'enter', 'exit_begin', 'exit_end', 'await'}
    for line in TRACE.read_text().splitlines():
        try:
            value = json.loads(line)
            if set(value) - {'phase', 'method', 'stack'} or value.get('phase') not in safe_phases or value.get('method') not in safe_methods:
                continue
            frames = value.get('stack', [])
            if not isinstance(frames, list) or any(set(frame) != {'file', 'method', 'line'} or not isinstance(frame['line'], int) or not re.fullmatch(r'[A-Za-z0-9_.<>-]+', frame['file']) or not re.fullmatch(r'[A-Za-z0-9_.<>-]+', frame['method']) for frame in frames):
                continue
            emit(cycle=cycle, **value)
        except (ValueError, TypeError, KeyError):
            continue
    TRACE.unlink()


def start_app(deadline):
    global APP_PROCESS
    if not run_phase('check_app', -1, min(60, max(0.1, deadline-time.monotonic()))):
        raise RuntimeError('Diagnostic app name check failed')
    output = PRIVATE / 'app-owner.raw'
    with output.open('wb') as sink:
        APP_PROCESS = subprocess.Popen([sys.executable, str(ROOT / '.github/scripts/ci-modal-mounted-control.py')], cwd=ROOT, stdout=sink, stderr=subprocess.STDOUT, start_new_session=True)
    started = time.monotonic()
    until = min(deadline, started + 120)
    receipt = PRIVATE / 'app-owner.json'
    while not receipt.exists():
        if APP_PROCESS.poll() is not None:
            emit(phase='app_start', method='failure', exception_class='AppOwnerExited')
            raise RuntimeError('Diagnostic app owner exited')
        if time.monotonic() >= until:
            emit(phase='app_start', method='timeout', exception_class='TimeoutExpired')
            raise TimeoutError('Diagnostic app start timed out')
        time.sleep(0.1)
    saved = json.loads(receipt.read_text())
    if saved['name'] != APP or not re.fullmatch(r'ap-[A-Za-z0-9]+', saved['id']):
        raise RuntimeError('Diagnostic app receipt invalid')
    emit(phase='app_start', method='success', elapsed=round(time.monotonic()-started, 3))


def stop_local_app():
    global APP_PROCESS
    if APP_PROCESS is None:
        return
    (PRIVATE / 'stop-app-owner').touch(mode=0o600)
    try:
        APP_PROCESS.wait(timeout=30)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(APP_PROCESS.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        APP_PROCESS.wait()
    APP_PROCESS = None


def mounted_call(cycle, deadline):
    request = request_for(cycle)
    command = PRIVATE / f'command-{cycle}.json'
    temporary = PRIVATE / f'command-{cycle}.partial'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump({'id': transfer_id(cycle), 'sha': hashlib.sha256(request.audio_bytes).hexdigest(), 'fingerprint': request.fingerprint()}, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, command)
    started = time.monotonic()
    until = min(deadline, started + 60)
    result_path = PRIVATE / f'result-{cycle}.json'
    while not result_path.exists():
        if APP_PROCESS is None or APP_PROCESS.poll() is not None:
            emit(phase='mounted_function', method='failure', cycle=cycle, exception_class='AppOwnerExited')
            raise RuntimeError('Mounted diagnostic owner exited')
        if time.monotonic() >= until:
            emit(phase='mounted_function', method='timeout', cycle=cycle, exception_class='TimeoutExpired')
            raise TimeoutError('Mounted diagnostic call timed out')
        time.sleep(0.1)
    response = json.loads(result_path.read_text())
    if 'error_class' in response:
        kind = response['error_class']
        if not isinstance(kind, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*', kind):
            kind = 'WorkerFailure'
        emit(phase='mounted_function', method='failure', cycle=cycle, exception_class=kind)
        raise RuntimeError('Mounted diagnostic call failed')
    emit(phase='mounted_function', method='success', cycle=cycle, elapsed=round(time.monotonic()-started, 3))
    return response['result']


def interrupt(signum, _frame):
    if ACTIVE is not None:
        try:
            os.killpg(ACTIVE.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        ACTIVE.wait()
    if APP_PROCESS is not None:
        try:
            os.killpg(APP_PROCESS.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        APP_PROCESS.wait()
    emit(phase='lifecycle', method='interrupted', exception_class='Signal')
    raise SystemExit(128 + signum)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == 'worker':
        try:
            worker(sys.argv[2], int(sys.argv[3]))
        except Exception as error:
            print('DIAG_EXCEPTION', type(error).__name__)
            raise SystemExit(1) from None
        return
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    if len(sys.argv) > 1 and sys.argv[1] == 'cleanup':
        if not OWNER.exists():
            emit(phase='cleanup', method='failure', exception_class='UnknownOwnership')
            raise SystemExit(1)
        if (PRIVATE / 'app-intent.json').exists():
            if not (PRIVATE / 'app-owner.json').exists():
                emit(phase='stop_app', method='failure', exception_class='UnknownOwnership')
                raise SystemExit(1)
            if not run_phase('stop_app', -1, 75):
                publish_trace(-1)
                raise SystemExit(1)
            publish_trace(-1)
        ok = run_phase('cleanup', -1, 60)
        publish_trace(-1)
        if not ok:
            raise SystemExit(1)
        return
    emit(phase='runtime', method='inspect', python=platform.python_version(), modal=importlib.metadata.version('modal'), os=platform.system(), kernel=platform.release())
    if platform.python_version() != '3.15.2' or importlib.metadata.version('modal') != '1.6.2':
        raise RuntimeError('Runtime does not match failed CI')
    ok = run_phase('create', -1, 60)
    publish_trace(-1)
    if not ok:
        raise SystemExit(1)
    deadline = time.monotonic() + 600
    last_task = None
    try:
        for cycle in range(24):
            if cycle == 0:
                emit(phase='mode', method='unmounted')
            if cycle == 12:
                start_app(deadline)
                emit(phase='mode', method='mounted')
            for phase, timeout in (('upload', 100), ('read', 60), ('remove', 60)):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    emit(phase='cycle', method='failure', cycle=cycle, exception_class='DiagnosticDeadline')
                    raise SystemExit(1)
                ok = run_phase(phase, cycle, min(timeout, remaining))
                publish_trace(cycle)
                if not ok:
                    raise SystemExit(1)
                if phase == 'upload' and cycle >= 12:
                    result = mounted_call(cycle, deadline)
                    python = result.get('python', '')
                    kernel = result.get('kernel', '')
                    if not re.fullmatch(r'[0-9.]+', python) or not re.fullmatch(r'[A-Za-z0-9_.+-]+', kernel):
                        raise RuntimeError('Invalid container runtime metadata')
                    if cycle == 12:
                        emit(phase='container_runtime', method='inspect', python=python, kernel=kernel, image='debian_slim_python_3.12')
                    task = result.get('task_hash')
                    method = 'task_unavailable' if not task else 'task_first' if last_task is None else 'task_reused' if task == last_task else 'task_changed'
                    emit(phase='container', method=method, cycle=cycle)
                    last_task = task
        emit(phase='diagnostic', method='success', cycle=24)
    finally:
        stop_local_app()


if __name__ == '__main__':
    main()
