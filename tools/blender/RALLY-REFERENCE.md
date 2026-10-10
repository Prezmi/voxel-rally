# Rally car reference (measured, 2026-10-10)

Sources: Subaru Impreza WRX STI GDB spec sheet (projectjdm.org), Subaru Impreza WRX STI
(Wikipedia), Mitsubishi Lancer WRC (Wikipedia: length 4360 mm, width 1770–1800 mm, wheelbase
2600 mm). Used as the target envelope for `tools/blender/build_rally_car.py`.

## Real numbers

| Measure | Subaru Impreza WRX STI (GDB) | Mitsubishi Lancer WRC | Our car (target) |
|---|---|---|---|
| Length | 4415 mm | 4360 mm | 4400 mm (44 blocks) |
| Width (body) | 1740 mm | 1770–1800 mm | 1760 mm body, 1860 mm with mirrors |
| Height | 1425 mm | ~1420 mm | 1430 mm (14 blocks) |
| Wheelbase | 2525 mm | 2600 mm | 2620 mm (game physics, fixed) |
| Track | 1485 mm | ~1550 mm rally | 1520 mm + 60 mm widebody |
| Ground clearance | 130–155 mm | ~150 mm rally | 140 mm (floor bottom) |
| Tyre diameter | ~680 mm rally | ~680 mm rally | 670 mm (R = 0.335) |

## Silhouette proportions that make it read as a rally hatchback

Derived from the side views of both cars; block = 0.10 m.

- **Greenhouse is the dominant mass.** Window glass runs from x = +0.60 (A-pillar base) to
  x = -1.20 (C-pillar), about 1.8 m = 18 blocks = 41 % of the length. A long nose with a short
  cabin reads as a saloon and is the current failure.
- **Windows are tall, not a slit.** Sill (beltline) at z = 0.92, roof at z = 1.42, so the glass
  band is **0.40–0.45 m = 4 blocks tall**, with painted pillars 1–2 blocks wide between them.
  One-block glazing looks like a van slot.
- **Overhangs are short and equal.** Front axle to nose 0.90 m, rear axle to tail 0.90 m.
- **Bonnet top at z = 1.00**, cowl at x = +0.55, so the bonnet is a 1.1 m shelf, not a 1.8 m runway.
- **Floor / rocker at z = 0.14–0.24**, so the car sits low; wheels must fill the arch with no
  gap above the tyre.
- **Arch gap is open.** Wheel opening about 0.86 m wide by 0.74 m tall with the flare protruding
  0.06 m past the flank; you can see through the arch from the side.
- **Wheels**: tyre 0.67 m diameter, 0.26–0.30 m wide, near-black rubber ring at least 0.20 m
  thick on the visible face, bright alloy disc inside it roughly 0.42 m across, five clearly
  separated spokes, small bright hub nut. Track 1.58 m with the tyre face outboard of the flank.
- **Wing**: span 1.60 m, chord 0.30 m, plate 0.06 m thick, carried 1.25–1.35 m above ground on
  two visible struts, sitting over the boot lid, not floating.
- **Roof lamp bar**: one continuous rail 1.1 m long at z = 1.46 with four lamps touching it.
- **Snorkel**: welded to the left flank and bonnet, rising from the bonnet shelf at x = +0.75
  to the A-pillar at x = +0.55, no floating steps.
- **Front fascia**: an actual grille opening (dark recess) between the lamps plus a splitter.
- **Rear**: diffuser with visible vertical fins, mudflaps hanging behind the rear wheels.
- **Livery**: large white panels on doors and bonnet against red paint, clearly split, plus a
  number on the door panel.
