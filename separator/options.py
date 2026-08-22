from dataclasses import dataclass


@dataclass(frozen=True)
class SeparationOptions:
    decrowd: bool = False
    decrowd_vocals: bool = False
    dereverb: bool = False
    genders: bool = False
    lead_backing: bool = False
    drums: bool = False
    no_cache: bool = False
