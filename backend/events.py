import asyncio
from collections import defaultdict
from typing import Any

from separator.progress import JobPhase

_subscribers: dict[int, list[asyncio.Queue]] = defaultdict(list)
_phases: dict[int, JobPhase] = {}


def set_phase(job_id: int, phase: JobPhase) -> None:
    _phases[job_id] = phase


def current_phase(job_id: int) -> JobPhase | None:
    return _phases.get(job_id)


def clear_phase(job_id: int) -> None:
    _phases.pop(job_id, None)


def subscribe(job_id: int) -> asyncio.Queue:
    queue: asyncio.Queue = asyncio.Queue()
    _subscribers[job_id].append(queue)
    return queue


def unsubscribe(job_id: int, queue: asyncio.Queue) -> None:
    subs = _subscribers.get(job_id)
    if subs is None:
        return
    subs.remove(queue)
    if not subs:
        del _subscribers[job_id]


def publish(job_id: int, payload: dict[str, Any]) -> None:
    for queue in _subscribers.get(job_id, []):
        queue.put_nowait(payload)
