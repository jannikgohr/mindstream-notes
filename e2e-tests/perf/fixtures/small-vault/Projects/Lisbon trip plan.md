Four days in late March. Flights are booked, the rest is still open.

## Itinerary

1. **Thursday:** arrive 14:20, check in near Príncipe Real, dinner in Bairro Alto
2. **Friday:** Belém in the morning, LX Factory in the afternoon
3. **Saturday:** day trip to Sintra, take the 9:11 train from Rossio
4. **Sunday:** Alfama walk, fly out 19:05

## Packing

- [x] Passport and EU health card
- [x] Power adapter
- [ ] Rain jacket, March is unpredictable
- [ ] Comfortable shoes for the hills

## Budget

| Item          | Estimate | Paid |
| ------------- | -------: | :--: |
| Flights       |    240 € |  ✓   |
| Hotel, 3 nts  |    390 € |  ✓   |
| Food          |    220 € |      |
| Sintra tickets|     45 € |      |

> Pastéis de Belém opens at 8:00. Go early or queue for forty minutes.

## Train times script

```python
from datetime import time

TRAINS = [time(8, 41), time(9, 11), time(9, 41)]

def next_train(now: time) -> time | None:
    return next((t for t in TRAINS if t > now), None)
```

See also [[Packing list template]] and [[Travel budget 2026]].
