from enum import StrEnum


class JobPhase(StrEnum):
    SOURCE = "source"
    ANALYSIS = "analysis"
    WAIT = "wait"
    METADATA = "metadata"
    SEPARATION = "separation"
    LYRICS = "lyrics"
    PITCH = "pitch"
    EXPORT = "export"
