"""Temporary CPU-only mounted Volume lifecycle control; no model or GPU."""
import hashlib
import json
import os
import platform
import re
import sys
import time
from pathlib import Path

run = os.environ['GITHUB_RUN_ID']
attempt = os.environ['GITHUB_RUN_ATTEMPT']
app_name = f'audio-upload-diag-{run}-{attempt}'
environment = 'ehpc-audio'
if not run.isdecimal() or not attempt.isdecimal() or os.environ.get('MODAL_APP_NAME') != app_name or os.environ.get('MODAL_ENVIRONMENT') != environment:
    raise RuntimeError('Diagnostic app/environment guard failed')
root = Path(os.environ['GITHUB_WORKSPACE'])
private = Path(os.environ['RUNNER_TEMP']) / f'audio-upload-diag-{run}-{attempt}'
sys.path.insert(0, str(root))
import modal
from separator.inference_transport import transport_volume_name
owner = json.loads((private / 'owner.json').read_text())
if owner['app'] != app_name or owner['name'] != transport_volume_name(app_name, environment):
    raise RuntimeError('Volume ownership receipt mismatch')
volume = modal.Volume.from_name(owner['name'], environment_name=environment, version=2)
volume.hydrate()
if volume.object_id != owner['id']:
    raise RuntimeError('Volume identity changed')
app = modal.App(app_name)
image = modal.Image.debian_slim(python_version='3.12')


@app.function(
    image=image,
    volumes={'/transfer': volume},
    cpu=(0.25, 0.25),
    memory=(512, 512),
    timeout=30,
    min_containers=0,
    buffer_containers=0,
    max_containers=1,
    scaledown_window=60,
    retries=0,
    block_network=True,
    serialized=True,
)
def mounted(transfer_id, expected_sha, expected_fingerprint):
    import hashlib
    import json
    import os
    import platform
    import re
    import sys
    from pathlib import Path

    if not re.fullmatch(r'[0-9a-f]{32}', transfer_id):
        raise ValueError('Invalid diagnostic transfer')
    volume.reload()
    directory = Path('/transfer') / transfer_id
    source = (directory / 'input.bin').read_bytes()
    metadata = json.loads((directory / 'request.json').read_bytes())
    source_sha = hashlib.sha256(source).hexdigest()
    request = metadata['request']
    fingerprint = hashlib.sha256(json.dumps({'operation': request['operation'], 'source_sha256': source_sha, 'producer_digest': request['producer_digest'], 'parameters': request['parameters']}, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()
    if source_sha != expected_sha or fingerprint != expected_fingerprint or metadata['request_fingerprint'] != expected_fingerprint or metadata['audio_size'] != len(source):
        raise ValueError('Diagnostic request mismatch')
    (directory / 'cpu-control-marker').write_bytes(b'cpu-control-marker-v1')
    volume.commit()
    task = os.environ.get('MODAL_TASK_ID')
    return {'python': sys.version.split()[0], 'kernel': platform.release(), 'task_hash': hashlib.sha256(task.encode()).hexdigest() if task else None}


def durable_json(path, value):
    temporary = path.with_suffix('.partial')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(value, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


durable_json(private / 'app-intent.json', {'name': app_name})

with app.run(name=app_name, environment_name=environment):
    if not isinstance(app.app_id, str) or not re.fullmatch(r'ap-[A-Za-z0-9]+', app.app_id):
        raise RuntimeError('Diagnostic app identity unavailable')
    durable_json(private / 'app-owner.json', {'name': app_name, 'id': app.app_id})
    for cycle in range(12, 24):
        command = private / f'command-{cycle}.json'
        while not command.exists():
            if (private / 'stop-app-owner').exists():
                raise SystemExit(0)
            time.sleep(0.1)
        data = json.loads(command.read_text())
        try:
            call = mounted.spawn(data['id'], data['sha'], data['fingerprint'])
            result = call.get(timeout=40)
            durable_json(private / f'result-{cycle}.json', {'result': result})
        except Exception as error:
            durable_json(private / f'result-{cycle}.json', {'error_class': type(error).__name__})
            break
    while not (private / 'stop-app-owner').exists():
        time.sleep(0.1)
