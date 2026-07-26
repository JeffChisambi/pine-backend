---
name: Malawi NRC number format and OCR patterns
description: Malawi National Registration Card number is NNNNNN/NN/N. OCR commonly misreads the / separator.
---

**Format:** `NNNNNN/NN/N` — 6 digits, slash, 2 digits, slash, 1 digit.  
Example: `123456/78/9`

**OCR noise:** The `/` separator is frequently misread as `|`, `\`, `l`, `I`, or `1`. The parser applies `correctOcrNoise()` before any regex matching, replacing `(\d)[|\\lI](\d)` → `$1/$2`.

**Regexes (in priority order):**
1. Strict post-correction: `/\b(\d{6}\/\d{2}\/\d)\b/`
2. Loose (noise still present): `/\b(\d{6}[\/|\\lI1]\d{2}[\/|\\lI1]\d)\b/`

**Card labels (all three languages on-card):**
- English: `National Registration Number`, `NRC No`
- Chichewa: `Nambala ya Mbadwo`
- Date of Birth label: `Tsiku la Kubadwa` / `Date de naissance`
- Surname label: `Dzina la Mzana` / `Nom de famille`

**Date format on card:** DD/MM/YYYY

**Known districts for address fallback:** Lilongwe, Blantyre, Mzuzu, Zomba, Kasungu, Mzimba, Karonga, Salima, and 18 others — see `MalawiIdParser.extractAddress()`.

**Why:** The original regex patterns matched generic alphanumeric ID formats and never matched the Malawi NRC number, making national ID extraction completely non-functional.
