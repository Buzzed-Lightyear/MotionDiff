# Parameter Guide

## Choosing frame offset
The offset controls the temporal "distance" of the comparison. A longer offset reveals slower motion because the displacement between frames is larger, making it more likely to cross the threshold.

| k value | Best for | Notes |
|---------|----------|-------|
| 1-3 | Fast motion, people walking, hand gestures | Keeps fast subjects from smearing too far between samples |
| 5-15 | General nature footage, moderate motion | Good default range for wind, water, and everyday outdoor scenes |
| 20-40 | Slow drift, clouds, fog, rising steam | Useful when the motion is real but hard to notice frame-to-frame |
| 50-90 | Imperceptibly slow motion, moonrise, tide | Best reserved for locked-off shots with very stable backgrounds |

## Choosing threshold
Rule of thumb: start at 10. If static areas show noise, raise it. If you are missing slow motion, lower it. Typical range: 5-25.

## Trail length and algorithm interaction
In Posy mode, longer trails show a smooth color fade because each trail frame retains its deviation-from-128 value and the accumulator picks the maximum deviation per channel.

In Raw Diff mode, trails simply persist the brightest motion seen - they do not encode direction or age.

## RGB spread and motion direction
Spread=0: colors are determined only by which channels changed most.

Spread=2: red leads, blue trails. Motion toward the camera tends to read warmer, while motion away often reads cooler. This is approximate and depends on scene color.

Spread=4+: strong rainbow smear, more artistic than analytical.
